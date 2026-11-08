"use strict";

// Content script de RESPALDO.
// El background convierte por defecto (sin CORS). Este script solo entra en
// acción cuando la imagen no es accesible desde la extensión: blob: URL creadas
// por el sitio, imágenes detrás de cookies/Referer, etc.

const MIME_TYPES = {
    png: "image/png",
    jpg: "image/jpeg",
    webp: "image/webp"
};

const LOAD_TIMEOUT_MS = 20000;

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            reject(new Error("La imagen tardó demasiado en cargar"));
        }, LOAD_TIMEOUT_MS);

        img.onload = () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(img);
        };

        img.onerror = () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            reject(new Error("No se pudo cargar la imagen desde la página"));
        };

        // Sin crossOrigin a propósito: los blob: y las imágenes del mismo
        // origen no lo necesitan, y activarlo haría fallar su carga.
        img.src = src;
    });
}

function encodeImage(img, mimeType) {
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;

    if (!width || !height) {
        throw new Error("La imagen no tiene dimensiones válidas");
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

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

    let dataUrl;
    try {
        dataUrl = canvas.toDataURL(mimeType, 0.92);
    } catch (error) {
        // SecurityError: la imagen no expone CORS y el canvas queda "tainted".
        throw new Error("La imagen está protegida y no se puede leer desde la página");
    }

    const prefix = /^data:([^;,]+);base64,/i.exec(dataUrl);
    if (!prefix) {
        throw new Error("El navegador no devolvió una imagen válida");
    }

    if (prefix[1].toLowerCase() !== mimeType) {
        throw new Error(`El navegador no puede generar ${mimeType} (generó ${prefix[1]})`);
    }

    return { imageData: dataUrl, mimeType: mimeType };
}

async function convertInPage(imageUrl, fileType) {
    const mimeType = MIME_TYPES[fileType];

    if (!mimeType) {
        throw new Error(`Tipo de archivo no soportado: ${fileType}`);
    }

    if (!imageUrl) {
        throw new Error("No se pudo obtener la URL de la imagen");
    }

    const img = await loadImage(imageUrl);
    return encodeImage(img, mimeType);
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.action !== "convertToImage") {
        return;
    }

    convertInPage(message.imageUrl, message.fileType)
        .then(result => sendResponse(result))
        .catch(error => {
            console.error("Error en la conversión dentro de la página:", error);
            sendResponse({ error: error.message });
        });

    // Indica que sendResponse se llamará de forma asíncrona.
    return true;
});
