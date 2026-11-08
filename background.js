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
// La consulta del alt/title es local y opcional: si tarda, se ignora.
const IMAGE_INFO_TIMEOUT_MS = 1500;
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

// ---------------------------------------------------------------------------
// Nombre del archivo
// ---------------------------------------------------------------------------

// Nombres que no aportan nada: "image", "photo-2", "foto_1", "latest", etc.
const GENERIC_BASE = /^(image|images|img|foto|fotos|imagen|imagenes|photo|photos|picture|pictures|pic|unnamed|untitled|download|file|asset|media|thumb|thumbnail|cover|banner|hero|default|placeholder|screenshot|capture|output|render|logo|latest|original|full|large|medium|small|current|main|index|new|enlarge|expand|zoom|preview|open image|view image|download image|ver imagen|ampliar imagen|click to enlarge|haz clic para ampliar)[-_ .]?\d*$/i;
// Hashes, UUIDs y tokens de CDN.
const HASH_NAME = /^[0-9a-f]{16,}$/i;
const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_NAME = /^[a-z0-9]{28,}$/i;
// Medidas de CDN: "1200x630".
const SIZE_NAME = /^\d{2,5}\s*[x×]\s*\d{2,5}$/i;
// "photo-1549880338-65ddcdfd017b" (Unsplash y similares).
const GENERIC_PLUS_TOKEN = /^(image|img|photo|foto|picture|pic|thumb|thumbnail)[-_]?\d{4,}/i;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Indica si un nombre merece ser usado tal cual.
function isMeaningfulBase(name) {
    const value = (name || "").trim();

    // En alfabetos no latinos dos caracteres ya son una palabra ("写真");
    // en ASCII, menos de tres suele ser basura ("a", "x2").
    const minLength = /^[\x20-\x7e]+$/.test(value) ? 3 : 2;

    if (value.length < minLength) {
        return false;
    }

    // Debe tener al menos una letra (vale cualquier alfabeto).
    if (!/\p{L}/u.test(value)) {
        return false;
    }

    if (GENERIC_BASE.test(value)) {
        return false;
    }

    if (HASH_NAME.test(value) || UUID_NAME.test(value) || SIZE_NAME.test(value)) {
        return false;
    }

    if (/^\d+$/.test(value)) {
        return false;
    }

    if (TOKEN_NAME.test(value) && /\d/.test(value)) {
        return false;
    }

    if (GENERIC_PLUS_TOKEN.test(value)) {
        return false;
    }

    return true;
}

// Deja el nombre apto para cualquier sistema de archivos.
function sanitizeName(name) {
    let value = (name || "")
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^[.\s]+/, "")
        .replace(/[.\s]+$/, "")
        .trim();

    if (WINDOWS_RESERVED.test(value)) {
        value = `_${value}`;
    }

    return value;
}

// Nombre utilizable que viene en la URL (sin extensión ni sufijos de tamaño).
function nameFromUrl(imageUrl) {
    let raw = "";

    try {
        const url = new URL(imageUrl);

        // Los data: y blob: no tienen nombre utilizable (el path es el base64/UUID).
        if (url.protocol === "data:" || url.protocol === "blob:") {
            return "";
        }

        raw = url.pathname.split("/").pop() || "";

        try {
            raw = decodeURIComponent(raw);
        } catch (e) {
            // Nombre con escapes inválidos: se usa tal cual.
        }
    } catch (e) {
        return "";
    }

    return raw
        .replace(/\.[^./\\]+$/, "")                 // extensión
        .replace(/[-_]\d{2,5}x\d{2,5}$/i, "")       // sufijo de tamaño (WordPress/CDN)
        .trim();
}

