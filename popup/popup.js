document.addEventListener('DOMContentLoaded', function () {
    const fileTypeInputs = Array.from(document.querySelectorAll('input[name="fileType"]'));
    const askWhereToSaveCheckbox = document.getElementById('askWhereToSave');
    const versionKicker = document.getElementById('versionKicker');

    // La versión sale del manifiesto: la UI nunca se queda desfasada.
    if (versionKicker) {
        const version = browser.runtime.getManifest().version;
        versionKicker.textContent = `Firefox · v${version}`;
    }

    // Cargar las preferencias guardadas (si existen)
    browser.storage.local.get(['defaultFileType', 'askWhereToSave']).then(result => {
        const storedType = result.defaultFileType || 'png';
        const selected = fileTypeInputs.find(input => input.value === storedType) || fileTypeInputs[0];

        if (selected) {
            selected.checked = true;
        }

        // Por defecto no se pregunta: la descarga va directa a Descargas.
        askWhereToSaveCheckbox.checked = result.askWhereToSave === true;
    });

    // Cambio de formato
    for (const input of fileTypeInputs) {
        input.addEventListener('change', () => {
            if (input.checked) {
                browser.storage.local.set({ defaultFileType: input.value });
            }
        });
    }

    // Cambio de "preguntar dónde guardar"
    askWhereToSaveCheckbox.addEventListener('change', () => {
        browser.storage.local.set({ askWhereToSave: askWhereToSaveCheckbox.checked });
    });
});
