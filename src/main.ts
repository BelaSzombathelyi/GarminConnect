import { uploadFitFile, renderFitData } from './fitProcessor';

const appEl = document.querySelector<HTMLDivElement>('#app')!;

appEl.innerHTML = `
  <h1>GarminConnect FIT feldolgozó</h1>

  <section class="upload-section">
    <h2>Kézi feltöltés</h2>
    <p>Válassz ki egy <code>.fit</code> vagy <code>.zip</code> fájlt a helyi gépedről:</p>
    <label class="upload-label">
      <input type="file" id="fit-input" accept=".fit,.zip" />
      <span>FIT / ZIP fájl kiválasztása</span>
    </label>
    <div id="upload-status"></div>
  </section>

  <section>
    <p class="auto-note">A Tampermonkey szkript automatikusan is ide küldi a letöltött FIT adatot.</p>
    <div id="output"></div>
  </section>
`;

const fileInput = document.querySelector<HTMLInputElement>('#fit-input')!;
const statusEl = document.querySelector<HTMLDivElement>('#upload-status')!;
const outputEl = document.querySelector<HTMLDivElement>('#output')!;

fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    statusEl.textContent = `Feldolgozás: ${file.name}…`;
    outputEl.innerHTML = '';

    try {
        const data = await uploadFitFile(file);
        statusEl.textContent = `Kész: ${file.name}`;
        renderFitData(data, outputEl);
    } catch (err) {
        statusEl.textContent = `Hiba: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Input reset – ugyanazt a fájlt újra ki lehessen választani
    fileInput.value = '';
});

fetch('/api/ping');