// Limpia texto humano (alt, title de la imagen o título de la pestaña):
// los separadores y el nombre del sitio son ruido, no parte del asunto.
function cleanHumanText(text) {
    let value = (text || "").replace(/\s+/g, " ").trim();

    // "|", "·", "—", "–", "::" casi siempre separan el nombre del sitio.
    const strongSeparator = /\s+(?:\||·|—|–|::)\s+/;
    if (strongSeparator.test(value)) {
        const first = value.split(strongSeparator)[0].trim();
        if (first.length >= 4) {
            value = first;
        }
    }

    // Un guion simple solo se recorta si el sufijo final es corto ("Artículo - Wikipedia").
    const dash = /\s+-\s+(.{1,30})$/.exec(value);
    if (dash) {
        const prefix = value.slice(0, dash.index).trim();
        if (prefix.length >= 4) {
            value = prefix;
        }
    }

    return value;
}

function domainFromUrl(url) {
    try {
        const hostname = new URL(url).hostname;
        return hostname ? hostname.replace(/^www\./i, "") : "";
    } catch (e) {
        return "";
    }
}

// Cascada: alt -> URL -> title -> título de pestaña -> dominio -> "imagen".
// El alt va primero porque suele describir el asunto ("Yotsuba Nakano")
// mientras que la URL suele ser una ruta genérica ("latest", hashes, ids).
function buildFileName(imageUrl, fileType, tab, imageInfo) {
    const info = imageInfo || {};
    const pageUrl = (tab && tab.url) || "";

    const candidates = [
        cleanHumanText(info.alt),
        nameFromUrl(imageUrl),
        cleanHumanText(info.title),
        cleanHumanText(tab && tab.title),
        domainFromUrl(imageUrl) || domainFromUrl(pageUrl)
    ];

    let base = "";

    for (const candidate of candidates) {
        const cleaned = sanitizeName(candidate);

        if (cleaned && isMeaningfulBase(cleaned)) {
            base = cleaned;
            break;
        }
    }

    if (!base) {
        base = "imagen";
    }

    base = sanitizeName(base.slice(0, 80)) || "imagen";

    return `${base}.${fileType}`;
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

async function startDownload(blob, filename, fileType, askWhereToSave) {
    const blobUrl = URL.createObjectURL(blob);
    let downloadId;

    try {
        downloadId = await browser.downloads.download({
            url: blobUrl,
            filename: filename,
            saveAs: askWhereToSave === true,
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

// Pide al content script el alt/title del <img> clicado, para usarlo como nombre.
// Nunca lanza: si la página no responde, el nombre se resuelve con otras fuentes.
async function getImageInfo(tab, frameId, imageUrl) {
    if (!tab || tab.id === undefined) {
        return null;
    }

    const options = frameId === undefined ? {} : { frameId: frameId };

    try {
        const response = await withTimeout(
            browser.tabs.sendMessage(tab.id, {
                action: "getImageInfo",
                imageUrl: imageUrl
            }, options),
            IMAGE_INFO_TIMEOUT_MS,
            "Tiempo de espera agotado"
        );

        return response || null;
    } catch (e) {
        return null;
    }
}

async function downloadConvertedImage(imageUrl, tab, frameId) {
    const stored = await browser.storage.local.get(['defaultFileType', 'askWhereToSave']);
    const requestedType = stored.defaultFileType;
    const fileType = MIME_TYPES[requestedType] ? requestedType : 'png';
    // Por defecto no se pregunta: evita cancelaciones y descargas fallidas.
    const askWhereToSave = stored.askWhereToSave === true;

    notify("conversion-start", "Convirtiendo imagen", `Iniciando la conversión a ${fileType.toUpperCase()}...`);

    // En paralelo con la conversión: cuando el blob esté listo, el alt ya llegó.
    const infoPromise = getImageInfo(tab, frameId, imageUrl);

    try {
        const blob = await convertImage(imageUrl, fileType, tab, frameId);
        const imageInfo = await infoPromise;
        const filename = buildFileName(imageUrl, fileType, tab, imageInfo);

        await startDownload(blob, filename, fileType, askWhereToSave);
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
