let conversionInProgress = false;

// Función para crear o actualizar el menú contextual
function createOrUpdateContextMenu() {
    browser.storage.local.get('defaultFileType').then(result => {
        const defaultFileType = result.defaultFileType || 'png';
        const title = `Convert to ${defaultFileType.toUpperCase()}`;

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

browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "convert-to-image" && !conversionInProgress) {
        conversionInProgress = true;
        const imageUrl = info.srcUrl;

        let originalFileName = imageUrl.split('/').pop().split('?')[0];
        let nameWithoutExtension = originalFileName.replace(/\.[^/.]+$/, "") || "image";

        // Obtener el tipo de archivo predeterminado
        browser.storage.local.get('defaultFileType').then(result => {
            const defaultFileType = result.defaultFileType || 'png';

            // Mostrar notificación de inicio
            browser.notifications.create("conversion-start", {
                type: "basic",
                title: "Convirtiendo imagen",
                message: `Iniciando la conversión a ${defaultFileType.toUpperCase()}...`,
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

            // Enviar mensaje al content script con el tipo de archivo deseado
            browser.tabs.sendMessage(tab.id, {
                action: "convertToImage",
                imageUrl: imageUrl,
                fileType: defaultFileType
            }).then(response => {
                conversionInProgress = false;
                if (response && response.imageData) {
                    // Limpiar la notificación anterior
                    browser.notifications.clear("conversion-start");

                    // Convertir el data URL a Blob
                    const blob = dataURLtoBlob(response.imageData);
                    const url = URL.createObjectURL(blob);

                    browser.downloads.download({
                        url: url,
                        filename: `${nameWithoutExtension}_converted.${defaultFileType}`,
                        saveAs: true
                    }).then(() => {
                        // Crear la notificación de conversión exitosa
                        browser.notifications.create("conversion-complete", {
                            type: "basic",
                            title: "Conversión Exitosa",
                            message: `La imagen ha sido convertida y guardada como ${defaultFileType.toUpperCase()}`,
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
        });
    }
});
