// Pure data-extraction module – no DOM, no @garmin/fitsdk, importable in Node.js too.

export interface FitUploadResponse {
    activityId: string | null;
    messages: Record<string, unknown[]>;
    errors: string[];
}

/** Builds the full plain-text summary that goes into the textarea / /api/process response. */
export function buildTextOutput(data: FitUploadResponse, mergeShortWalks = false): string {
    return [
        extractUserProfile(data),
        extractSession(data),
        extractLaps(data),
        extractSplits(data, mergeShortWalks),
    ].filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function stepLengthMm(val: unknown): string {
    if (typeof val !== 'number') return '–';
    return val.toFixed(2);
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

function teLabel(val: number): string {
    if (val >= 5.0) return 'Megterhelés';
    if (val >= 4.0) return 'Magas fejlődés';
    if (val >= 3.0) return 'Fejlődés';
    if (val >= 2.0) return 'Fenntartás';
    if (val >= 1.0) return 'Kis hatás';
    return 'Nincs hatás';
}

function workoutFeelLabel(workoutFeelPercent: number): string {
    if (workoutFeelPercent <= 20) return 'Nagyon gyenge';
    if (workoutFeelPercent <= 40) return 'Gyenge';
    if (workoutFeelPercent <= 60) return 'Normál';
    if (workoutFeelPercent <= 80) return 'Erős';
    return 'Nagyon erős';
}

function workoutRpeLabel(rpeVal: number): string {
    if (rpeVal <= 1) return 'Semmi különös, olyan mintha TV-t néznék. E1';
    if (rpeVal <= 3) return 'Nagyon könnyű. Beszélgetni is tudnék. E1-E1/2';
    if (rpeVal <= 6) return 'Nehezedő tempó, még tudok pár mondatot mondani. E1/2-E2';
    if (rpeVal <= 8) return 'Már a fájdalmas intenzitás határán. E2-EX';
    if (rpeVal === 9) return 'Majdnem maxon vagyok. EX-AN';
    return 'Maximális, most hagyj békén. AN-SW';
}

function formatSeconds(secs: number): string {
    const total = Math.round(secs);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatValue(val: unknown): string {
    if (val === null || val === undefined) return '–';
    if (val instanceof Date) return val.toLocaleString('hu-HU');
    if (typeof val === 'number' && val > 631065600 && val < 4294967295) return new Date(val * 1000).toLocaleString('hu-HU');
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
}

// ---------------------------------------------------------------------------
// Active interval splitType értékek
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// extractStops / extractSlowSegments (private helpers for extractSplits)
// ---------------------------------------------------------------------------

function extractStops(data: FitUploadResponse, _splits: Record<string, unknown>[]): string {
    const records = data.messages['recordMesgs'] as Record<string, unknown>[] | undefined;
    const laps = data.messages['lapMesgs'] as Record<string, unknown>[] | undefined;

    if (!records || records.length === 0 || !laps || laps.length === 0) return '';

    const stops: { start: number; end: number }[] = [];
    let current: { start: number } | null = null;

    for (const r of records) {
        const speed = r['enhancedSpeed'] as number | undefined;
        const cad = r['cadence'] as number | undefined;
        const time = toDate(r['timestamp'])?.getTime();

        if (!time) continue;

        const isStopped =
            (typeof speed === 'number' && speed < 0.5) ||
            (typeof cad === 'number' && cad < 50);

        if (isStopped) {
            if (!current) current = { start: time };
        } else if (current) {
            stops.push({ start: current.start, end: time });
            current = null;
        }
    }

    const MIN_STOP_MS = 2_000;
    const validStops = stops
        .filter(s => (s.end - s.start) >= MIN_STOP_MS)
        .sort((a, b) => a.start - b.start);

    if (validStops.length === 0) return '';

    function findLapIndex(ts: number) {
        return laps!.findIndex(l => {
            const start = toDate(l['startTime'])?.getTime();
            const end = toDate(l['endTime'])?.getTime();
            if (!start || !end) return false;
            return ts >= start && ts <= end;
        });
    }

    const lines: string[] = [];

    for (const stop of validStops) {
        const idx = findLapIndex(stop.start);
        if (idx === -1) continue;

        const lap = laps[idx];
        const lapStart = toDate(lap['startTime'])?.getTime();
        if (!lapStart) continue;

        const offsetSec = Math.floor((stop.start - lapStart) / 1000);
        const durationSec = Math.floor((stop.end - stop.start) / 1000);

        if (lines.length === 0) {
            lines.push('--- Megállások ---');
        }
        lines.push(`${idx + 1}. kör: +${formatSeconds(offsetSec)} → ${formatSeconds(durationSec)}`);
    }

    return lines.join('\n');
}

function extractSlowSegments(data: FitUploadResponse, _splits: Record<string, unknown>[]): string {
    const records = data.messages['recordMesgs'] as Record<string, unknown>[] | undefined;
    const laps = data.messages['lapMesgs'] as Record<string, unknown>[] | undefined;

    if (!records || records.length === 0 || !laps || laps.length === 0) return '';

    const segments: { start: number; end: number }[] = [];
    let current: { start: number } | null = null;

    for (const r of records) {
        const speed = r['enhancedSpeed'] as number | undefined;
        const cad = r['cadence'] as number | undefined;
        const vertSpeed = r['enhancedVertSpeed'] as number | undefined;
        const time = toDate(r['timestamp'])?.getTime();

        if (!time) continue;

        const isSlow =
            typeof speed === 'number' &&
            typeof cad === 'number' &&
            speed < 1.5 &&
            cad < 130 &&
            (typeof vertSpeed !== 'number' || Math.abs(vertSpeed) < 0.3);

        if (isSlow) {
            if (!current) current = { start: time };
        } else if (current) {
            segments.push({ start: current.start, end: time });
            current = null;
        }
    }

    const MIN_SLOW_MS = 15_000;

    const valid = segments
        .filter(s => (s.end - s.start) >= MIN_SLOW_MS)
        .sort((a, b) => a.start - b.start);

    if (valid.length === 0) return '';

    function findLapIndex(ts: number) {
        return laps!.findIndex(l => {
            const start = toDate(l['startTime'])?.getTime();
            const end = toDate(l['endTime'])?.getTime();
            if (!start || !end) return false;
            return ts >= start && ts <= end;
        });
    }

    const lines: string[] = [];

    for (const seg of valid) {
        const idx = findLapIndex(seg.start);
        if (idx === -1) continue;

        const lap = laps[idx];
        const lapStart = toDate(lap['startTime'])?.getTime();
        if (!lapStart) continue;

        const offsetSec = Math.floor((seg.start - lapStart) / 1000);
        const durationSec = Math.floor((seg.end - seg.start) / 1000);
        if (lines.length === 0) {
            lines.push('--- Lassulások ---');
        }
        lines.push(`${idx + 1}. kör: +${formatSeconds(offsetSec)} → ${formatSeconds(durationSec)}`);
    }

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public extract functions
// ---------------------------------------------------------------------------

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

    // Szintemelkedés / szintsullyedes
    if (typeof session['totalAscent'] === 'number')  lines.push(`Össz. emelkedés:       ${session['totalAscent']} m`);
    if (typeof session['totalDescent'] === 'number') lines.push(`Össz. süllyedés:       ${session['totalDescent']} m`);

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
    if (typeof session['avgTemperature'] === 'number') lines.push(`Átl. kar hőmérséklet:  ${session['avgTemperature']} °C`);
    if (typeof session['maxTemperature'] === 'number') lines.push(`Max. kar hőmérséklet:  ${session['maxTemperature']} °C`);
    if (typeof session['minTemperature'] === 'number') lines.push(`Min. kar hőmérséklet:  ${session['minTemperature']} °C`);

    // Légzés (rpm)
    if (typeof session['enhancedAvgRespirationRate'] === 'number') lines.push(`Átl. légzés:           ${session['enhancedAvgRespirationRate'].toFixed(1)} l/p`);
    if (typeof session['enhancedMaxRespirationRate'] === 'number') lines.push(`Max. légzés:           ${session['enhancedMaxRespirationRate'].toFixed(1)} l/p`);
    if (typeof session['enhancedMinRespirationRate'] === 'number') lines.push(`Min. légzés:           ${session['enhancedMinRespirationRate'].toFixed(1)} l/p`);

    // Futásdinamika
    if (typeof session['avgStepLength'] === 'number')        lines.push(`Átl. lépéshossz:       ${stepLengthMm(session['avgStepLength'])} mm`);
    if (typeof session['avgStanceTime'] === 'number')        lines.push(`Átl. talajérintés:     ${(session['avgStanceTime'] as number).toFixed(0)} ms`);
    if (typeof session['avgStanceTimePercent'] === 'number') lines.push(`Talajérintés %:        ${(session['avgStanceTimePercent'] as number).toFixed(1)} %`);
    if (typeof session['avgStanceTimeBalance'] === 'number') lines.push(`Talajérintés bal/jobb: ${(session['avgStanceTimeBalance'] as number).toFixed(1)} %`);
    if (typeof session['avgVerticalRatio'] === 'number')     lines.push(`Vert. arány:           ${(session['avgVerticalRatio'] as number).toFixed(1)} %`);

    // Önértékelés
    if (typeof session['workoutFeel'] === 'number') {
        const feel = session['workoutFeel'] as number;
        lines.push(`Önértékelés/Közérzet:  ${workoutFeelLabel(feel)}`);
    }
    if (typeof session['workoutRpe'] === 'number') {
        const raw = session['workoutRpe'] as number;
        const rpeVal = Math.min(10, Math.max(1, Math.round(raw / 10)));
        lines.push(`Önértékelés/RPE:       ${rpeVal}/10 - ${workoutRpeLabel(rpeVal)}`);
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
                lines.push(`${label.padEnd(22, ' ')}${formatSeconds(entry['totalTimerTime'] as number)}`);
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

export function extractSplits(data: FitUploadResponse, mergeShortWalks = false): string {
    const splits = data.messages['splitMesgs'] as Record<string, unknown>[] | undefined;
    const summaries = data.messages['splitSummaryMesgs'] as Record<string, unknown>[] | undefined;

    if (!splits || splits.length === 0) return '';

    const INTERVAL_TYPES = new Set([
        'intervalWarmup',
        'intervalActive',
        'intervalRest',
        'intervalCooldown',
    ]);

    const filtered = splits.filter(s => INTERVAL_TYPES.has(String(s['splitType'])));
    if (filtered.length === 0) return '';

    // pairing: active + rest blokkok
    const paired: Record<string, unknown>[] = [];
    let currentActive: Record<string, unknown> | null = null;

    for (const split of filtered) {
        const type = String(split['splitType']);

        if (type === 'intervalActive') {
            currentActive = { active: split };
        } else if (type === 'intervalRest' && currentActive) {
            paired.push({ active: currentActive['active'], rest: split });
            currentActive = null;
        } else {
            paired.push({ single: split });
        }
    }

    const header = ['#', 'Típus', 'Táv (km)', 'Idő', 'Pace (min/km)', 'Emelkedés (m)', 'Süllyedés (m)'];

    let activeIdx = 0;
    let passiveIdx = 0;

    const rows = paired.map((block) => {
        if ('active' in block && 'rest' in block) {
            const a = block['active'] as Record<string, unknown>;
            const r = block['rest'] as Record<string, unknown>;

            return [
                `${++activeIdx}.`,
                'Intervallum',
                `${km(a['totalDistance'])} / ${km(r['totalDistance'])}`,
                `${formatSeconds(a['totalElapsedTime'] as number)} + ${formatSeconds(r['totalElapsedTime'] as number)}`,
                mpsToMinPerKm(a['avgSpeed']),
                num(a['totalAscent'], 0),
                num(a['totalDescent'], 0),
            ];
        }

        const split = block['single'] as Record<string, unknown>;
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
        `--- Intervallumok / splitMesgs (${filtered.length} bejegyzés, ${activeIdx} blokk) ---`,
        header.join(','),
        ...rows.map(r => r.join(',')),
    ];

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

    const stopsText = extractStops(data, splits);
    if (stopsText) {
        lines.push('');
        lines.push(stopsText);
    }

    const slowText = extractSlowSegments(data, splits);
    if (slowText) {
        lines.push('');
        lines.push(slowText);
    }

    // mergeShortWalks is reserved for future use (passed through from buildTextOutput)
    void mergeShortWalks;

    return lines.join('\n');
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
        'Lépéshossz (mm)',
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
        stepLengthMm(lap['avgStepLength']),
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
        `Elalvás időpontja: ${secondsToHHMM(profile['sleepTime'])}`,
        `Ébredési idő:  ${secondsToHHMM(profile['wakeTime'])}${sleepDuration}`,
    ];

    return lines.join('\n');
}
