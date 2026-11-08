"use strict";

const ICON_URL = browser.runtime.getURL("icons/icon-48.png");

// Tipo elegido por el usuario -> MIME real que entiende el codificador del navegador.
// "image/jpg" NO es un MIME válido: el canvas lo ignora y devuelve PNG en silencio.
const MIME_TYPES = {
    png: "image/png",
    jpg: "image/jpeg",
    webp: "image/webp"
};

const CONVERT_TIMEOUT_MS = 30000;
// Margen durante el cual se conserva el blobURL de una descarga fallida
// para que el botón "Reintentar" del gestor de descargas siga funcionando.
const BLOB_URL_TTL_MS = 15 * 60 * 1000;

// downloadId -> { blobUrl, filename, fileType, timeoutId }
const pendingDownloads = new Map();

let conversionInProgress = false;

const DOWNLOAD_ERRORS = {
    FILE_FAILED: "No se pudo guardar el archivo (ruta o permisos no válidos).",
    FILE_ACCESS_DENIED: "Acceso denegado a la carpeta de destino.",
    FILE_NO_SPACE: "No hay espacio suficiente en el disco.",
    FILE_NAME_TOO_LONG: "El nombre del archivo es demasiado largo.",
    FILE_TOO_LARGE: "El archivo es demasiado grande.",
    NETWORK_FAILED: "Error de red durante la descarga.",
    NETWORK_TIMEOUT: "La descarga superó el tiempo máximo.",
    SERVER_BAD_CONTENT: "El contenido recibido no es válido.",
    USER_CANCELED: "La descarga fue cancelada.",
    USER_SHUTDOWN: "Firefox se cerró durante la descarga.",
    CRASH: "La descarga se interrumpió por un fallo inesperado."
};

// Crea la notificación sin dejar promesas rechazadas sin manejar.
function notify(id, title, message) {
    return browser.notifications.create(id, {
        type: "basic",
        title: title,
        message: message,
        iconUrl: ICON_URL
    }).catch(() => {});
}

function clearNotification(id) {
    return browser.notifications.clear(id).catch(() => {});
}

// Función para crear o actualizar el menú contextual
function createOrUpdateContextMenu() {
    browser.storage.local.get('defaultFileType').then(result => {
        const defaultFileType = result.defaultFileType || 'png';
        const title = `Save as ${defaultFileType.toUpperCase()}`;

        // Eliminar el menú contextual existente si existe
        browser.contextMenus.removeAll().then(() => {
            browser.contextMenus.create({
                id: "convert-to-image",
                title: title,
                contexts: ["image"]
            });
        });
    });
}

// Crear el menú contextual al cargar la extensión
createOrUpdateContextMenu();

// Escuchar cambios en el almacenamiento para actualizar el menú contextual cuando cambie el tipo de archivo
browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.defaultFileType) {
        createOrUpdateContextMenu();
    }
});

function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("El navegador no pudo decodificar la imagen"));
        img.src = src;
    });
}

function canvasToBlob(canvas, mimeType, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if (blob) {
                resolve(blob);
            } else {
                reject(new Error(`No se pudo generar el archivo ${mimeType}`));
            }
        }, mimeType, quality);
    });
}

// Los blob: URL pertenecen al sitio que los creó: el background no puede leerlos.
function isBlobUrl(url) {
    try {
        return new URL(url).protocol === "blob:";
    } catch (e) {
        return false;
    }
}

