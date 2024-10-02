function getCorsUrl(url) {
    return `https://corsproxy.io/?${encodeURIComponent(url)}`;
}

// Función para convertir la imagen a PNG usando canvas
function convertToPng(imageUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";

        img.onload = function () {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;

                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);

                const pngData = canvas.toDataURL('image/png');
                resolve(pngData);
            } catch (error) {
                alert("Error: ", error)
                reject(error);
            }
        };

        img.onerror = function () {
            // Si falla la primera vez, intentar con el proxy CORS
            const proxyUrl = getCorsUrl(imageUrl);

            const imgWithProxy = new Image();
            imgWithProxy.crossOrigin = "Anonymous";

            imgWithProxy.onload = function () {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = imgWithProxy.width;
                    canvas.height = imgWithProxy.height;

                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(imgWithProxy, 0, 0);

                    const pngData = canvas.toDataURL('image/png');
                    resolve(pngData);
                } catch (proxyError) {
                    alert("Error: ", proxyError)
                    reject(proxyError);
                }
            };

            imgWithProxy.onerror = function () {
                alert("Failed to load image even with CORS proxy")
                reject(new Error("Failed to load image even with CORS proxy"));
            };

            imgWithProxy.src = proxyUrl;
        };

        // Primero intentamos sin el proxy
        img.src = imageUrl;
    });
}

// Escuchar mensajes del background script
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "convertToPng") {
        convertToPng(message.imageUrl)
            .then(pngData => sendResponse({ pngData }))
            .catch(error => {
                console.error("Error en la conversión:", error);
                sendResponse({ error: error.message });
            });
        return true;
    }
});
