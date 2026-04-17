import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface TrainingPeaksComment {
    text: string
    date?: string
    user?: string
}

export interface TrainingPeaksWorkoutInput {
    rowKey?: string
    name?: string
    workoutStart?: string
    workout_start?: string
    date?: string
    workoutType?: string
    totalTime?: string
    distance?: string
    /** @deprecated Küldj tssValue + tssUnit mezőket helyette */
    tss?: string
    tssValue?: string
    tssUnit?: string
    plannedTssValue?: string
    plannedTssUnit?: string
    description?: string
    comments?: (string | TrainingPeaksComment)[]
    raw?: Record<string, unknown>
}

interface NormalizedWorkout {
    rowKey: string
    name: string
    workoutStart: string
    workoutType: string
    totalTime: string
    distance: string
    tssValue: string
    tssUnit: string
    workoutId: string
    filePath: string
}

function nowIso(): string {
    return new Date().toISOString()
}

function parseTss(item: TrainingPeaksWorkoutInput): { tssValue: string; tssUnit: string } {
    if (item.tssValue !== undefined || item.tssUnit !== undefined) {
        return {
            tssValue: String(item.tssValue ?? '').trim(),
            tssUnit: String(item.tssUnit ?? '').trim(),
        }
    }
    const combined = String(item.tss ?? '').trim()
    const match = combined.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)/)
    if (match) {
        return { tssValue: match[1], tssUnit: match[2] }
    }
    return { tssValue: combined, tssUnit: '' }
}

function parsePlannedTss(item: TrainingPeaksWorkoutInput): { plannedTssValue: string; plannedTssUnit: string } {
    return {
        plannedTssValue: String(item.plannedTssValue ?? '').trim(),
        plannedTssUnit: String(item.plannedTssUnit ?? '').trim(),
    }
}

// workoutStart formátumok: "5/4/26" (D/M/YY), "5/4/2026", "2026-04-05", "2026-04-05T16:54:49",
// illetve timezone-os ISO változatok. A tárolási útvonal mindig csak nap szintig megy.
function workoutStartToFolderParts(workoutStart: string): { yearMonth: string; day: string } | null {
    const value = String(workoutStart ?? '').trim()
    const isoDateMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/)
    if (isoDateMatch) {
        return {
            yearMonth: `${isoDateMatch[1]}-${isoDateMatch[2]}`,
            day: isoDateMatch[3],
        }
    }

    const slashDateMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
    if (!slashDateMatch) return null
    const day = slashDateMatch[1].padStart(2, '0')
    const month = slashDateMatch[2].padStart(2, '0')
    let year = Number(slashDateMatch[3])
    if (year < 100) year += 2000
    return { yearMonth: `${year}-${month}`, day }
}

function normalizeComments(raw: TrainingPeaksWorkoutInput['comments']): TrainingPeaksComment[] {
    if (!Array.isArray(raw)) return []
    const mapped = raw.map((c) => {
        if (typeof c === 'string') return { text: c, date: '', user: '' }
        const comment = c as TrainingPeaksComment & { author?: string; dateTime?: string }
        return {
            text: String(comment.text ?? ''),
            date: comment.date
                ? String(comment.date)
                : comment.dateTime
                  ? String(comment.dateTime)
                  : '',
            user: comment.user
                ? String(comment.user)
                : comment.author
                  ? String(comment.author)
                  : '',
        }
    })

    return mapped.filter((c) => {
        const text = String(c.text ?? '').trim()
        if (!text) return false
        if (/^has comments$/i.test(text)) return false
        return true
    })
}

// Csak a rowKey-t vonja ki – lightweight check-ekhez (nincs workoutId szükséges)
function extractRowKey(item: TrainingPeaksWorkoutInput): string | null {
    return String(item.rowKey ?? '').trim() || null
}

function rowKeyToWorkoutDay(rowKey: string): string {
    const idx = rowKey.indexOf('_')
    return idx >= 0 ? rowKey.slice(0, idx).trim() : rowKey.trim()
}

// Lokális ISO datetime stringet ms-be alakítja (éjfél = T00:00:00).
function localIsoToMs(isoStr: string): number | null {
    const m = isoStr.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/)
    if (!m) return null
    return new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4] ?? 0),
        Number(m[5] ?? 0),
        Number(m[6] ?? 0),
    ).getTime()
}