// Descarga la imagen desde el background (tiene el permiso <all_urls>, por lo que
// no está limitado por CORS) y la re-codifica con canvas.
async function convertInBackground(imageUrl, mimeType) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONVERT_TIMEOUT_MS);
    let sourceBlob;

    try {
        const response = await fetch(imageUrl, {
            credentials: "include",
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`El servidor respondió HTTP ${response.status}`);
        }

        sourceBlob = await response.blob();
    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error("La descarga de la imagen tardó demasiado");
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }

    if (!sourceBlob || sourceBlob.size === 0) {
        throw new Error("La imagen está vacía");
    }

    if (sourceBlob.type && !sourceBlob.type.startsWith("image/")) {
        throw new Error(`El servidor devolvió "${sourceBlob.type}", no una imagen`);
    }

    const objectUrl = URL.createObjectURL(sourceBlob);

    try {
        const img = await withTimeout(
            loadImage(objectUrl),
            CONVERT_TIMEOUT_MS,
            "La decodificación de la imagen tardó demasiado"
        );

        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;

        if (!width || !height) {
            throw new Error("La imagen no tiene dimensiones válidas");
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        // Firefox ignora/limita las dimensiones por encima de su máximo de canvas.
        if (canvas.width !== width || canvas.height !== height) {
            throw new Error(`La imagen es demasiado grande (${width}×${height})`);
        }

        const ctx = canvas.getContext("2d");
        if (!ctx) {
            throw new Error("No se pudo crear el contexto de canvas");
        }

        // JPEG no tiene canal alfa: sin fondo blanco la transparencia sale negra.
        if (mimeType === "image/jpeg") {
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, width, height);
        }

        ctx.drawImage(img, 0, 0, width, height);

        const quality = mimeType === "image/png" ? undefined : 0.92;
        const result = await canvasToBlob(canvas, mimeType, quality);

        // Comprobación clave: si el navegador no soporta el MIME solicitado,
        // canvas.toBlob devuelve PNG en silencio (el bug del "solo renombrar").
        if (result.type !== mimeType) {
            throw new Error(
                `El navegador no puede generar ${mimeType} (generó ${result.type || "un formato desconocido"})`
            );
        }

        return result;
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

// Respaldo: pide al content script que convierta la imagen dentro de la propia
// página, donde sí es accesible (blob:, sesión, protección de hotlink...).
async function convertInPage(imageUrl, fileType, tab, frameId) {
    const mimeType = MIME_TYPES[fileType];

    if (!tab || tab.id === undefined) {
        throw new Error("No se puede acceder a la imagen desde la pestaña actual");
    }

    const options = frameId === undefined ? {} : { frameId: frameId };
    let response;

    try {
        response = await withTimeout(
            browser.tabs.sendMessage(tab.id, {
                action: "convertToImage",
                imageUrl: imageUrl,
                fileType: fileType
            }, options),
            CONVERT_TIMEOUT_MS,
            "La conversión dentro de la página tardó demasiado"
        );
    } catch (error) {
        const message = (error && error.message) || "";

        // El content script no está inyectado (pestaña abierta antes de
        // instalar, página restringida o frame sin permisos).
        if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
            throw new Error("No se pudo acceder a la imagen desde la página. Recarga la pestaña e inténtalo de nuevo.");
        }

        throw error;
    }

    if (!response) {
        throw new Error("La página no respondió a la conversión");
    }

    if (response.error) {
        throw new Error(response.error);
    }

    if (!response.imageData) {
        throw new Error("La página no devolvió la imagen convertida");
    }

    const prefix = /^data:([^;,]+);base64,/i.exec(response.imageData);
    if (!prefix) {
        throw new Error("La página devolvió un formato de imagen no válido");
    }

    if (prefix[1].toLowerCase() !== mimeType) {
        throw new Error(`El navegador no puede generar ${mimeType} (generó ${prefix[1]})`);
    }

    const blob = await (await fetch(response.imageData)).blob();

    if (blob.type !== mimeType) {
        throw new Error(`El navegador no puede generar ${mimeType} (generó ${blob.type || "un formato desconocido"})`);
    }

    return blob;
}

async function convertImage(imageUrl, fileType, tab, frameId) {
    const mimeType = MIME_TYPES[fileType];

    if (!mimeType) {
        throw new Error(`Tipo de archivo no soportado: ${fileType}`);
    }

    if (!imageUrl) {
        throw new Error("No se pudo obtener la URL de la imagen");
    }

    // Los blob: solo existen dentro del sitio que los creó.
    if (isBlobUrl(imageUrl)) {
        return convertInPage(imageUrl, fileType, tab, frameId);
    }

    try {
        return await convertInBackground(imageUrl, mimeType);
    } catch (error) {
        console.warn("Conversión desde el background fallida, se intenta en la página:", error);

        try {
            return await convertInPage(imageUrl, fileType, tab, frameId);
        } catch (pageError) {
            console.warn("La conversión dentro de la página también falló:", pageError);
            throw error;
        }
    }
}

// Genera un nombre de archivo válido para el sistema operativo.
function buildFileName(imageUrl, fileType, tab) {
    let raw = "";

    try {
        const url = new URL(imageUrl);

        // Los data: y blob: no tienen nombre utilizable (el path es el base64/UUID).
        if (url.protocol !== "data:" && url.protocol !== "blob:") {
            raw = url.pathname.split("/").pop() || "";

            try {
                raw = decodeURIComponent(raw);
            } catch (e) {
                // Nombre con escapes inválidos: se usa tal cual.
            }
        }
    } catch (e) {
        // URL no parseable: se usará el título de la pestaña o "image".
    }

    raw = raw.replace(/\.[^./\\]+$/, "");

    if (!raw && tab && tab.title) {
        raw = tab.title;
    }

    raw = raw
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
        .replace(/^\.+/, "")
        .trim();

    if (!raw) {
        raw = "image";
    }

    return `${raw.slice(0, 80)}_converted.${fileType}`;
}

// Libera el blobURL cuando ya no puede hacer falta.
function releaseDownload(downloadId) {
    const entry = pendingDownloads.get(downloadId);
    if (!entry) {
        return null;
    }

    clearTimeout(entry.timeoutId);
    pendingDownloads.delete(downloadId);
    URL.revokeObjectURL(entry.blobUrl);

    return entry;
}

