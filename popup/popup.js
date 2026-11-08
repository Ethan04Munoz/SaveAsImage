document.addEventListener('DOMContentLoaded', function () {
    const fileTypeSelect = document.getElementById('fileTypeSelect');
    const askWhereToSaveCheckbox = document.getElementById('askWhereToSave');

    // Cargar las preferencias guardadas (si existen)
    browser.storage.local.get(['defaultFileType', 'askWhereToSave']).then(result => {
        if (result.defaultFileType) {
            fileTypeSelect.value = result.defaultFileType;
        }

        // Por defecto no se pregunta: la descarga va directa a Descargas.
        askWhereToSaveCheckbox.checked = result.askWhereToSave === true;
    });

    // Manejar el cambio de tipo de archivo
    fileTypeSelect.addEventListener('change', function () {
        const selectedFileType = fileTypeSelect.value;
        console.log('Tipo de archivo seleccionado:', selectedFileType);

        browser.storage.local.set({ defaultFileType: selectedFileType });
    });

    // Manejar el cambio de "preguntar dónde guardar"
    askWhereToSaveCheckbox.addEventListener('change', function () {
        const askWhereToSave = askWhereToSaveCheckbox.checked;
        console.log('Preguntar dónde guardar:', askWhereToSave);

        browser.storage.local.set({ askWhereToSave: askWhereToSave });
    });
});
