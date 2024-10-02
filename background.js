let conversionInProgress = false;

browser.contextMenus.create({
    id: "convert-to-png",
    title: "Convert to PNG",
    contexts: ["image"]
});

browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "convert-to-png" && !conversionInProgress) {
        conversionInProgress = true;
        const imageUrl = info.srcUrl;

        let originalFileName = imageUrl.split('/').pop().split('?')[0];
        let nameWithoutExtension = originalFileName.replace(/\.[^/.]+$/, "") || "image";

        // Mostrar notificación de inicio
        browser.notifications.create("conversion-start", {
            type: "basic",
            title: "Convirtiendo imagen",
            message: "Iniciando la conversión a PNG...",
            iconUrl: browser.runtime.getURL("icons/icon-48.png")
        });

        function dataURLtoBlob(dataurl) {
            const arr = dataurl.split(',');
            const mime = arr[0].match(/:(.*?);/)[1];
            const bstr = atob(arr[1]);
            let n = bstr.length;
            const u8arr = new Uint8Array(n);
            while (n--) {
                u8arr[n] = bstr.charCodeAt(n);
            }
            return new Blob([u8arr], { type: mime });
        }

        browser.tabs.sendMessage(tab.id, {
            action: "convertToPng",
            imageUrl: imageUrl
        }).then(response => {
            conversionInProgress = false;
            if (response && response.pngData) {
                // Limpiar la notificación anterior
                browser.notifications.clear("conversion-start");

                // Convertir el data URL a Blob
                const blob = dataURLtoBlob(response.pngData);
                const url = URL.createObjectURL(blob);

                browser.downloads.download({
                    url: url,
                    filename: `${nameWithoutExtension}_converted.png`,
                    saveAs: true
                }).then(() => {
                    // Crear la notificación de conversión exitosa
                    browser.notifications.create("conversion-complete", {
                        type: "basic",
                        title: "Conversión Exitosa",
                        message: "La imagen ha sido convertida y guardada como PNG",
                        iconUrl: browser.runtime.getURL("icons/icon-48.png")
                    });

                    // Liberar el objeto URL temporal
                    URL.revokeObjectURL(url);
                });
            }
        }).catch(error => {
            conversionInProgress = false;
            console.error("Error en la conversión:", error);
            browser.notifications.create("conversion-error", {
                type: "basic",
                title: "Error de Conversión",
                message: "No se pudo convertir la imagen. " + error.message,
                iconUrl: browser.runtime.getURL("icons/icon-48.png")
            });
        });
    }
});