// Red de seguridad: si la descarga sigue en curso al cumplirse el TTL, se
// reprograma; si el usuario borra la entrada, onErased la libera antes.
function scheduleBlobCleanup(downloadId) {
    const timeoutId = setTimeout(async () => {
        const entry = pendingDownloads.get(downloadId);
        if (!entry) {
            return;
        }

        try {
            const items = await browser.downloads.search({ id: downloadId });
            const item = items && items[0];

            if (item && item.state === "in_progress") {
                scheduleBlobCleanup(downloadId);
                return;
            }
        } catch (e) {
            // Si no se puede comprobar, se libera igualmente.
        }

        releaseDownload(downloadId);
    }, BLOB_URL_TTL_MS);

    const entry = pendingDownloads.get(downloadId);
    if (entry) {
        entry.timeoutId = timeoutId;
    }
}

function handleDownloadEnd(downloadId, state, errorCode) {
    const entry = pendingDownloads.get(downloadId);
    if (!entry) {
        return;
    }

    if (state === "complete") {
        // Descarga terminada: ya se puede liberar el blob.
        releaseDownload(downloadId);

        notify(
            "conversion-complete",
            "Conversión Exitosa",
            `La imagen ha sido convertida y guardada como ${entry.fileType.toUpperCase()}`
        );
        return;
    }

    if (state === "interrupted") {
        // El blob se conserva A PROPÓSITO para que "Reintentar" funcione.
        const detail = DOWNLOAD_ERRORS[errorCode] || (errorCode ? `Código: ${errorCode}` : "Error desconocido.");

        notify(
            "conversion-error",
            "Error en la descarga",
            `No se pudo guardar la imagen. ${detail}`
        );
    }
}

async function startDownload(blob, filename, fileType) {
    const blobUrl = URL.createObjectURL(blob);
    let downloadId;

    try {
        downloadId = await browser.downloads.download({
            url: blobUrl,
            filename: filename,
            saveAs: true,
            conflictAction: "uniquify"
        });
    } catch (error) {
        URL.revokeObjectURL(blobUrl);

        const message = error && error.message ? error.message : String(error);
        const canceled = /cancel/i.test(message);

        if (canceled) {
            const canceledError = new Error("La descarga fue cancelada.");
            canceledError.silent = true;
            throw canceledError;
        }

        throw new Error(`No se pudo iniciar la descarga: ${message}`);
    }

    // El blobURL NO se revoca aquí. downloads.download() resuelve cuando la
    // descarga empieza, no cuando termina: revocarlo ahora corta la lectura
    // de los datos y deja inservible el botón "Reintentar" de Firefox.
    pendingDownloads.set(downloadId, {
        blobUrl: blobUrl,
        filename: filename,
        fileType: fileType,
        timeoutId: null
    });

    scheduleBlobCleanup(downloadId);

    // Pequeña carrera: la descarga puede fallar antes de llegar aquí.
    try {
        const items = await browser.downloads.search({ id: downloadId });
        const item = items && items[0];

        if (item && item.state !== "in_progress") {
            handleDownloadEnd(downloadId, item.state, item.error);
        }
    } catch (e) {
        // Sin comprobación: se esperará al evento onChanged.
    }
}

async function downloadConvertedImage(imageUrl, tab, frameId) {
    const stored = await browser.storage.local.get('defaultFileType');
    const requestedType = stored.defaultFileType;
    const fileType = MIME_TYPES[requestedType] ? requestedType : 'png';

    notify("conversion-start", "Convirtiendo imagen", `Iniciando la conversión a ${fileType.toUpperCase()}...`);

    try {
        const blob = await convertImage(imageUrl, fileType, tab, frameId);
        const filename = buildFileName(imageUrl, fileType, tab);

        await startDownload(blob, filename, fileType);
    } finally {
        clearNotification("conversion-start");
    }
}

browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== "convert-to-image") {
        return;
    }

    if (conversionInProgress) {
        notify("conversion-busy", "Conversión en curso", "Espera a que termine la conversión actual.");
        return;
    }

    conversionInProgress = true;

    downloadConvertedImage(info.srcUrl, tab, info.frameId)
        .catch(error => {
            if (error && error.silent) {
                // El usuario canceló el diálogo: no es un error que deba avisarse.
                return;
            }

            console.error("Error en la conversión:", error);
            notify(
                "conversion-error",
                "Error de Conversión",
                error.message || String(error)
            );
        })
        .finally(() => {
            conversionInProgress = false;
        });
});

// Solo aquí se sabe si la descarga terminó realmente.
browser.downloads.onChanged.addListener(delta => {
    if (!delta.state) {
        return;
    }

    handleDownloadEnd(delta.id, delta.state.current, delta.error && delta.error.current);
});

// Si el usuario borra la entrada del gestor de descargas, se libera el blob.
browser.downloads.onErased.addListener(downloadId => {
    releaseDownload(downloadId);
});
