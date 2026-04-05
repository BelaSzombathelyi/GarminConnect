import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface TrainingPeaksComment {
    text: string
    dateTime?: string
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
    description?: string
    comments?: (string | TrainingPeaksComment)[]
    source?: string
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
    source: string
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

// workoutStart formátumok: "5/4/26" (D/M/YY), "5/4/2026" → "2026-04/05"
function workoutStartToFolderParts(workoutStart: string): { yearMonth: string; day: string } | null {
    const match = workoutStart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
    if (!match) return null
    const day = match[1].padStart(2, '0')
    const month = match[2].padStart(2, '0')
    let year = Number(match[3])
    if (year < 100) year += 2000
    return { yearMonth: `${year}-${month}`, day }
}

function normalizeComments(raw: TrainingPeaksWorkoutInput['comments']): TrainingPeaksComment[] {
    if (!Array.isArray(raw)) return []
    return raw.map((c) => {
        if (typeof c === 'string') return { text: c, dateTime: '', user: '' }
        const comment = c as TrainingPeaksComment & { author?: string; date?: string }
        return {
            text: String(comment.text ?? ''),
            dateTime: comment.dateTime
                ? String(comment.dateTime)
                : comment.date
                  ? String(comment.date)
                  : '',
            user: comment.user
                ? String(comment.user)
                : comment.author
                  ? String(comment.author)
                  : '',
        }
    })
}

// Csak a rowKey-t vonja ki – lightweight check-ekhez (nincs workoutId szükséges)
function extractRowKey(item: TrainingPeaksWorkoutInput): string | null {
    return String(item.rowKey ?? '').trim() || null
}

// Teljes normalizálás – csak akkor fut, ha workoutId is megvan
function normalizeWorkout(item: TrainingPeaksWorkoutInput): NormalizedWorkout | null {
    const rowKey = extractRowKey(item)
    const name = String(item.name ?? '').trim()
    const workoutStart = String(item.workoutStart ?? item.workout_start ?? item.date ?? '').trim()
    const workoutId = String((item.raw as Record<string, unknown> | null | undefined)?.workoutId ?? '').trim()

    if (!rowKey || !name || !workoutStart || !workoutId) return null

    const { tssValue, tssUnit } = parseTss(item)

    const folderParts = workoutStartToFolderParts(workoutStart)
    const filePath = folderParts
        ? join('TrainingPeaks', folderParts.yearMonth, folderParts.day, `${workoutId}.json`)
        : join('TrainingPeaks', `${workoutId}.json`)

    return {
        rowKey,
        name,
        workoutStart,
        workoutType: String(item.workoutType ?? '').trim(),
        totalTime: String(item.totalTime ?? '').trim(),
        distance: String(item.distance ?? '').trim(),
        tssValue,
        tssUnit,
        workoutId,
        filePath,
        source: String(item.source ?? 'trainingpeaks').trim() || 'trainingpeaks',
    }
}

function buildFullJson(item: TrainingPeaksWorkoutInput, normalized: NormalizedWorkout): Record<string, unknown> {
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
        description: String(item.description ?? '').trim(),
        comments: normalizeComments(item.comments),
        source: normalized.source,
        raw: item.raw ?? null,
        savedAt: nowIso(),
    }
}

export function createTrainingPeaksWorkoutStore(dbFilePath: string, dataDir: string) {
    mkdirSync(dirname(dbFilePath), { recursive: true })

    const db = new DatabaseSync(dbFilePath)
    const schemaSql = `
        CREATE TABLE IF NOT EXISTS trainingpeaks_workouts (
            row_key TEXT NOT NULL PRIMARY KEY,
            workout_id TEXT NOT NULL,
            name TEXT NOT NULL,
            workout_start TEXT NOT NULL,
            workout_type TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT 'trainingpeaks',
            total_time TEXT NOT NULL DEFAULT '',
            distance TEXT NOT NULL DEFAULT '',
            tss_value TEXT NOT NULL DEFAULT '',
            tss_unit TEXT NOT NULL DEFAULT '',
            file_path TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tp_workouts_start ON trainingpeaks_workouts(workout_start);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tp_workouts_workout_id ON trainingpeaks_workouts(workout_id);
    `
    db.exec(schemaSql)

    const selectByRowKeyStmt = db.prepare(`
        SELECT row_key FROM trainingpeaks_workouts WHERE row_key = ? LIMIT 1
    `)

    const selectByWorkoutIdStmt = db.prepare(`
        SELECT row_key, file_path FROM trainingpeaks_workouts WHERE workout_id = ? LIMIT 1
    `)

    const deleteByRowKeyStmt = db.prepare(`DELETE FROM trainingpeaks_workouts WHERE row_key = ?`)

    const insertStmt = db.prepare(`
        INSERT INTO trainingpeaks_workouts
            (row_key, workout_id, name, workout_start, workout_type, source,
             total_time, distance, tss_value, tss_unit, file_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const updateStmt = db.prepare(`
        UPDATE trainingpeaks_workouts
        SET workout_id = ?, name = ?, workout_start = ?, workout_type = ?, source = ?,
            total_time = ?, distance = ?, tss_value = ?, tss_unit = ?, file_path = ?, updated_at = ?
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
                        | { row_key: string; file_path: string }
                        | undefined

                    if (existingByWorkoutId && existingByWorkoutId.row_key !== normalized.rowKey) {
                        deleteByRowKeyStmt.run(existingByWorkoutId.row_key)

                        if (existingByWorkoutId.file_path && existingByWorkoutId.file_path !== normalized.filePath) {
                            const staleFilePath = join(dataDir, existingByWorkoutId.file_path)
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
                            normalized.workoutStart, normalized.workoutType, normalized.source,
                            normalized.totalTime, normalized.distance,
                            normalized.tssValue, normalized.tssUnit,
                            normalized.filePath, timestamp, timestamp,
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
                        normalized.workoutStart, normalized.workoutType, normalized.source,
                        normalized.totalTime, normalized.distance,
                        normalized.tssValue, normalized.tssUnit,
                        normalized.filePath, timestamp,
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
                SELECT row_key, file_path FROM trainingpeaks_workouts
            `).all() as Array<{ row_key: string; file_path: string }>
            return rows.map((r) => ({ rowKey: r.row_key, filePath: r.file_path }))
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
    }
}


