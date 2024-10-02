let conversionInProgress = false;

browser.contextMenus.create({
  id: "convert-to-png",
  title: "Convert to True PNG",
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
    
    browser.tabs.sendMessage(tab.id, {
      action: "convertToPng",
      imageUrl: imageUrl
    }).then(response => {
      conversionInProgress = false;
      console.log("PNG Data:", response.pngData);
        
      if (response && response.pngData) {
        // Limpiar la notificación anterior
        browser.notifications.clear("conversion-start");
        
        browser.downloads.download({
          url: response.pngData,
          filename: `${nameWithoutExtension}_converted.png`,
          saveAs: true
        }).then(() => {
          browser.notifications.create("conversion-complete", {
            type: "basic",
            title: "Conversión Exitosa",
            message: "La imagen ha sido convertida y guardada como PNG",
            iconUrl: browser.runtime.getURL("icons/icon-48.png")
          });
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