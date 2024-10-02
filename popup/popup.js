document.addEventListener('DOMContentLoaded', function () {
    // Contador de clics
    let clickCount = 0;
    const clickButton = document.getElementById('clickButton');
    const clickCountDisplay = document.getElementById('clickCount');

    clickButton.addEventListener('click', function () {
        clickCount++;
        clickCountDisplay.textContent = clickCount;
        browser.storage.local.set({ clickCount: clickCount });
    });

    // Cargar el conteo guardado
    browser.storage.local.get('clickCount').then(result => {
        if (result.clickCount) {
            clickCount = result.clickCount;
            clickCountDisplay.textContent = clickCount;
        }
    });

    // Cambiar color
    const colorPicker = document.getElementById('colorPicker');
    const changeColorButton = document.getElementById('changeColor');

    changeColorButton.addEventListener('click', function () {
        const color = colorPicker.value;
        browser.tabs.query({ active: true, currentWindow: true })
            .then(tabs => {
                browser.tabs.executeScript(tabs[0].id, {
                    code: `document.body.style.backgroundColor = '${color}';`
                });
            });
    });

    // Obtener información de la página
    const getInfoButton = document.getElementById('getInfo');
    const pageInfoDiv = document.getElementById('pageInfo');

    getInfoButton.addEventListener('click', function () {
        browser.tabs.query({ active: true, currentWindow: true })
            .then(tabs => {
                const currentTab = tabs[0];
                pageInfoDiv.innerHTML = `
            <p><strong>URL:</strong> ${currentTab.url}</p>
            <p><strong>Título:</strong> ${currentTab.title}</p>
          `;
            });
    });
});