import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const ActivityStatus = {
    NEW: 'NEW',
    RECEIVED: 'RECEIVED',
    PROCESSED: 'PROCESSED',
    ERROR: 'ERROR',
} as const

export type ActivityStatusValue = typeof ActivityStatus[keyof typeof ActivityStatus]

export interface ActivityInput {
    activityId?: string | number
    id?: string | number
    name?: string
    date?: string
    type?: string
}

export interface ActivityRecord {
    activityId: string
    name: string
    date: string
    type: string
    status: ActivityStatusValue
    processedDatetime: string | null
}

export interface ActivityInfo {
    activityId: string
    name: string
    date: string
    type: string
}

function nowIso(): string {
    return new Date().toISOString()
}

function normalizeActivity(activity: ActivityInput): Omit<ActivityRecord, 'status' | 'processedDatetime'> | null {
    const activityId = String(activity.activityId ?? activity.id ?? '').trim()
    if (!activityId) return null

    return {
        activityId,
        name: String(activity.name ?? '').trim(),
        date: String(activity.date ?? '').trim(),
        type: String(activity.type ?? '').trim(),
    }
}

export function createActivityStore(dbFilePath: string) {
    mkdirSync(dirname(dbFilePath), { recursive: true })

    const db = new Database(dbFilePath)
    db.exec(`
        CREATE TABLE IF NOT EXISTS activities (
            activity_id TEXT PRIMARY KEY,
            name TEXT,
            date TEXT,
            type TEXT,
            status TEXT NOT NULL DEFAULT 'NEW',
            processed_datetime TEXT,
            download_file_name TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_activities_status ON activities(status);
        CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(date);
    `)

    const selectByIdStmt = db.prepare('SELECT activity_id FROM activities WHERE activity_id = ?')
    const insertStmt = db.prepare(`
        INSERT INTO activities (
            activity_id, name, date, type, status, processed_datetime, download_file_name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `)
    const updateMetaStmt = db.prepare(`
        UPDATE activities
        SET name = ?, date = ?, type = ?, updated_at = ?
        WHERE activity_id = ?
    `)
    const getByStatusStmt = db.prepare(`
        SELECT activity_id AS activityId, name, date, type, status, processed_datetime AS processedDatetime
        FROM activities
        WHERE status = ?
        ORDER BY date DESC, activity_id DESC
        LIMIT ?
    `)
    const getByIdStmt = db.prepare(`
        SELECT activity_id AS activityId, name, date, type
        FROM activities
        WHERE activity_id = ?
        LIMIT 1
    `)
    const getStatusByIdStmt = db.prepare(`
        SELECT status FROM activities WHERE activity_id = ? LIMIT 1
    `)
    const markStatusStmt = db.prepare(`
        UPDATE activities
        SET status = ?, updated_at = ?, processed_datetime = ?
        WHERE activity_id = ?
    `)
    const markReceivedStmt = db.prepare(`
        UPDATE activities
        SET status = ?, updated_at = ?, processed_datetime = NULL, download_file_name = ?
        WHERE activity_id = ?
    `)
    const getAllNonProcessedStmt = db.prepare(`
        SELECT activity_id AS activityId, date
        FROM activities
        WHERE status != ?
    `)
    const deleteByIdStmt = db.prepare('DELETE FROM activities WHERE activity_id = ?')

    return {
        upsertActivities(activities: ActivityInput[]) {
            let inserted = 0
            let updated = 0
            const normalized = activities
                .map(normalizeActivity)
                .filter((item): item is Omit<ActivityRecord, 'status' | 'processedDatetime'> => item !== null)

            const timestamp = nowIso()

            db.exec('BEGIN')
            try {
                for (const item of normalized) {
                    const exists = selectByIdStmt.get(item.activityId)
                    if (!exists) {
                        insertStmt.run(
                            item.activityId,
                            item.name,
                            item.date,
                            item.type,
                            ActivityStatus.NEW,
                            timestamp,
                            timestamp,
                        )
                        inserted += 1
                        continue
                    }

                    updateMetaStmt.run(item.name, item.date, item.type, timestamp, item.activityId)
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

        getByStatus(status: ActivityStatusValue, limit = 25): ActivityRecord[] {
            return getByStatusStmt.all(status, Number(limit)) as ActivityRecord[]
        },

        getById(activityId: string | number): ActivityInfo | null {
            const row = getByIdStmt.get(String(activityId)) as ActivityInfo | undefined
            return row ?? null
        },

        filterDownloadable(activityIds: string[]): string[] {
            return activityIds.filter((id) => {
                const row = getStatusByIdStmt.get(id) as { status: string } | undefined
                return !row || row.status !== ActivityStatus.PROCESSED
            })
        },

        markProcessed(activityId: string | number): void {
            markStatusStmt.run(ActivityStatus.PROCESSED, nowIso(), nowIso(), String(activityId))
        },

        markReceived(activityId: string | number, fileName: string): void {
            markReceivedStmt.run(
                ActivityStatus.RECEIVED,
                nowIso(),
                String(fileName ?? ''),
                String(activityId),
            )
        },

        getAllNonProcessed(): Array<{ activityId: string; date: string }> {
            return getAllNonProcessedStmt.all(ActivityStatus.PROCESSED) as Array<{ activityId: string; date: string }>
        },

        deleteActivities(ids: string[]): void {
            db.exec('BEGIN')
            try {
                for (const id of ids) {
                    deleteByIdStmt.run(id)
                }
                db.exec('COMMIT')
            } catch (err) {
                db.exec('ROLLBACK')
                throw err
            }
        },

        /**
         * Az adott ISO datetime óta (date >= cutoffIso) létrehozott aktivitás ID-k.
         * A date mező immár ISO datetime formátumban van feltöltve a FIT feldolgozás alatt.
         */
        getActivityIdsSince(cutoffIso: string): Set<string> {
            const rows = db.prepare(`
                SELECT activity_id FROM activities WHERE date >= ?
            `).all(cutoffIso) as Array<{ activity_id: string }>
            return new Set(rows.map((r) => r.activity_id))
        },

        /**
         * Frissíti az aktivitás date mezőjét ISO datetime értékre (a FIT startTime alapján).
         */
        updateDate(activityId: string, isoDateTime: string): void {
            db.prepare(`UPDATE activities SET date = ?, updated_at = ? WHERE activity_id = ?`)
                .run(isoDateTime, nowIso(), activityId)
        },

        /**
         * Azokat az aktivitásokat adja vissza, amelyek date mezője még nem ISO datetime formátumú.
         * Ezeket a startup migráció konvertálja át.
         */
        getAllForDateMigration(): Array<{ activityId: string; date: string }> {
            const rows = db.prepare(`
                SELECT activity_id AS activityId, date FROM activities
                WHERE date NOT LIKE '____-__-__%'
            `).all() as Array<{ activityId: string; date: string }>
            return rows
        },
    }
}