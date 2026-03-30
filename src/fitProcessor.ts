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
        textarea.value = [
            extractUserProfile(data),
            extractSession(data),
            extractLaps(data),
            extractSplits(data, mergeCheckbox.checked),
        ].filter(Boolean).join('\n\n');
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

// A FIT strides/min értéket steps/min-re alakítja (×2)
function cadence(val: unknown): string {
    if (typeof val !== 'number') return '–';
    return String(Math.round(val * 2));
}

function toDate(val: unknown): Date | null {
    if (val instanceof Date) return val;
    if (typeof val === 'number') return new Date(val * 1000);
    if (typeof val === 'string') { const d = new Date(val); return isNaN(d.getTime()) ? null : d; }
    return null;
}

function km(val: unknown): string {
    if (typeof val !== 'number') return '–';
    return String(parseFloat((val / 1000).toFixed(3)));
}

export function extractSession(data: FitUploadResponse): string {
    const session = (data.messages['sessionMesgs'] as Record<string, unknown>[])?.[0];
    if (!session) return '';

    const lines: string[] = ['--- Edzés összefoglaló ---'];

    // Sport
    if (session['sportProfileName']) lines.push(`Sport profil:          ${session['sportProfileName']}`);
    if (session['sport'])           lines.push(`Sport:                 ${session['sport']}`);
    if (session['subSport'])        lines.push(`Alsport:               ${session['subSport']}`);

    // Időpontok
    const startDate = toDate(session['startTime']);
    if (startDate) lines.push(`Kezdés:                ${startDate.toLocaleString('hu-HU')}`);
    const elapsed = typeof session['totalElapsedTime'] === 'number' ? session['totalElapsedTime'] as number : null;
    if (startDate && elapsed !== null) {
        const endDate = new Date(startDate.getTime() + elapsed * 1000);
        lines.push(`Befejezés:             ${endDate.toLocaleString('hu-HU')}`);
    }

    // Kalória
    if (typeof session['totalCalories'] === 'number')    lines.push(`Kalória:               ${session['totalCalories']} kcal`);
    if (typeof session['metabolicCalories'] === 'number') lines.push(`Metabolikus kalória:   ${session['metabolicCalories']} kcal`);

    // Pulzus
    if (typeof session['avgHeartRate'] === 'number') lines.push(`Átl. pulzus:           ${session['avgHeartRate']} bpm`);
    if (typeof session['maxHeartRate'] === 'number') lines.push(`Max. pulzus:           ${session['maxHeartRate']} bpm`);

    // Kadencia / lépések
    if (typeof session['avgRunningCadence'] === 'number') {
        lines.push(`Átl. futókadencia:     ${cadence(session['avgRunningCadence'])} lép/p`);
    } else if (typeof session['avgCadence'] === 'number') {
        lines.push(`Átl. kadencia:         ${cadence(session['avgCadence'])} lép/p`);
    }
    if (typeof session['maxRunningCadence'] === 'number') {
        lines.push(`Max. futókadencia:     ${cadence(session['maxRunningCadence'])} lép/p`);
    } else if (typeof session['maxCadence'] === 'number') {
        lines.push(`Max. kadencia:         ${cadence(session['maxCadence'])} lép/p`);
    }
    if (typeof session['totalStrides'] === 'number') lines.push(`Össz. lépés:           ${session['totalStrides']}`);

    // Hőmérséklet
    if (typeof session['avgTemperature'] === 'number') lines.push(`Átl. hőmérséklet:      ${session['avgTemperature']} °C`);
    if (typeof session['maxTemperature'] === 'number') lines.push(`Max. hőmérséklet:      ${session['maxTemperature']} °C`);
    if (typeof session['minTemperature'] === 'number') lines.push(`Min. hőmérséklet:      ${session['minTemperature']} °C`);

    // Légzés (rpm)
    if (typeof session['enhancedAvgRespirationRate'] === 'number') lines.push(`Átl. légzés:           ${session['enhancedAvgRespirationRate'].toFixed(1)} l/p`);
    if (typeof session['enhancedMaxRespirationRate'] === 'number') lines.push(`Max. légzés:           ${session['enhancedMaxRespirationRate'].toFixed(1)} l/p`);
    if (typeof session['enhancedMinRespirationRate'] === 'number') lines.push(`Min. légzés:           ${session['enhancedMinRespirationRate'].toFixed(1)} l/p`);

    // Futásdinamika
    if (typeof session['avgStepLength'] === 'number')        lines.push(`Átl. lépéshossz:       ${(session['avgStepLength'] as number).toFixed(2)} m`);
    if (typeof session['avgStanceTime'] === 'number')        lines.push(`Átl. talajérintés:     ${(session['avgStanceTime'] as number).toFixed(0)} ms`);
    if (typeof session['avgStanceTimePercent'] === 'number') lines.push(`Talajérintés %:        ${(session['avgStanceTimePercent'] as number).toFixed(1)} %`);
    if (typeof session['avgStanceTimeBalance'] === 'number') lines.push(`Talajérintés bal/jobb: ${(session['avgStanceTimeBalance'] as number).toFixed(1)} %`);
    if (typeof session['avgVerticalRatio'] === 'number')     lines.push(`Vert. arány:           ${(session['avgVerticalRatio'] as number).toFixed(1)} %`);

    // Önértékelés
    if (typeof session['workoutFeel'] === 'number') lines.push(`Közérzet:              ${session['workoutFeel']} %`);
    if (typeof session['workoutRpe'] === 'number') {
        const rpeVal = Math.round((session['workoutRpe'] as number) / 10);
        const rpeLabels: Record<number, string> = {
            1: 'Nagyon könnyű', 2: 'Könnyű', 3: 'Mérsékelt', 4: 'Kissé nehéz',
            5: 'Nehéz', 6: 'Nehéz', 7: 'Nagyon nehéz', 8: 'Nagyon nehéz',
            9: 'Rendkívül nehéz', 10: 'Maximális',
        };
        lines.push(`RPE:                   ${rpeVal}/10 – ${rpeLabels[rpeVal] ?? ''}`);
    }

    // Edzésterhelés
    const aerobicTE = typeof session['totalTrainingEffect'] === 'number' ? session['totalTrainingEffect'] as number : null;
    const anaerobicTE = typeof session['totalAnaerobicTrainingEffect'] === 'number' ? session['totalAnaerobicTrainingEffect'] as number : null;
    lines.push(`Aerob edzéshatás:      ${aerobicTE !== null ? aerobicTE.toFixed(1) + ' / 5.0 – ' + teLabel(aerobicTE) : '–'}`);
    lines.push(`Anaerob edzéshatás:    ${anaerobicTE !== null ? anaerobicTE.toFixed(1) + ' / 5.0 – ' + teLabel(anaerobicTE) : '–'}`);
    if (typeof session['trainingStressScore'] === 'number') {
        lines.push(`Training Stress Score: ${(session['trainingStressScore'] / 10).toFixed(1)}`);
    }
    if (typeof session['intensityFactor'] === 'number') {
        lines.push(`Intenzitás faktor:     ${(session['intensityFactor'] / 1000).toFixed(2)}`);
    }
    const trainingLoad = typeof session['trainingLoadPeak'] === 'number' ? session['trainingLoadPeak'] as number : null;
    if (trainingLoad !== null && trainingLoad !== 0) {
        lines.push(`Edzésterhelés (peak):  ${trainingLoad.toFixed(1)}`);
    }

    // Séta / futás / állás idők a splitSummaryMesgs-ből
    const summaries = data.messages['splitSummaryMesgs'] as Record<string, unknown>[] | undefined;
    if (summaries && summaries.length > 0) {
        const rwdTypes: Record<string, string> = { rwdRun: 'Futás idő:', rwdWalk: 'Séta idő:', rwdStand: 'Állás idő:' };
        for (const [key, label] of Object.entries(rwdTypes)) {
            const entry = summaries.find(s => String(s['splitType']) === key);
            if (entry && typeof entry['totalTimerTime'] === 'number') {
                lines.push(`${label} ${formatSeconds(entry['totalTimerTime'] as number)}`);
            }
        }
    }


    // Edzés neve és leírása (workoutMesgs)
    const workoutMesgs = data.messages['workoutMesgs'] as Record<string, unknown>[] | undefined;
    const workout = workoutMesgs?.[0];
    if (workout) {
        const wktNameArr = Array.isArray(workout['wktName']) ? (workout['wktName'] as unknown[]).filter(s => typeof s === 'string' && (s as string).trim()) : null;
        const wktName = wktNameArr && wktNameArr.length > 0 ? (wktNameArr as string[]).join(' ') : (typeof workout['wktName'] === 'string' ? workout['wktName'] : '');
        if (wktName) lines.push(`Edzés neve:            ${wktName}`);
        if (typeof workout['numValidSteps'] === 'number') lines.push(`Lépések száma:         ${workout['numValidSteps']}`);
    }

    // Edzéslépések (workoutStepMesgs)
    const workoutSteps = data.messages['workoutStepMesgs'] as Record<string, unknown>[] | undefined;
    if (workoutSteps && workoutSteps.length > 0) {
        lines.push('');
        lines.push('Edzéslépések:');
        for (let i = 0; i < workoutSteps.length; i++) {
            const step = workoutSteps[i];
            // A notes tömb első eleme a szöveges megjegyzés
            const notesArr = Array.isArray(step['notes']) ? step['notes'] as unknown[] : null;
            const noteText = notesArr && typeof notesArr[0] === 'string' && notesArr[0].trim() ? notesArr[0].trim() : '';

            const intensity = typeof step['intensity'] === 'string' ? step['intensity'] : '';
            const durationType = typeof step['durationType'] === 'string' ? step['durationType'] : '';
            const durationTime = typeof step['durationTime'] === 'number' ? step['durationTime'] as number : null;
            const targetType = typeof step['targetType'] === 'string' ? step['targetType'] : '';
            const hrZone = typeof step['targetHrZone'] === 'number' ? step['targetHrZone'] as number : 0;
            const hrLow = typeof step['customTargetHeartRateLow'] === 'number' ? step['customTargetHeartRateLow'] as number : null;
            const hrHigh = typeof step['customTargetHeartRateHigh'] === 'number' ? step['customTargetHeartRateHigh'] as number : null;

            const durationStr = durationType === 'time' && durationTime !== null
                ? formatSeconds(durationTime)
                : durationType || '–';

            let targetStr = '';
            if (targetType === 'heartRate') {
                if (hrZone > 0) targetStr = `HR Z${hrZone}`;
                else if (hrLow !== null && hrHigh !== null) targetStr = `${hrLow}–${hrHigh} bpm`;
            } else if (targetType) {
                targetStr = targetType;
            }

            const parts = [`${i + 1}.`];
            if (noteText) parts.push(noteText);
            if (intensity) parts.push(`[${intensity}]`);
            parts.push(durationStr);
            if (targetStr) parts.push(targetStr);
            lines.push('  ' + parts.join('  '));
        }
    }


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

export function extractSplits(data: FitUploadResponse, mergeShortWalks = false): string {
    const splits = data.messages['splitMesgs'] as Record<string, unknown>[] | undefined;
    const summaries = data.messages['splitSummaryMesgs'] as Record<string, unknown>[] | undefined;

    if (!splits || splits.length === 0) return '';

    const filtered = mergeShortWalks ? splits.filter(s =>
        typeof s['totalElapsedTime'] === 'number' && (s['totalElapsedTime'] as number) >= 1 &&
        typeof s['totalDistance'] === 'number' && (s['totalDistance'] as number) > 0
    ) : splits;
    if (filtered.length === 0) return '';

    // 7 méternél rövidebb gyaloglás → állás (csak ha engedélyezett)
    const reclassified = mergeShortWalks ? filtered.map(s => {
        if (String(s['splitType']) === 'rwdWalk' && (typeof s['totalDistance'] !== 'number' || (s['totalDistance'] as number) < 7)) {
            return { ...s, splitType: 'rwdStand' };
        }
        return s;
    }) : filtered;

    // Szomszédos rwdStand bejegyzések összevonása
    const merged: Record<string, unknown>[] = [];
    for (const split of reclassified) {
        const prev = merged[merged.length - 1];
        if (prev && String(prev['splitType']) === 'rwdStand' && String(split['splitType']) === 'rwdStand') {
            const d1 = typeof prev['totalDistance'] === 'number' ? prev['totalDistance'] as number : 0;
            const d2 = typeof split['totalDistance'] === 'number' ? split['totalDistance'] as number : 0;
            const t1 = typeof prev['totalElapsedTime'] === 'number' ? prev['totalElapsedTime'] as number : 0;
            const t2 = typeof split['totalElapsedTime'] === 'number' ? split['totalElapsedTime'] as number : 0;
            const totalDist = d1 + d2;
            const totalTime = t1 + t2;
            merged[merged.length - 1] = {
                ...prev,
                totalDistance: totalDist,
                totalElapsedTime: totalTime,
                avgSpeed: totalTime > 0 ? totalDist / totalTime : 0,
                totalAscent: (typeof prev['totalAscent'] === 'number' ? prev['totalAscent'] as number : 0) + (typeof split['totalAscent'] === 'number' ? split['totalAscent'] as number : 0),
                totalDescent: (typeof prev['totalDescent'] === 'number' ? prev['totalDescent'] as number : 0) + (typeof split['totalDescent'] === 'number' ? split['totalDescent'] as number : 0),
            };
        } else {
            merged.push({ ...split });
        }
    }

    const header = ['#', 'Típus', 'Táv (km)', 'Idő', 'Pace (min/km)', 'Emelkedés (m)', 'Süllyedés (m)'];

    let activeIdx = 0;
    let passiveIdx = 0;
    const rows = merged.map((split) => {
        const type = String(split['splitType'] ?? '');
        const isActive = ACTIVE_SPLIT_TYPES.has(type);
        const label = SPLIT_TYPE_HU[type] ?? type;
        const idx = isActive ? `${++activeIdx}.` : `(${++passiveIdx})`;

        return [
            idx,
            label,
            km(split['totalDistance']),
            typeof split['totalElapsedTime'] === 'number' ? formatSeconds(split['totalElapsedTime'] as number) : '–',
            mpsToMinPerKm(split['avgSpeed']),
            num(split['totalAscent'], 0),
            num(split['totalDescent'], 0),
        ];
    });

    const lines = [
        `--- Intervallumok / splitMesgs (${merged.length} bejegyzés, ${activeIdx} aktív) ---`,
        header.join(','),
        ...rows.map(r => r.join(',')),
    ];

    // splitSummaryMesgs: tervezett vs teljesített összefoglaló, ha elérhető
    if (summaries && summaries.length > 0) {
        lines.push('');
        lines.push('--- Intervallum összefoglalók (splitSummaryMesgs) ---');
        lines.push('Típus,Darab,Össz táv (km),Össz idő');
        const NOISE_TYPES = new Set(['rwdWalk', 'rwdStand']);
        for (const s of summaries) {
            const type = String(s['splitType'] ?? '');
            if (NOISE_TYPES.has(type) && typeof s['totalTimerTime'] === 'number' && (s['totalTimerTime'] as number) < 30) continue;
            const label = SPLIT_TYPE_HU[type] ?? type;
            const count = typeof s['numSplits'] === 'number' ? s['numSplits'] : '–';
            const dist = km(s['totalDistance']);
            const time = typeof s['totalTimerTime'] === 'number' ? formatSeconds(s['totalTimerTime'] as number) : '–';
            lines.push(`${label},${count},${dist},${time}`);
        }
    }

    return lines.join('\n');
}

function teLabel(val: number): string {
    if (val >= 5.0) return 'Megterhelés';
    if (val >= 4.0) return 'Magas fejlődés';
    if (val >= 3.0) return 'Fejlődés';
    if (val >= 2.0) return 'Fenntartás';
    if (val >= 1.0) return 'Kis hatás';
    return 'Nincs hatás';
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
        'Átl. légzés (l/p)',
        'Max. légzés (l/p)',
    ];

    const rows = laps.map((lap, i) => [
        `${i + 1}.`,
        km(lap['totalDistance']),
        mpsToMinPerKm(lap['avgSpeed']),
        num(lap['totalAscent'], 0),
        num(lap['totalDescent'], 0),
        cadence(lap['avgRunningCadence'] ?? lap['avgCadence']),
        cadence(lap['maxRunningCadence'] ?? lap['maxCadence']),
        num(lap['avgStepLength'], 2),
        num(lap['avgVerticalOscillation'], 1),
        num(lap['avgStanceTime'], 0),
        num(lap['avgVerticalRatio'], 1),
        num(lap['enhancedAvgRespirationRate'], 1),
        num(lap['enhancedMaxRespirationRate'], 1),
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

    const sleepSec = typeof profile['sleepTime'] === 'number' ? profile['sleepTime'] as number : null;
    const wakeSec  = typeof profile['wakeTime']  === 'number' ? profile['wakeTime']  as number : null;
    let sleepDuration = '';
    if (sleepSec !== null && wakeSec !== null) {
        const DAY = 24 * 3600;
        const dur = ((wakeSec - sleepSec) + DAY) % DAY;
        const dh = Math.floor(dur / 3600);
        const dm = Math.floor((dur % 3600) / 60);
        sleepDuration = ` (${dh} ó ${String(dm).padStart(2, '0')} p)`;
    }

    const lines = [
        `Súly:          ${typeof profile['weight'] === 'number' ? profile['weight'] + ' kg' : '–'}`,
        `Magasság:      ${typeof profile['height'] === 'number' ? profile['height'] + ' m' : '–'}`,
        `Alvási idő:    ${secondsToHHMM(profile['sleepTime'])}`,
        `Ébredési idő:  ${secondsToHHMM(profile['wakeTime'])}${sleepDuration}`,
    ];

    const session = (data.messages['sessionMesgs'] as Record<string, unknown>[])?.[0];
    const sessionStart = toDate(session?.['startTime']);
    if (sessionStart) lines.push(`Edzés kezdete: ${sessionStart.toLocaleString('hu-HU')}`);

    return lines.join('\n');
}

function formatValue(val: unknown): string {
    if (val === null || val === undefined) return '–';
    if (val instanceof Date) return val.toLocaleString('hu-HU');
    if (typeof val === 'number' && val > 631065600 && val < 4294967295) return new Date(val * 1000).toLocaleString('hu-HU');
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
}
