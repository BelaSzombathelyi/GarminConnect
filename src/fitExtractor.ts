// Pure data-extraction module – no DOM, no @garmin/fitsdk, importable in Node.js too.

export interface FitUploadResponse {
    activityId: string | null;
    messages: Record<string, unknown[]>;
    errors: string[];
}

const SHOW_USER_PROFILE = false;

/** Builds the full plain-text summary that goes into the textarea / /api/process response. */
export function buildTextOutput(data: FitUploadResponse, mergeShortWalks = false): string {
    const sections: string[] = [];
    const summary = extractSummary(data);
    if (summary) sections.push(summary);
    if (SHOW_USER_PROFILE) {
        const profile = extractUserProfile(data);
        if (profile) sections.push(profile);
    }
    sections.push(
        extractSession(data),
        extractLaps(data),
        extractSplits(data, mergeShortWalks),
        extractTrailClimbInfo(data),
    );
    return sections.filter(Boolean).join('\n\n');
}

function teShortLabel(val: number): string {
    if (val >= 4.0) return 'magas';
    if (val >= 2.0) return 'kozepes';
    if (val > 0.0) return 'alacsony';
    return 'nincs';
}

function extractSummary(data: FitUploadResponse): string {
    const session = (data.messages['sessionMesgs'] as Record<string, unknown>[])?.[0];
    if (!session) return '';

    const sportProfile = typeof session['sportProfileName'] === 'string'
        ? (session['sportProfileName'] as string).toLowerCase()
        : '';
    const totalElapsed = typeof session['totalElapsedTime'] === 'number' ? (session['totalElapsedTime'] as number) : null;
    const durationLabel = totalElapsed !== null ? secondsToHHMM(totalElapsed) : '–';
    const distanceLabel = typeof session['totalDistance'] === 'number' ? `${km(session['totalDistance'])} km` : '–';
    const typeLabel = sportProfile
        ? (totalElapsed !== null && totalElapsed >= 3 * 3600 ? `${sportProfile} (hosszu)` : sportProfile)
        : '–';
    const ascentValue = typeof session['totalAscent'] === 'number' ? (session['totalAscent'] as number) : null;
    const distanceValue = typeof session['totalDistance'] === 'number' ? (session['totalDistance'] as number) : null;
    const ascentRatioPercent =
        ascentValue !== null && distanceValue !== null && distanceValue > 0
            ? (ascentValue / distanceValue) * 100
            : null;
    const shouldHideAscent = sportProfile.includes('futás') && ascentRatioPercent !== null && ascentRatioPercent < 1;
    const ascent = ascentValue !== null ? `+${ascentValue} m` : '–';

    const avgHeart = typeof session['avgHeartRate'] === 'number' ? String(session['avgHeartRate']) : '–';

    const rawRpe = typeof session['workoutRpe'] === 'number' ? (session['workoutRpe'] as number) : null;
    const rpeLabel = rawRpe !== null ? `${Math.min(10, Math.max(1, Math.round(rawRpe / 10)))}/10` : '–';

    const aerobic = typeof session['totalTrainingEffect'] === 'number' ? (session['totalTrainingEffect'] as number) : null;
    const anaerobic = typeof session['totalAnaerobicTrainingEffect'] === 'number' ? (session['totalAnaerobicTrainingEffect'] as number) : null;
    const aerobicLabel = aerobic !== null ? `${aerobic.toFixed(1)} (${teShortLabel(aerobic)})` : '–';
    const anaerobicLabel = anaerobic !== null ? teShortLabel(anaerobic) : '–';

    const startDate = toDate(session['startTime']);
    const startDateStr = startDate
        ? `${startDate.toLocaleDateString('hu-HU')} ${startDate.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })}`
        : '';
    const workoutMesgs = data.messages['workoutMesgs'] as Record<string, unknown>[] | undefined;
    const workout = workoutMesgs?.[0];
    const wktNameArr = workout && Array.isArray(workout['wktName'])
        ? (workout['wktName'] as unknown[]).filter(s => typeof s === 'string' && (s as string).trim())
        : null;
    const wktName = wktNameArr && wktNameArr.length > 0
        ? (wktNameArr as string[]).join(' ')
        : (workout && typeof workout['wktName'] === 'string' ? workout['wktName'] as string : '');

    const headerParts = [startDateStr, durationLabel, wktName].filter(Boolean);
    const headerLine = "# Workout Summary: " + (headerParts.length > 0 ? headerParts.join(' | ') : 'Summary');

    return [
        headerLine,
        '',
        `Type: ${typeLabel}`,
        `Time: ${durationLabel}`,
        `Distance: ${distanceLabel}`,
        ...(shouldHideAscent ? [] : [`Elevation: ${ascent}`]),
        '',
        `Heart rate: avg ${avgHeart} bpm`,
        `RPE: ${rpeLabel}`,
        '',
        `Aerobic: ${aerobicLabel}`,
        `Anaerobic: ${anaerobicLabel}`,
    ].join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function secondsToHHMM(seconds: unknown): string {
    if (typeof seconds !== 'number') return '–';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}:${String(m).padStart(2, '0')}`;
}

function buildMarkdownTable(rows: Array<[string, string]>): string {
    if (rows.length === 0) return '';
    const lines = [
        '| Adat | Érték |',
        '| :--- | ---: |',
        ...rows.map(([key, val]) => `| ${key} | ${val} |`),
    ];
    return lines.join('\n');
}

function buildKeyValueLines(rows: Array<[string, string]>): string {
    if (rows.length === 0) return '';
    return rows.map(([key, val]) => `${key}: ${val}`).join('\n');
}

function mpsToMinPerKm(speed: unknown): string {
    if (typeof speed !== 'number' || speed <= 0) return '–';
    // Az FIT SDK az avgSpeed-et 0.01 m/s-es egységekben adja meg
    const mps = speed / 100;
    const secPerKm = 1000 / mps;
    const totalSec = Math.round(secPerKm);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

function paceFromTimeDistance(elapsedTimeSeconds: unknown, distanceMeters: unknown): string {
    if (typeof elapsedTimeSeconds !== 'number' || typeof distanceMeters !== 'number' || distanceMeters <= 0) return '–';
    const secPerKm = (elapsedTimeSeconds * 1000) / distanceMeters;
    const totalSec = Math.round(secPerKm);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
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

function splitTimeSeconds(split: Record<string, unknown>): number | null {
    if (typeof split['totalTimerTime'] === 'number') return split['totalTimerTime'] as number;
    if (typeof split['totalElapsedTime'] === 'number') return split['totalElapsedTime'] as number;
    return null;
}

function firstPlannedStepDurationBeforeCooldown(data: FitUploadResponse): number | null {
    const steps = data.messages['workoutStepMesgs'] as Record<string, unknown>[] | undefined;
    if (!steps || steps.length === 0) return null;

    const beforeCooldown = steps.filter((s) => String(s['intensity'] ?? '').toLowerCase() !== 'cooldown');
    if (beforeCooldown.length !== 1) return null;

    const first = beforeCooldown[0];
    if (String(first['durationType'] ?? '').toLowerCase() !== 'time') return null;
    return typeof first['durationTime'] === 'number' ? first['durationTime'] as number : null;
}

function isOpenCooldownStep(step: Record<string, unknown>): boolean {
    const intensity = String(step['intensity'] ?? '').toLowerCase();
    const durationType = String(step['durationType'] ?? '').toLowerCase();
    const targetType = String(step['targetType'] ?? '').toLowerCase();
    return intensity === 'cooldown' && durationType === 'open' && targetType === 'open';
}

function getVisibleWorkoutSteps(data: FitUploadResponse): Record<string, unknown>[] {
    const workoutSteps = data.messages['workoutStepMesgs'] as Record<string, unknown>[] | undefined;
    if (!workoutSteps || workoutSteps.length === 0) return [];
    const visibleSteps = [...workoutSteps];
    if (visibleSteps.length > 0 && isOpenCooldownStep(visibleSteps[visibleSteps.length - 1])) {
        visibleSteps.pop();
    }
    return visibleSteps;
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

function extractPauseEvents(data: FitUploadResponse): string {
    const events = data.messages['eventMesgs'] as Record<string, unknown>[] | undefined;
    const laps = data.messages['lapMesgs'] as Record<string, unknown>[] | undefined;
    if (!events || events.length === 0) return '';

    const session = (data.messages['sessionMesgs'] as Record<string, unknown>[])?.[0];
    const sessionDate = toDate(session?.['startTime'])?.toLocaleDateString('hu-HU');

    const timerEvents = events
        .map((e) => ({
            event: String(e['event'] ?? '').toLowerCase(),
            eventType: String(e['eventType'] ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''),
            timestamp: toDate(e['timestamp']),
        }))
        .filter((e) => e.event === 'timer' && e.timestamp instanceof Date)
        .sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0));

    if (timerEvents.length === 0) return '';

    const stopTypes = new Set(['stop', 'stopall', 'stopdisableall']);
    const startTypes = new Set(['start', 'startall']);

    const pauses: Array<{ start: Date; end: Date; durationSec: number; lapLabel: string }> = [];
    let pauseStart: Date | null = null;

    function findLapLabel(ts: number): string {
        if (!laps || laps.length === 0) return '–';
        const starts = laps.map((l) => toDate(l['startTime'])?.getTime() ?? NaN).filter(Number.isFinite);
        if (starts.length === 0) return '–';
        // Find the last lap whose startTime <= ts
        let best = -1;
        for (let i = 0; i < starts.length; i++) {
            if (starts[i] <= ts) best = i;
        }
        return best >= 0 ? `${best + 1}` : '–';
    }

    for (const e of timerEvents) {
        if (!e.timestamp) continue;

        if (stopTypes.has(e.eventType)) {
            pauseStart = e.timestamp;
            continue;
        }

        if (startTypes.has(e.eventType) && pauseStart) {
            const durationSec = Math.max(0, Math.round((e.timestamp.getTime() - pauseStart.getTime()) / 1000));
            if (durationSec >= 10) {
                pauses.push({
                    start: pauseStart,
                    end: e.timestamp,
                    durationSec,
                    lapLabel: findLapLabel(pauseStart.getTime()),
                });
            }
            pauseStart = null;
        }
    }

    if (pauses.length === 0) return '';

    const MICRO_PAUSE_LIMIT_SEC = 120;
    const microPauses = pauses.filter((p) => p.durationSec < MICRO_PAUSE_LIMIT_SEC);
    const longPauses = pauses.filter((p) => p.durationSec >= MICRO_PAUSE_LIMIT_SEC);

    const lines: string[] = ['### Pause Events (Timer Button)'];

    if (microPauses.length > 0) {
        const microTotalSec = microPauses.reduce((sum, p) => sum + p.durationSec, 0);
        lines.push('');
        lines.push(`Mikro megállások: ${microPauses.length} db (2 percnél rövidebb), összidő: ${formatSeconds(microTotalSec)}.`);
    }

    if (longPauses.length > 0) {
        lines.push('');
        lines.push('| Start | End | Duration | Lap |');
        lines.push('| :--- | :--- | ---: | ---: |');

        longPauses.forEach((p) => {
            const startSameDay = p.start.toLocaleDateString('hu-HU') === sessionDate;
            const endSameDay = p.end.toLocaleDateString('hu-HU') === sessionDate;
            const startStr = startSameDay ? p.start.toLocaleTimeString('hu-HU') : p.start.toLocaleString('hu-HU');
            const endStr = endSameDay ? p.end.toLocaleTimeString('hu-HU') : p.end.toLocaleString('hu-HU');
            lines.push(`| ${startStr} | ${endStr} | ${formatSeconds(p.durationSec)} | ${p.lapLabel} |`);
        });
    }

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public extract functions
// ---------------------------------------------------------------------------

export function extractSession(data: FitUploadResponse): string {
    const session = (data.messages['sessionMesgs'] as Record<string, unknown>[])?.[0];
    if (!session) return '';

    const rows: Array<[string, string]> = [];

    // Sport
    if (session['sportProfileName']) rows.push(['Sport profil', String(session['sportProfileName'])]);

    // Időpontok
    const startDate = toDate(session['startTime']);
    if (startDate) rows.push(['Kezdés', startDate.toLocaleString('hu-HU')]);
    const elapsed = typeof session['totalElapsedTime'] === 'number' ? session['totalElapsedTime'] as number : null;
    if (startDate && elapsed !== null) {
        const endDate = new Date(startDate.getTime() + elapsed * 1000);
        rows.push(['Befejezés', endDate.toLocaleString('hu-HU')]);
    }

    // Szintemelkedés / szintsullyedes
    if (typeof session['totalAscent'] === 'number') rows.push(['Össz. emelkedés', `${session['totalAscent']} m`]);
    if (typeof session['totalDescent'] === 'number') rows.push(['Össz. süllyedés', `${session['totalDescent']} m`]);

    // Kalória
    if (typeof session['totalCalories'] === 'number') rows.push(['Kalória', `${session['totalCalories']} kcal`]);
    if (typeof session['metabolicCalories'] === 'number') rows.push(['Metabolikus kalória', `${session['metabolicCalories']} kcal`]);

    // Heart rate (single compact line)
    const avgHeart = typeof session['avgHeartRate'] === 'number' ? String(session['avgHeartRate']) : '–';
    const maxHeart = typeof session['maxHeartRate'] === 'number' ? String(session['maxHeartRate']) : '–';
    if (avgHeart !== '–' || maxHeart !== '–') {
        rows.push(['Heart rate', `avg ${avgHeart}, max ${maxHeart} bpm`]);
    }

    // Cadence (single compact line)
    const avgCadenceVal = typeof session['avgRunningCadence'] === 'number'
        ? cadence(session['avgRunningCadence'])
        : (typeof session['avgCadence'] === 'number' ? cadence(session['avgCadence']) : '–');
    const maxCadenceVal = typeof session['maxRunningCadence'] === 'number'
        ? cadence(session['maxRunningCadence'])
        : (typeof session['maxCadence'] === 'number' ? cadence(session['maxCadence']) : '–');
    if (avgCadenceVal !== '–' || maxCadenceVal !== '–') {
        rows.push(['Cadence', `avg ${avgCadenceVal}, max ${maxCadenceVal} spm`]);
    }
    // Respiration (single compact line)
    const avgResp = typeof session['enhancedAvgRespirationRate'] === 'number'
        ? (session['enhancedAvgRespirationRate'] as number).toFixed(1)
        : '–';
    const maxResp = typeof session['enhancedMaxRespirationRate'] === 'number'
        ? (session['enhancedMaxRespirationRate'] as number).toFixed(1)
        : '–';
    const minResp = typeof session['enhancedMinRespirationRate'] === 'number'
        ? (session['enhancedMinRespirationRate'] as number).toFixed(1)
        : '–';
    if (avgResp !== '–' || maxResp !== '–' || minResp !== '–') {
        rows.push(['Respiration', `avg ${avgResp}, max ${maxResp}, min ${minResp} breaths/min`]);
    }

    // Running dynamics
    if (typeof session['avgStepLength'] === 'number') rows.push(['Avg. step length', `${stepLengthMm(session['avgStepLength'])} mm`]);
    if (typeof session['avgStanceTime'] === 'number') rows.push(['Avg. ground contact time', `${(session['avgStanceTime'] as number).toFixed(0)} ms`]);
    if (typeof session['avgStanceTimePercent'] === 'number') rows.push(['Ground contact time %', `${(session['avgStanceTimePercent'] as number).toFixed(1)} %`]);
    if (typeof session['avgStanceTimeBalance'] === 'number') rows.push(['Ground contact balance', `${(session['avgStanceTimeBalance'] as number).toFixed(1)} %`]);
    if (typeof session['avgVerticalRatio'] === 'number') rows.push(['Vertical ratio', `${(session['avgVerticalRatio'] as number).toFixed(1)} %`]);

    // Önértékelés
    if (typeof session['workoutFeel'] === 'number') {
        const feel = session['workoutFeel'] as number;
        rows.push(['Önértékelés/Közérzet', workoutFeelLabel(feel)]);
    }
    if (typeof session['workoutRpe'] === 'number') {
        const raw = session['workoutRpe'] as number;
        const rpeVal = Math.min(10, Math.max(1, Math.round(raw / 10)));
        rows.push(['Önértékelés/RPE', `${rpeVal}/10 - ${workoutRpeLabel(rpeVal)}`]);
    }

    // Edzésterhelés
    const aerobicTE = typeof session['totalTrainingEffect'] === 'number' ? session['totalTrainingEffect'] as number : null;
    const anaerobicTE = typeof session['totalAnaerobicTrainingEffect'] === 'number' ? session['totalAnaerobicTrainingEffect'] as number : null;
    rows.push(['Aerob edzéshatás', `${aerobicTE !== null ? aerobicTE.toFixed(1) + ' / 5.0 – ' + teLabel(aerobicTE) : '–'}`]);
    rows.push(['Anaerob edzéshatás', `${anaerobicTE !== null ? anaerobicTE.toFixed(1) + ' / 5.0 – ' + teLabel(anaerobicTE) : '–'}`]);
    if (typeof session['trainingStressScore'] === 'number') {
        rows.push(['Training Stress Score', `${(session['trainingStressScore'] / 10).toFixed(1)}`]);
    }
    if (typeof session['intensityFactor'] === 'number') {
        rows.push(['Intenzitás faktor', `${(session['intensityFactor'] / 1000).toFixed(2)}`]);
    }
    const trainingLoad = typeof session['trainingLoadPeak'] === 'number' ? session['trainingLoadPeak'] as number : null;
    if (trainingLoad !== null && trainingLoad !== 0) {
        rows.push(['Edzésterhelés (peak)', `${trainingLoad.toFixed(1)}`]);
    }

    // Séta / futás / állás idők a splitSummaryMesgs-ből
    const summaries = data.messages['splitSummaryMesgs'] as Record<string, unknown>[] | undefined;
    if (summaries && summaries.length > 0) {
        const rwdTypes: Record<string, string> = { rwdRun: 'Futás idő', rwdWalk: 'Séta idő', rwdStand: 'Állás idő' };
        for (const [key, label] of Object.entries(rwdTypes)) {
            const entry = summaries.find(s => String(s['splitType']) === key);
            if (entry && typeof entry['totalTimerTime'] === 'number') {
                rows.push([label, formatSeconds(entry['totalTimerTime'] as number)]);
            }
        }
    }

    // Edzés neve és leírása (workoutMesgs)
    const workoutMesgs = data.messages['workoutMesgs'] as Record<string, unknown>[] | undefined;
    const workout = workoutMesgs?.[0];
    if (workout) {
        const wktNameArr = Array.isArray(workout['wktName']) ? (workout['wktName'] as unknown[]).filter(s => typeof s === 'string' && (s as string).trim()) : null;
        const wktName = wktNameArr && wktNameArr.length > 0 ? (wktNameArr as string[]).join(' ') : (typeof workout['wktName'] === 'string' ? workout['wktName'] : '');
        if (wktName) rows.push(['Edzés neve', wktName]);
        if (typeof workout['numValidSteps'] === 'number') rows.push(['workout steps', String(workout['numValidSteps'])]);
    }

    const lines: string[] = ['## Edzés összefoglaló', '', buildKeyValueLines(rows)];

    // Edzéslépések (workoutStepMesgs)
    const visibleSteps = getVisibleWorkoutSteps(data);
    if (visibleSteps.length > 0) {
        lines.push('');
        lines.push('### Edzéslépések');
        for (let i = 0; i < visibleSteps.length; i++) {
            const step = visibleSteps[i];
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
            } else if (targetType && targetType.toLowerCase() !== 'open') {
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

    return lines.join('\n');
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
            if (currentActive) {
                paired.push({ single: currentActive['active'] as Record<string, unknown> });
            }
            currentActive = { active: split };
        } else if (type === 'intervalRest' && currentActive) {
            paired.push({ active: currentActive['active'], rest: split });
            currentActive = null;
        } else {
            if (currentActive) {
                paired.push({ single: currentActive['active'] as Record<string, unknown> });
                currentActive = null;
            }
            paired.push({ single: split });
        }
    }

    if (currentActive) {
        paired.push({ single: currentActive['active'] as Record<string, unknown> });
    }

    const header = ['Idő', 'Típus', 'Táv (km)', 'Pace (min/km)', 'Emelkedés (m)', 'Süllyedés (m)'];

    const blockCount = filtered.filter(s => String(s['splitType']) === 'intervalActive').length;
    const rows = paired.map((block) => {
        if ('active' in block && 'rest' in block) {
            const a = block['active'] as Record<string, unknown>;
            const r = block['rest'] as Record<string, unknown>;
            const activeSecs = splitTimeSeconds(a);
            const restSecs = splitTimeSeconds(r);
            const activeTime = typeof activeSecs === 'number' ? formatSeconds(activeSecs) : '–';
            const restTime = typeof restSecs === 'number' ? formatSeconds(restSecs) : '–';

            return [
                `${activeTime} + ${restTime}`,
                'Intervallum',
                `${km(a['totalDistance'])} / ${km(r['totalDistance'])}`,
                paceFromTimeDistance(activeSecs, a['totalDistance']),
                num(a['totalAscent'], 0),
                num(a['totalDescent'], 0),
            ];
        }

        const split = block['single'] as Record<string, unknown>;
        const type = String(split['splitType'] ?? '');
        const label = SPLIT_TYPE_HU[type] ?? type;
        const secs = splitTimeSeconds(split);

        return [
            typeof secs === 'number' ? formatSeconds(secs) : '–',
            label,
            km(split['totalDistance']),
            paceFromTimeDistance(secs, split['totalDistance']),
            num(split['totalAscent'], 0),
            num(split['totalDescent'], 0),
        ];
    });

    const headerTitle = blockCount > 1
        ? `### Intervallumok - **${blockCount} blokk**`
        : '### Intervallumok';

    const firstPlannedDuration = firstPlannedStepDurationBeforeCooldown(data);
    const activeSplits = filtered.filter((s) => String(s['splitType']) === 'intervalActive');
    const cooldownSplits = filtered.filter((s) => String(s['splitType']) === 'intervalCooldown');
    const firstActiveSeconds = activeSplits.length > 0
        ? splitTimeSeconds(activeSplits[0] as Record<string, unknown>)
        : null;
    const firstBlock = paired[0] as Record<string, unknown> | undefined;
    const firstDisplayedSeconds = firstBlock
        ? ('active' in firstBlock && firstBlock['active']
            ? splitTimeSeconds(firstBlock['active'] as Record<string, unknown>)
            : 'single' in firstBlock
                ? splitTimeSeconds(firstBlock['single'] as Record<string, unknown>)
                : null)
        : null;
    const isSimpleSingleIntervalCase =
        activeSplits.length === 1 &&
        cooldownSplits.length <= 1 &&
        typeof firstPlannedDuration === 'number' &&
        typeof firstActiveSeconds === 'number' &&
        firstActiveSeconds <= firstPlannedDuration;
    const shouldShowSplitHint =
        typeof firstPlannedDuration === 'number' &&
        typeof firstDisplayedSeconds === 'number' &&
        firstDisplayedSeconds < firstPlannedDuration &&
        !isSimpleSingleIntervalCase;

    const visibleWorkoutSteps = getVisibleWorkoutSteps(data);
    const shouldHideIntervals = filtered.length === 2 && visibleWorkoutSteps.length === 1;

    const lines: string[] = [];
    if (!shouldHideIntervals) {
        lines.push(
            headerTitle,
            '',
            ...(shouldShowSplitHint
                ? [
                    '_Megjegyzés: ha az első szakasz rövidebb a tervezettnél, ez jellemzően abból adódik, hogy futás közben a kör gombbal jelölés/szakaszbontás történt, ezért az első rész több szakaszra tagolódott._',
                    '',
                ]
                : []),
            `| ${header.join(' | ')} |`,
            `| ---: | :--- | ---: | ---: | ---: | ---: |`,
            ...rows.map(r => `| ${r.join(' | ')} |`),
        );
    }

    const shouldShowIntervalSummary = visibleWorkoutSteps.length > 1;
    if (shouldShowIntervalSummary && summaries && summaries.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('### Intervallum összefoglalók');
        lines.push('');
        const summaryHeader = ['Típus', 'Darab', 'Össz táv (km)', 'Össz idő'];
        const summaryRows: string[][] = [];
        for (const s of summaries) {
            const type = String(s['splitType'] ?? '');
            if (!INTERVAL_TYPES.has(type)) continue;
            const label = SPLIT_TYPE_HU[type] ?? type;
            const count = typeof s['numSplits'] === 'number' ? String(s['numSplits']) : '–';
            const dist = km(s['totalDistance']);
            const timeSecs = splitTimeSeconds(s);
            const time = typeof timeSecs === 'number' ? formatSeconds(timeSecs) : '–';
            summaryRows.push([label, count, dist, time]);
        }
        lines.push(`| ${summaryHeader.join(' | ')} |`);
        lines.push(`| :--- | ---: | ---: | ---: |`);
        summaryRows.forEach(r => lines.push(`| ${r.join(' | ')} |`));
    }

    const pauseText = extractPauseEvents(data);
    if (pauseText) {
        if (lines.length > 0) lines.push('');
        lines.push(pauseText);
    }

    const stopsText = extractStops(data, splits);
    if (stopsText) {
        if (lines.length > 0) lines.push('');
        lines.push(stopsText);
    }

    const slowText = extractSlowSegments(data, splits);
    if (slowText) {
        if (lines.length > 0) lines.push('');
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
        `${i + 1}`,
        km(lap['totalDistance']),
        paceFromTimeDistance(lap['totalElapsedTime'], lap['totalDistance']),
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
        '## Körök',
        'nem feltétlenül egységes km-ek',
        '',
        `| ${header.join(' | ')} |`,
        `| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
        ...rows.map(r => `| ${r.join(' | ')} |`),
    ];
    return lines.join('\n');
}

export function extractUserProfile(data: FitUploadResponse): string {
    const profile = (data.messages['userProfileMesgs'] as Record<string, unknown>[])?.[0];
    if (!profile) return '';

    const sleepSec = typeof profile['sleepTime'] === 'number' ? profile['sleepTime'] as number : null;
    const wakeSec  = typeof profile['wakeTime']  === 'number' ? profile['wakeTime']  as number : null;
    
    const rows: Array<[string, string]> = [];
    
    if (typeof profile['weight'] === 'number') {
        rows.push(['Súly', `${profile['weight']} kg`]);
    }
    if (typeof profile['height'] === 'number') {
        rows.push(['Magasság', `${profile['height']} m`]);
    }
    
    rows.push(['Elalvás időpontja', secondsToHHMM(profile['sleepTime'])]);
    
    let wakeTimeStr = secondsToHHMM(profile['wakeTime']);
    if (sleepSec !== null && wakeSec !== null) {
        const DAY = 24 * 3600;
        const dur = ((wakeSec - sleepSec) + DAY) % DAY;
        const dh = Math.floor(dur / 3600);
        const dm = Math.floor((dur % 3600) / 60);
        wakeTimeStr += ` (${dh} ó ${String(dm).padStart(2, '0')} p)`;
    }
    rows.push(['Ébredési idő', wakeTimeStr]);

    return ['## Felhasználói profil', '', buildKeyValueLines(rows)].join('\n');
}

function extractTrailClimbInfo(data: FitUploadResponse): string {
    const session = (data.messages['sessionMesgs'] as Record<string, unknown>[])?.[0]
    if (!session) return ''

    const sport = String(session['sport'] ?? '').toLowerCase()
    const subSport = String(session['subSport'] ?? '').toLowerCase()
    const isTrail = sport === 'running' && (subSport === 'trail' || subSport.includes('trail'))
    if (!isTrail) return ''

    const sessionDate = toDate(session['startTime'])?.toLocaleDateString('hu-HU')

    const blocks: string[] = []

    const summaries = data.messages['splitSummaryMesgs'] as Record<string, unknown>[] | undefined
    if (summaries && summaries.length > 0) {
        const ascent = summaries.find((s) => String(s['splitType']) === 'ascentSplit')
        const descent = summaries.find((s) => String(s['splitType']) === 'descentSplit')

        if (ascent || descent) {
            const rows: string[] = [
                '## Climb összefoglaló',
                '',
                '| Típus | Darab | Táv (km) | Szint (m) | Idő |',
                '| :--- | ---: | ---: | ---: | ---: |',
            ]
            if (ascent) {
                const count = typeof ascent['numSplits'] === 'number' ? ascent['numSplits'] : '–'
                const dist = km(ascent['totalDistance'])
                const gain = num(ascent['totalAscent'], 0)
                const time = typeof ascent['totalTimerTime'] === 'number' ? formatSeconds(ascent['totalTimerTime'] as number) : '–'
                rows.push(`| Emelkedő | ${count} | ${dist} | +${gain} | ${time} |`)
            }
            if (descent) {
                const count = typeof descent['numSplits'] === 'number' ? descent['numSplits'] : '–'
                const dist = km(descent['totalDistance'])
                const loss = num(descent['totalDescent'], 0)
                const time = typeof descent['totalTimerTime'] === 'number' ? formatSeconds(descent['totalTimerTime'] as number) : '–'
                rows.push(`| Lejtő | ${count} | ${dist} | -${loss} | ${time} |`)
            }
            blocks.push(rows.join('\n'))
        }
    }

    const climbPro = data.messages['climbProMesgs'] as Record<string, unknown>[] | undefined
    if (climbPro && climbPro.length > 0) {
        const sorted = climbPro
            .slice()
            .sort((a, b) => {
                const ta = toDate(a['timestamp'])?.getTime() ?? 0
                const tb = toDate(b['timestamp'])?.getTime() ?? 0
                return ta - tb
            })

        // Group by climbNumber, keeping start and complete events separately
        const climbMap = new Map<number | string, { start?: Record<string, unknown>; complete?: Record<string, unknown> }>()
        for (const item of sorted) {
            const climbNo = typeof item['climbNumber'] === 'number' ? item['climbNumber'] : String(item['climbNumber'] ?? '–')
            const event = typeof item['climbProEvent'] === 'string' ? item['climbProEvent'] : ''
            if (!climbMap.has(climbNo)) climbMap.set(climbNo, {})
            const entry = climbMap.get(climbNo)!
            if (event === 'start') entry.start = item
            else if (event === 'complete') entry.complete = item
        }

        const climbEntries = [...climbMap.entries()]

        const records = (data.messages['recordMesgs'] as Record<string, unknown>[] | undefined)
            ?.map((r) => {
                const ts = toDate(r['timestamp'])?.getTime()
                const alt = typeof r['enhancedAltitude'] === 'number' ? (r['enhancedAltitude'] as number) : null
                return typeof ts === 'number' && alt !== null ? { ts, alt } : null
            })
            .filter((r): r is { ts: number; alt: number } => r !== null)
            .sort((a, b) => a.ts - b.ts) ?? []

        const rows: string[] = [
            `## ClimbPro`,
            '',
            '| Start | Duration | Ascent (m) | Length (km) |',
            '| :--- | ---: | ---: | ---: |',
        ]

        const formatTime = (item: Record<string, unknown> | undefined): string => {
            if (!item) return '–'
            const ts = toDate(item['timestamp'])
            if (!ts) return '–'
            const tsDate = ts.toLocaleDateString('hu-HU')
            return tsDate === sessionDate ? ts.toLocaleTimeString('hu-HU') : ts.toLocaleString('hu-HU')
        }

        const ascentBetween = (startTs: number | null, endTs: number | null): string => {
            if (startTs === null || endTs === null || endTs < startTs || records.length === 0) return '–'
            let prevAlt: number | null = null
            let ascent = 0
            for (const rec of records) {
                if (rec.ts < startTs) continue
                if (rec.ts > endTs) break
                if (prevAlt !== null && rec.alt > prevAlt) {
                    ascent += rec.alt - prevAlt
                }
                prevAlt = rec.alt
            }
            return prevAlt === null ? '–' : num(ascent, 0)
        }

        for (const [, { start, complete }] of climbEntries) {
            const startTime = formatTime(start)
            const startTs = toDate(start?.['timestamp'])?.getTime() ?? null
            const completeTs = toDate(complete?.['timestamp'])?.getTime() ?? null
            const duration = startTs !== null && completeTs !== null && completeTs >= startTs
                ? formatSeconds((completeTs - startTs) / 1000)
                : '–'
            const ascent = ascentBetween(startTs, completeTs)
            const startDist = start && typeof start['currentDist'] === 'number' ? (start['currentDist'] as number) : null
            const completeDist = complete && typeof complete['currentDist'] === 'number' ? (complete['currentDist'] as number) : null
            const length = startDist !== null && completeDist !== null ? km(completeDist - startDist) : '–'
            rows.push(`| ${startTime} | ${duration} | ${ascent} | ${length} |`)
        }
        blocks.push(rows.join('\n'))
    }

    return blocks.length > 0 ? blocks.join('\n\n') : ''
}
