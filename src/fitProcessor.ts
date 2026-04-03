import { FitUploadResponse, buildTextOutput, formatValue, extractSession, extractLaps, extractSplits, extractUserProfile } from './fitExtractor';

export type { FitUploadResponse };
export { buildTextOutput, extractSession, extractLaps, extractSplits, extractUserProfile };

export async function uploadFitFile(file: File): Promise<FitUploadResponse> {
    const buffer = await file.arrayBuffer();

    const response = await fetch('/api/fit-upload', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/octet-stream',
        },
        body: buffer,
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(err.error ?? `HTTP ${response.status}`);
    }

    return response.json();
}

export function renderFitData(data: FitUploadResponse, container: HTMLElement): void {
    container.innerHTML = '';

    if (data.errors.length > 0) {
        const errBox = document.createElement('div');
        errBox.className = 'fit-errors';
        errBox.innerHTML = `<strong>Dekódolási hibák:</strong><ul>${data.errors.map(e => `<li>${e}</li>`).join('')}</ul>`;
        container.appendChild(errBox);
    }

    const messageTypes = Object.keys(data.messages);
    if (messageTypes.length === 0) {
        container.innerHTML += '<p>Nincs dekódolható adat.</p>';
        return;
    }

    // Összefoglaló kártya
    const summary = document.createElement('div');
    summary.className = 'fit-summary';
    summary.innerHTML = `
        <h2>Feldolgozott üzenetek</h2>
        <p>Típusok száma: <strong>${messageTypes.length}</strong></p>
        ${data.activityId ? `<p>Aktivitás ID: <strong>${data.activityId}</strong></p>` : ''}
    `;
    container.appendChild(summary);

    // Nyers szöveg összefoglaló textarea
    const mergeLabel = document.createElement('label');
    mergeLabel.className = 'fit-merge-label';
    const mergeCheckbox = document.createElement('input');
    mergeCheckbox.type = 'checkbox';
    mergeCheckbox.checked = false;
    mergeLabel.appendChild(mergeCheckbox);
    mergeLabel.append(' Rövid gyaloglás összevonása állássá');
    container.appendChild(mergeLabel);

    const textarea = document.createElement('textarea');
    textarea.className = 'fit-raw';
    textarea.readOnly = true;
    textarea.rows = 10;

    const updateTextarea = () => {
        textarea.value = buildTextOutput(data, mergeCheckbox.checked);
    };
    updateTextarea();
    mergeCheckbox.addEventListener('change', updateTextarea);
    container.appendChild(textarea);

    // Üzenet típusonként összecsukható szekció
    for (const type of messageTypes) {
        const records = data.messages[type] as Record<string, unknown>[];
        const section = document.createElement('details');
        section.className = 'fit-section';
        section.innerHTML = `<summary>${type} <span class="fit-count">(${records.length} rekord)</span></summary>`;

        const table = document.createElement('table');
        table.className = 'fit-table';

        // Fejléc az első rekord kulcsaiból
        const keys = Object.keys(records[0] ?? {});
        table.innerHTML = `<thead><tr>${keys.map(k => `<th>${k}</th>`).join('')}</tr></thead>`;

        const tbody = document.createElement('tbody');
        // Max 50 sor megjelenítése teljesítmény miatt
        const visible = records.slice(0, 50);
        for (const row of visible) {
            const tr = document.createElement('tr');
            tr.innerHTML = keys.map(k => `<td>${formatValue(row[k])}</td>`).join('');
            tbody.appendChild(tr);
        }
        if (records.length > 50) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="${keys.length}" class="fit-more">… és még ${records.length - 50} rekord</td>`;
            tbody.appendChild(tr);
        }

        table.appendChild(tbody);
        section.appendChild(table);
        container.appendChild(section);
    }
}

