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
    textarea.value = [
        extractUserProfile(data),
        extractSession(data),
        extractLaps(data),
        extractSplits(data),
    ].filter(Boolean).join('\n\n');
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

function km(val: unknown): string {
    if (typeof val !== 'number') return '–';
    return String(parseFloat((val / 1000).toFixed(3)));
}

export function extractSession(data: FitUploadResponse): string {
    const session = (data.messages['sessionMesgs'] as Record<string, unknown>[])?.[0];
    if (!session) return '';

    const lines: string[] = ['--- Edzés összefoglaló ---'];

    // Időpontok
    if (session['startTime'] instanceof Date) {
        lines.push(`Kezdés:               ${session['startTime'].toLocaleString('hu-HU')}`);
    }
    if (session['timestamp'] instanceof Date) {
        lines.push(`Befejezés:            ${session['timestamp'].toLocaleString('hu-HU')}`);
    }

    // Önértékelés
    if (typeof session['workoutFeel'] === 'number') {
        lines.push(`Közérzet (0–100):      ${session['workoutFeel']}`);
    }

    // Edzésterhelés – mindig megjelenjen, hiány esetén –
    lines.push(`Aerob edzéshatás:      ${typeof session['totalTrainingEffect'] === 'number' ? (session['totalTrainingEffect'] / 10).toFixed(1) + ' / 5.0' : '–'}`);
    lines.push(`Anaerob edzéshatás:    ${typeof session['totalAnaerobicTrainingEffect'] === 'number' ? (session['totalAnaerobicTrainingEffect'] / 10).toFixed(1) + ' / 5.0' : '–'}`);
    if (typeof session['trainingStressScore'] === 'number') {
        lines.push(`Training Stress Score: ${(session['trainingStressScore'] / 10).toFixed(1)}`);
    }
    if (typeof session['intensityFactor'] === 'number') {
        lines.push(`Intenzitás faktor:     ${(session['intensityFactor'] / 1000).toFixed(2)}`);
    }
    lines.push(`Edzésterhelés (peak):  ${typeof session['trainingLoadPeak'] === 'number' ? (session['trainingLoadPeak'] / 65536).toFixed(2) : '–'}`);

    return lines.length > 1 ? lines.join('\n') : '';
}

// Active interval splitType értékek
const ACTIVE_SPLIT_TYPES = new Set([
    'intervalActive', 'intervalWarmup', 'intervalCooldown',
    'intervalRecovery', 'intervalOther', 'runActive', 'ascentSplit',
]);

const SPLIT_TYPE_HU: Record<string, string> = {
    intervalActive:    'Aktív interval',
    intervalRest:      'Pihenő interval',
    intervalWarmup:    'Bemelegítés',
    intervalCooldown:  'Levezető',
    intervalRecovery:  'Felépülés',
    intervalOther:     'Egyéb interval',
    runActive:         'Futás (aktív)',
    runRest:           'Futás (pihenő)',
    ascentSplit:       'Emelkedő',
    descentSplit:      'Süllyedő',
    workoutRound:      'Kör',
    rwdRun:            'Futás',
    rwdWalk:           'Gyaloglás',
    rwdStand:          'Állás',
    rwdCycle:          'Kerékpározás',
    rwdActivity:       'Aktivitás',
};

export function extractSplits(data: FitUploadResponse): string {
    const splits = data.messages['splitMesgs'] as Record<string, unknown>[] | undefined;
    const summaries = data.messages['splitSummaryMesgs'] as Record<string, unknown>[] | undefined;

    if (!splits || splits.length === 0) return '';

    const filtered = splits.filter(s => typeof s['totalElapsedTime'] === 'number' && (s['totalElapsedTime'] as number) >= 1);
    if (filtered.length === 0) return '';

    const header = ['#', 'Típus', 'Táv (km)', 'Idő', 'Pace (min/km)', 'Emelkedés (m)', 'Süllyedés (m)'];

    let activeIdx = 0;
    const rows = filtered.map((split, i) => {
        const type = String(split['splitType'] ?? '');
        const isActive = ACTIVE_SPLIT_TYPES.has(type);
        const label = SPLIT_TYPE_HU[type] ?? type;
        const idx = isActive ? `${++activeIdx}.` : `(${i + 1})`;

        return [
            idx,
            label,
            km(split['totalDistance']),
            typeof split['totalElapsedTime'] === 'number' ? mpsToMinPerKm(
                typeof split['totalDistance'] === 'number' && split['totalElapsedTime'] > 0
                    ? (split['totalDistance'] as number) / (split['totalElapsedTime'] as number)
                    : 0
            ) : '–',
            mpsToMinPerKm(split['avgSpeed']),
            num(split['totalAscent'], 0),
            num(split['totalDescent'], 0),
        ];
    });

    const lines = [
        `--- Intervallumok / splitMesgs (${filtered.length} bejegyzés, ${activeIdx} aktív) ---`,
        header.join(','),
        ...rows.map(r => r.join(',')),
    ];

    // splitSummaryMesgs: tervezett vs teljesített összefoglaló, ha elérhető
    if (summaries && summaries.length > 0) {
        lines.push('');
        lines.push('--- Intervallum összefoglalók (splitSummaryMesgs) ---');
        lines.push('Típus,Darab,Össz táv (km),Össz idő');
        for (const s of summaries) {
            const type = String(s['splitType'] ?? '');
            const label = SPLIT_TYPE_HU[type] ?? type;
            const count = typeof s['numSplits'] === 'number' ? s['numSplits'] : '–';
            const dist = km(s['totalDistance']);
            const time = typeof s['totalTimerTime'] === 'number' ? formatSeconds(s['totalTimerTime'] as number) : '–';
            lines.push(`${label},${count},${dist},${time}`);
        }
    }

    return lines.join('\n');
}

function formatSeconds(secs: number): string {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.round(secs % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
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
        'Max kadencia',
        'Lépéshossz (m)',
        'Vert. osz. (mm)',
        'Talajérintés (ms)',
        'Vert. arány (%)',
    ];

    const rows = laps.map((lap, i) => [
        `${i + 1}.`,
        km(lap['totalDistance']),
        mpsToMinPerKm(lap['avgSpeed']),
        num(lap['totalAscent'], 0),
        num(lap['totalDescent'], 0),
        num(lap['avgRunningCadence'] ?? lap['avgCadence'], 0),
        num(lap['maxRunningCadence'] ?? lap['maxCadence'], 0),
        num(lap['avgStepLength'], 2),
        num(lap['avgVerticalOscillation'], 1),
        num(lap['avgStanceTime'], 0),
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
        `Alvási idő:    ${secondsToHHMM(profile['sleepTime'])}`,
        `Ébredési idő:  ${secondsToHHMM(profile['wakeTime'])}`,
        `Súly:          ${typeof profile['weight'] === 'number' ? profile['weight'] + ' kg' : '–'}`,
        `Magasság:      ${typeof profile['height'] === 'number' ? profile['height'] + ' m' : '–'}`,
    ];

    const session = (data.messages['sessionMesgs'] as Record<string, unknown>[])?.[0];
    if (session?.['startTime'] instanceof Date) {
        lines.push(`Edzés kezdete: ${session['startTime'].toLocaleString('hu-HU')}`);
    }

    return lines.join('\n');
}

function formatValue(val: unknown): string {
    if (val === null || val === undefined) return '–';
    if (val instanceof Date) return val.toLocaleString('hu-HU');
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
}
