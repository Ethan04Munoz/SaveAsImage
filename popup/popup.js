document.addEventListener('DOMContentLoaded', function () {
    // Obtener el elemento select
    const fileTypeSelect = document.getElementById('fileTypeSelect');

    // Cargar la preferencia guardada (si existe)
    browser.storage.local.get('defaultFileType').then(result => {
        if (result.defaultFileType) {
            fileTypeSelect.value = result.defaultFileType;
        }
    });

    // Manejar el cambio de selección
    fileTypeSelect.addEventListener('change', function () {
        const selectedFileType = fileTypeSelect.value;
        console.log('Tipo de archivo seleccionado:', selectedFileType);

        // Guardar la preferencia seleccionada
        browser.storage.local.set({ defaultFileType: selectedFileType });
    });

});