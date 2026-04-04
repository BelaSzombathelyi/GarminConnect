import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface TrainingPeaksWorkoutInput {
    name?: string
    workoutStart?: string
    workout_start?: string
    date?: string
    totalTime?: string
    distance?: string
    tss?: string
    description?: string
    comments?: string[]
    source?: string
    raw?: Record<string, unknown>
}

interface NormalizedWorkout {
    name: string
    workoutStart: string
    payloadJson: string
    source: string
}

function nowIso(): string {
    return new Date().toISOString()
}

function normalizeWorkout(item: TrainingPeaksWorkoutInput): NormalizedWorkout | null {
    const name = String(item.name ?? '').trim()
    const workoutStart = String(item.workoutStart ?? item.workout_start ?? item.date ?? '').trim()
    if (!name || !workoutStart) return null

    const payload = {
        name,
        workoutStart,
        totalTime: String(item.totalTime ?? '').trim(),
        distance: String(item.distance ?? '').trim(),
        tss: String(item.tss ?? '').trim(),
        description: String(item.description ?? '').trim(),
        comments: Array.isArray(item.comments) ? item.comments.map((it) => String(it)) : [],
        raw: item.raw ?? null,
    }

    return {
        name,
        workoutStart,
        payloadJson: JSON.stringify(payload),
        source: String(item.source ?? 'trainingpeaks').trim() || 'trainingpeaks',
    }
}

export function createTrainingPeaksWorkoutStore(dbFilePath: string) {
    mkdirSync(dirname(dbFilePath), { recursive: true })

    const db = new DatabaseSync(dbFilePath)
    db.exec(`
        CREATE TABLE IF NOT EXISTS trainingpeaks_workouts (
            workout_start TEXT NOT NULL,
            name TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'trainingpeaks',
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (workout_start, name)
        );
        CREATE INDEX IF NOT EXISTS idx_tp_workouts_start ON trainingpeaks_workouts(workout_start);
    `)

    const selectStmt = db.prepare(`
        SELECT workout_start
        FROM trainingpeaks_workouts
        WHERE workout_start = ? AND name = ?
        LIMIT 1
    `)

    const insertStmt = db.prepare(`
        INSERT INTO trainingpeaks_workouts (workout_start, name, source, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `)

    const updateStmt = db.prepare(`
        UPDATE trainingpeaks_workouts
        SET source = ?, payload_json = ?, updated_at = ?
        WHERE workout_start = ? AND name = ?
    `)

    return {
        upsertWorkouts(items: TrainingPeaksWorkoutInput[]) {
            let inserted = 0
            let updated = 0

            const normalized = items
                .map(normalizeWorkout)
                .filter((item): item is NormalizedWorkout => item !== null)

            const timestamp = nowIso()

            db.exec('BEGIN')
            try {
                for (const item of normalized) {
                    const existing = selectStmt.get(item.workoutStart, item.name)
                    if (!existing) {
                        insertStmt.run(item.workoutStart, item.name, item.source, item.payloadJson, timestamp, timestamp)
                        inserted += 1
                        continue
                    }

                    updateStmt.run(item.source, item.payloadJson, timestamp, item.workoutStart, item.name)
                    updated += 1
                }

                db.exec('COMMIT')
            } catch (err) {
                db.exec('ROLLBACK')
                throw err
            }

            return {
                received: normalized.length,
                inserted,
                updated,
            }
        },
    }
}
