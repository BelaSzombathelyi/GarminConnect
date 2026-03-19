export interface FitUploadResponse {
    activityId: string | null;
    messages: Record<string, unknown[]>;
    errors: string[];
}

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
    const textarea = document.createElement('textarea');
    textarea.className = 'fit-raw';
    textarea.readOnly = true;
    textarea.rows = 10;
    textarea.value = extractUserProfile(data) + '\n\n' + extractLaps(data);
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

function secondsToHHMM(seconds: unknown): string {
    if (typeof seconds !== 'number') return '–';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function mpsToMinPerKm(speed: unknown): string {
    if (typeof speed !== 'number' || speed <= 0) return '–';
    const secPerKm = 1000 / speed;
    const mins = Math.floor(secPerKm / 60);
    const secs = Math.round(secPerKm % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

function num(val: unknown, decimals = 1): string {
    if (typeof val !== 'number') return '–';
    return val.toFixed(decimals);
}

export function extractLaps(data: FitUploadResponse): string {
    const laps = data.messages['lapMesgs'] as Record<string, unknown>[] | undefined;
    if (!laps || laps.length === 0) return '';

    const header = [
        '#',
        'Táv (km)',
        'Pace (min/km)',
        'Emelkedés (m)',
        'Süllyedés (m)',
        'Kadencia (lép/p)',
        'Lépéshossz (m)',
        'Vert. osz. (mm)',
        'Talajérintés (ms)',
        'Vert. arány (%)',
    ];

    const rows = laps.map((lap, i) => [
        `${i + 1}.`,
        typeof lap['totalDistance'] === 'number' ? num(lap['totalDistance'] / 1000, 3) : '–',
        mpsToMinPerKm(lap['avgSpeed']),
        num(lap['totalAscent'], 0),
        num(lap['totalDescent'], 0),
        num(lap['avgRunCadence'] ?? lap['avgCadence'], 0),
        num(lap['avgStrideLength'], 2),
        num(lap['avgVerticalOscillation'], 1),
        num(lap['avgGroundContactTime'], 0),
        num(lap['avgVerticalRatio'], 1),
    ]);

    const lines = [
        `körök (nem feltétlenül egységes km-ek) (összesen ${laps.length} kör)`,
        header.join(','),
        ...rows.map(r => r.join(',')),
    ];
    return lines.join('\n');
}

export function extractUserProfile(data: FitUploadResponse): string {
    const profile = (data.messages['userProfileMesgs'] as Record<string, unknown>[])?.[0];
    if (!profile) return '(nincs userProfileMesgs adat)';

    const lines = [
        `Ébredési idő:  ${secondsToHHMM(profile['wakeTime'])}`,
        `Alvási idő:    ${secondsToHHMM(profile['sleepTime'])}`,
        `Súly:          ${typeof profile['weight'] === 'number' ? profile['weight'] + ' kg' : '–'}`,
        `Magasság:      ${typeof profile['height'] === 'number' ? profile['height'] + ' m' : '–'}`,
    ];
    return lines.join('\n');
}

function formatValue(val: unknown): string {
    if (val === null || val === undefined) return '–';
    if (val instanceof Date) return val.toLocaleString('hu-HU');
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
}