function msToLocalIso(ms: number): string {
    const d = new Date(ms)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function normalizeWorkoutStartDateTime(value: string): string | null {
    const input = String(value ?? '').trim()
    if (!input) return null

    // Már pontos datetime esetén megtartjuk az eredeti értéket.
    if (/^\d{4}-\d{2}-\d{2}T/.test(input)) {
        return input
    }

    // ISO dátum -> éjfélre normalizált datetime.
    const isoDateMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (isoDateMatch) {
        return `${isoDateMatch[1]}-${isoDateMatch[2]}-${isoDateMatch[3]}T00:00:00`
    }

    // D/M/YY vagy D/M/YYYY -> ISO datetime 00:00:00.
    const slashDateMatch = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
    if (slashDateMatch) {
        const day = slashDateMatch[1].padStart(2, '0')
        const month = slashDateMatch[2].padStart(2, '0')
        let year = Number(slashDateMatch[3])
        if (year < 100) year += 2000
        return `${year}-${month}-${day}T00:00:00`
    }

    return null
}

// Teljes normalizálás – csak akkor fut, ha workoutId is megvan
function normalizeWorkout(item: TrainingPeaksWorkoutInput): NormalizedWorkout | null {
    const rowKey = extractRowKey(item)
    const name = String(item.name ?? '').trim()
    const workoutStart = String(item.workoutStart ?? item.workout_start ?? item.date ?? '').trim()
    const workoutId = String((item.raw as Record<string, unknown> | null | undefined)?.workoutId ?? '').trim()

    if (!rowKey || !name || !workoutStart || !workoutId) return null

    const { tssValue, tssUnit } = parseTss(item)

    const workoutDayFromRowKey = rowKeyToWorkoutDay(rowKey)
    const normalizedWorkoutStart =
        normalizeWorkoutStartDateTime(workoutStart) ??
        normalizeWorkoutStartDateTime(workoutDayFromRowKey) ??
        workoutStart
    const filePath = buildRelativeWorkoutPath(normalizedWorkoutStart, workoutId)

    return {
        rowKey,
        name,
        workoutStart: normalizedWorkoutStart,
        workoutType: String(item.workoutType ?? '').trim(),
        totalTime: String(item.totalTime ?? '').trim(),
        distance: String(item.distance ?? '').trim(),
        tssValue,
        tssUnit,
        workoutId,
        filePath,
    }
}

function buildRelativeWorkoutPath(workoutStart: string, workoutId: string): string {
    const folderParts = workoutStartToFolderParts(workoutStart)
    return folderParts
        ? join('TrainingPeaks', folderParts.yearMonth, folderParts.day, `${workoutId}.json`)
        : join('TrainingPeaks', `${workoutId}.json`)
}

function buildFullJson(item: TrainingPeaksWorkoutInput, normalized: NormalizedWorkout): Record<string, unknown> {
    const { plannedTssValue, plannedTssUnit } = parsePlannedTss(item)

    return {
        rowKey: normalized.rowKey,
        workoutId: normalized.workoutId,
        name: normalized.name,
        workoutStart: normalized.workoutStart,
        workoutType: normalized.workoutType,
        totalTime: normalized.totalTime,
        distance: normalized.distance,
        tssValue: normalized.tssValue,
        tssUnit: normalized.tssUnit,
        plannedTssValue,
        plannedTssUnit,
        description: String(item.description ?? '').trim(),
        comments: normalizeComments(item.comments),
        source: 'trainingpeaks',
    }
}

export function createTrainingPeaksWorkoutStore(dbFilePath: string, dataDir: string) {
    mkdirSync(dirname(dbFilePath), { recursive: true })

    const db = new Database(dbFilePath)

    const schemaSql = `
        CREATE TABLE IF NOT EXISTS trainingpeaks_workouts (
            row_key TEXT NOT NULL PRIMARY KEY,
            workout_id TEXT NOT NULL,
            name TEXT NOT NULL,
            workout_start TEXT NOT NULL,
            workout_type TEXT NOT NULL DEFAULT '',
            total_time TEXT NOT NULL DEFAULT '',
            distance TEXT NOT NULL DEFAULT '',
            tss_value TEXT NOT NULL DEFAULT '',
            tss_unit TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tp_workouts_start ON trainingpeaks_workouts(workout_start);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tp_workouts_workout_id ON trainingpeaks_workouts(workout_id);
    `
    db.exec(schemaSql)

    // Migráció: garmin_activity_id oszlop hozzáadása, ha még nem létezik.
    try {
        db.exec(`ALTER TABLE trainingpeaks_workouts ADD COLUMN garmin_activity_id TEXT NOT NULL DEFAULT ''`)
    } catch {
        // Már létezik – rendben.
    }

    // Migráció: legacy workout_start értékek normalizálása ISO datetime-re,
    // mert a Garmin-TP párosítás ±másodperc tartományban datetime mezőre keres.
    try {
        const legacyRows = db.prepare(`
            SELECT row_key, workout_start FROM trainingpeaks_workouts
            WHERE workout_start NOT LIKE '____-__-__T__:%'
        `).all() as Array<{ row_key: string; workout_start: string }>

        let normalizedCount = 0
        const updateWorkoutStartStmt = db.prepare(`
            UPDATE trainingpeaks_workouts
            SET workout_start = ?, updated_at = ?
            WHERE row_key = ?
        `)

        db.exec('BEGIN')
        try {
            for (const row of legacyRows) {
                const normalized =
                    normalizeWorkoutStartDateTime(row.workout_start) ??
                    normalizeWorkoutStartDateTime(rowKeyToWorkoutDay(row.row_key))
                if (!normalized) continue

                updateWorkoutStartStmt.run(normalized, nowIso(), row.row_key)
                normalizedCount += 1
            }
            db.exec('COMMIT')
        } catch (err) {
            db.exec('ROLLBACK')
            throw err
        }

        if (normalizedCount > 0) {
            console.log(`[trainingpeaks-migration] ${normalizedCount}/${legacyRows.length} workout_start mező normalizálva`)
        }
    } catch (err) {
        console.error('[trainingpeaks-migration] Hiba workout_start normalizálás közben:', err)
    }

    const selectByRowKeyStmt = db.prepare(`
        SELECT row_key FROM trainingpeaks_workouts WHERE row_key = ? LIMIT 1
    `)

    const selectByWorkoutIdStmt = db.prepare(`
        SELECT row_key, workout_start, workout_id FROM trainingpeaks_workouts WHERE workout_id = ? LIMIT 1
    `)

    const deleteByRowKeyStmt = db.prepare(`DELETE FROM trainingpeaks_workouts WHERE row_key = ?`)

    const insertStmt = db.prepare(`
        INSERT INTO trainingpeaks_workouts
            (row_key, workout_id, name, workout_start, workout_type,
             total_time, distance, tss_value, tss_unit, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const updateStmt = db.prepare(`
        UPDATE trainingpeaks_workouts
        SET workout_id = ?, name = ?, workout_start = ?, workout_type = ?,
            total_time = ?, distance = ?, tss_value = ?, tss_unit = ?, updated_at = ?
        WHERE row_key = ?
    `)

    function saveJsonFile(item: TrainingPeaksWorkoutInput, normalized: NormalizedWorkout): void {
        const absPath = join(dataDir, normalized.filePath)
        mkdirSync(dirname(absPath), { recursive: true })
        writeFileSync(absPath, JSON.stringify(buildFullJson(item, normalized), null, 2), 'utf-8')
    }

    return {
        upsertWorkouts(items: TrainingPeaksWorkoutInput[]) {
            let inserted = 0
            let updated = 0

            const pairs = items
                .map((item) => ({ item, normalized: normalizeWorkout(item) }))
                .filter((p): p is { item: TrainingPeaksWorkoutInput; normalized: NormalizedWorkout } =>
                    p.normalized !== null,
                )

            const timestamp = nowIso()

            db.exec('BEGIN')
            try {
                for (const { item, normalized } of pairs) {
                    const existingByWorkoutId = selectByWorkoutIdStmt.get(normalized.workoutId) as
                        | { row_key: string; workout_start: string; workout_id: string }
                        | undefined

                    if (existingByWorkoutId && existingByWorkoutId.row_key !== normalized.rowKey) {
                        deleteByRowKeyStmt.run(existingByWorkoutId.row_key)

                        const previousPath = buildRelativeWorkoutPath(
                            existingByWorkoutId.workout_start,
                            existingByWorkoutId.workout_id,
                        )
                        if (previousPath && previousPath !== normalized.filePath) {
                            const staleFilePath = join(dataDir, previousPath)
                            if (existsSync(staleFilePath)) {
                                rmSync(staleFilePath, { force: true })
                            }
                        }
                    }

                    saveJsonFile(item, normalized)

                    const existing = selectByRowKeyStmt.get(normalized.rowKey)
                    if (!existing) {
                        insertStmt.run(
                            normalized.rowKey, normalized.workoutId, normalized.name,
                            normalized.workoutStart, normalized.workoutType,
                            normalized.totalTime, normalized.distance,
                            normalized.tssValue, normalized.tssUnit,
                            timestamp, timestamp,
                        )
                        console.info('[trainingpeaks] uj workout erkezett', {
                            rowKey: normalized.rowKey,
                            workoutId: normalized.workoutId,
                            name: normalized.name,
                            filePath: normalized.filePath,
                        })
                        inserted += 1
                        continue
                    }

                    updateStmt.run(
                        normalized.workoutId, normalized.name,
                        normalized.workoutStart, normalized.workoutType,
                        normalized.totalTime, normalized.distance,
                        normalized.tssValue, normalized.tssUnit,
                        timestamp,
                        normalized.rowKey,
                    )
                    updated += 1
                }

                db.exec('COMMIT')
            } catch (err) {
                db.exec('ROLLBACK')
                throw err
            }

            return { received: pairs.length, inserted, updated }
        },

        getNewWorkoutKeys(items: TrainingPeaksWorkoutInput[]) {
            const newWorkoutKeys: string[] = []
            for (const item of items) {
                const rowKey = extractRowKey(item)
                if (!rowKey) continue
                if (!selectByRowKeyStmt.get(rowKey)) {
                    newWorkoutKeys.push(rowKey)
                }
            }
            return { received: items.length, newWorkoutKeys }
        },

        getAllForCleanup(): Array<{ rowKey: string; filePath: string }> {
            const rows = db.prepare(`
                SELECT row_key, workout_start, workout_id FROM trainingpeaks_workouts
            `).all() as Array<{ row_key: string; workout_start: string; workout_id: string }>
            return rows.map((r) => ({
                rowKey: r.row_key,
                filePath: buildRelativeWorkoutPath(r.workout_start, r.workout_id),
            }))
        },

        getAllForMaintenance(): Array<{ rowKey: string; workoutId: string; workoutStart: string; filePath: string }> {
            const rows = db.prepare(`
                SELECT row_key, workout_id, workout_start
                FROM trainingpeaks_workouts
            `).all() as Array<{
                row_key: string
                workout_id: string
                workout_start: string
            }>

            return rows.map((r) => ({
                rowKey: r.row_key,
                workoutId: r.workout_id,
                workoutStart: r.workout_start,
                filePath: buildRelativeWorkoutPath(r.workout_start, r.workout_id),
            }))
        },

        updateRecordLocation(rowKey: string, workoutStart: string, filePath: string) {
            db.prepare(`
                UPDATE trainingpeaks_workouts
                SET workout_start = ?, updated_at = ?
                WHERE row_key = ?
            `).run(workoutStart, nowIso(), rowKey)
        },

        deleteByRowKeys(rowKeys: string[]): number {
            if (rowKeys.length === 0) return 0
            const del = db.prepare(`DELETE FROM trainingpeaks_workouts WHERE row_key = ?`)
            db.exec('BEGIN')
            try {
                for (const k of rowKeys) del.run(k)
                db.exec('COMMIT')
            } catch (err) {
                db.exec('ROLLBACK')
                throw err
            }
            return rowKeys.length
        },

        resetTables() {
            db.exec(`
                DROP INDEX IF EXISTS idx_tp_workouts_workout_id;
                DROP INDEX IF EXISTS idx_tp_workouts_start;
                DROP TABLE IF EXISTS trainingpeaks_workouts;
            `)
            db.exec(schemaSql)
            return { ok: true, resetAt: nowIso() }
        },

        /**
         * Garmin FIT startTime alapján megkeresi a legközelebbi TP edzést (±toleranceSec másodpercen belül).
         * Visszaadja a JSON fájl tartalmát, ha van egyezés.
         */
        findByDateTimeNear(
            isoDateTime: string,
            toleranceSec = 60,
        ): { workoutId: string; filePath: string; fileContent: Record<string, unknown> } | null {
            const refMs = localIsoToMs(isoDateTime)
            if (refMs === null) return null

            const lower = msToLocalIso(refMs - toleranceSec * 1000)
            const upper = msToLocalIso(refMs + toleranceSec * 1000)

            const rows = db.prepare(`
                SELECT workout_id, workout_start
                FROM trainingpeaks_workouts
                WHERE workout_start >= ? AND workout_start <= ?
            `).all(lower, upper) as Array<{ workout_id: string; workout_start: string }>

            if (rows.length === 0) return null

            // Legközelebbi kiválasztása
            let best = rows[0]
            let bestDiff = Math.abs((localIsoToMs(best.workout_start) ?? Infinity) - refMs)
            for (const row of rows.slice(1)) {
                const diff = Math.abs((localIsoToMs(row.workout_start) ?? Infinity) - refMs)
                if (diff < bestDiff) { best = row; bestDiff = diff }
            }

            const filePath = buildRelativeWorkoutPath(best.workout_start, best.workout_id)
            const absPath = join(dataDir, filePath)
            if (!existsSync(absPath)) return null

            try {
                const fileContent = JSON.parse(readFileSync(absPath, 'utf-8')) as Record<string, unknown>
                return { workoutId: best.workout_id, filePath, fileContent }
            } catch {
                return null
            }
        },

        /**
         * Bejegyzi a Garmin aktivitás ID-t a TP rekordhoz (DB + JSON fájl).
         */
        linkGarminActivity(workoutId: string, garminActivityId: string): boolean {
            const row = db.prepare(
                `SELECT row_key, workout_start FROM trainingpeaks_workouts WHERE workout_id = ? LIMIT 1`,
            ).get(workoutId) as { row_key: string; workout_start: string } | undefined
            if (!row) return false

            db.prepare(
                `UPDATE trainingpeaks_workouts SET garmin_activity_id = ?, updated_at = ? WHERE workout_id = ?`,
            ).run(garminActivityId, nowIso(), workoutId)

            const filePath = buildRelativeWorkoutPath(row.workout_start, workoutId)
            const absPath = join(dataDir, filePath)
            if (existsSync(absPath)) {
                try {
                    const content = JSON.parse(readFileSync(absPath, 'utf-8')) as Record<string, unknown>
                    content.garminActivityId = garminActivityId
                    writeFileSync(absPath, JSON.stringify(content, null, 2), 'utf-8')
                } catch {
                    // Nem kritikus: DB frissítés megtörtént.
                }
            }

            return true
        },

        getByWorkoutId(workoutId: string): {
            rowKey: string
            workoutId: string
            workoutStart: string
            garminActivityId: string
            filePath: string
            fileContent: Record<string, unknown> | null
        } | null {
            const row = db.prepare(
                `SELECT row_key, workout_start, garmin_activity_id FROM trainingpeaks_workouts WHERE workout_id = ? LIMIT 1`,
            ).get(workoutId) as
                | { row_key: string; workout_start: string; garmin_activity_id: string }
                | undefined

            if (!row) return null

            const filePath = buildRelativeWorkoutPath(row.workout_start, workoutId)
            const absPath = join(dataDir, filePath)
            let fileContent: Record<string, unknown> | null = null
            if (existsSync(absPath)) {
                try {
                    fileContent = JSON.parse(readFileSync(absPath, 'utf-8')) as Record<string, unknown>
                } catch {
                    fileContent = null
                }
            }

            return {
                rowKey: row.row_key,
                workoutId,
                workoutStart: row.workout_start,
                garminActivityId: String(row.garmin_activity_id ?? '').trim(),
                filePath,
                fileContent,
            }
        },
    }
}


