import type { ViteDevServer } from 'vite'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createTrainingPeaksWorkoutStore, type TrainingPeaksWorkoutInput } from './workoutStore'
import { handleOptions, readJsonBody, setCorsHeaders } from '../shared/http'

export interface RegisterTrainingPeaksRoutesOptions {
    dbFilePath: string
    dataDir: string
}

async function cleanupOrphanedWorkouts(
    workoutStore: ReturnType<typeof createTrainingPeaksWorkoutStore>,
    dataDir: string,
): Promise<void> {
    function rowKeyToDate(rowKey: string): string {
        const dateToken = rowKey.split('_')[0] ?? ''
        const m = dateToken.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
        if (!m) return ''
        const day = m[1].padStart(2, '0')
        const month = m[2].padStart(2, '0')
        let year = Number(m[3])
        if (year < 100) year += 2000
        return `${day}/${month}/${year}`
    }

    function dateToExpectedRelativePath(workoutId: string, workoutStartDate: string): string {
        const value = String(workoutStartDate ?? '').trim()
        const isoDateMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/)
        if (isoDateMatch) {
            return `TrainingPeaks/${isoDateMatch[1]}-${isoDateMatch[2]}/${isoDateMatch[3]}/${workoutId}.json`
        }

        const slashDateMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
        if (!slashDateMatch) return `TrainingPeaks/${workoutId}.json`
        const day = slashDateMatch[1].padStart(2, '0')
        const month = slashDateMatch[2].padStart(2, '0')
        let year = Number(slashDateMatch[3])
        if (year < 100) year += 2000
        return `TrainingPeaks/${year}-${month}/${day}/${workoutId}.json`
    }

    const records = workoutStore.getAllForMaintenance()
    if (records.length === 0) {
        console.log('[tp-cleanup] 0 rekord vizsgálva')
        return
    }

    let migrated = 0
    const toDelete: string[] = []

    for (const r of records) {
        const dateFromRowKey = rowKeyToDate(r.rowKey)
        const effectiveDate = dateFromRowKey || r.workoutStart
        const expectedPath = dateToExpectedRelativePath(r.workoutId, effectiveDate)
        const oldAbsPath = join(dataDir, r.filePath)
        const expectedAbsPath = join(dataDir, expectedPath)

        if (r.filePath !== expectedPath && existsSync(oldAbsPath)) {
            mkdirSync(dirname(expectedAbsPath), { recursive: true })
            renameSync(oldAbsPath, expectedAbsPath)
            workoutStore.updateRecordLocation(r.rowKey, effectiveDate, expectedPath)
            migrated += 1
            console.log(`[tp-cleanup] migrálva: ${r.filePath} -> ${expectedPath}`)
        } else if (r.filePath !== expectedPath) {
            // Fájl már lehet új helyen (pl. kézi mozgatás), ilyenkor csak DB-t igazítunk.
            if (existsSync(expectedAbsPath)) {
                workoutStore.updateRecordLocation(r.rowKey, effectiveDate, expectedPath)
                migrated += 1
                console.log(`[tp-cleanup] db útvonal igazítva: ${r.filePath} -> ${expectedPath}`)
            }
        }

        if (!existsSync(expectedAbsPath) && !existsSync(oldAbsPath)) {
            toDelete.push(r.rowKey)
            console.log(`[tp-cleanup] hiányzó fájl: ${expectedPath}`)
        }
    }

    if (toDelete.length > 0) {
        workoutStore.deleteByRowKeys(toDelete)
    }
    console.log(`[tp-cleanup] ${records.length} rekord vizsgálva, ${migrated} migrálva, ${toDelete.length} törölve`)
}

export function registerTrainingPeaksRoutes(
    server: ViteDevServer,
    options: RegisterTrainingPeaksRoutesOptions,
): ReturnType<typeof createTrainingPeaksWorkoutStore> {
    const { dataDir } = options
    const workoutStore = createTrainingPeaksWorkoutStore(options.dbFilePath, dataDir)

    cleanupOrphanedWorkouts(workoutStore, dataDir).catch((err) =>
        console.error('[tp-cleanup] Hiba az indításkori takarításban:', err)
    )

    server.middlewares.use('/api/trainingpeaks/match_by_datetime', async (req, res) => {
        if (handleOptions(req, res)) return
        setCorsHeaders(res)

        if (req.method !== 'POST') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
        }

        try {
            const payload = await readJsonBody(req)
            const dateTime = String(payload.dateTime ?? '').trim()
            const garminActivityId = String(payload.garminActivityId ?? '').trim()

            if (!dateTime) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.end(JSON.stringify({ ok: false, error: 'dateTime kötelező' }))
                return
            }

            const match = workoutStore.findByDateTimeNear(dateTime, 60)
            if (!match) {
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.statusCode = 200
                res.end(JSON.stringify({ ok: true, matched: false }))
                return
            }

            if (garminActivityId) {
                workoutStore.linkGarminActivity(match.workoutId, garminActivityId)
            }

            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.statusCode = 200
            res.end(JSON.stringify({ ok: true, matched: true, workout: match.fileContent }))
        } catch (err) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            }))
        }
    })

    server.middlewares.use('/api/trainingpeaks/reset_tables', (req, res) => {
        if (handleOptions(req, res)) return
        setCorsHeaders(res)

        if (req.method !== 'GET') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
        }

        try {
            const result = workoutStore.resetTables()
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.statusCode = 200
            res.end(JSON.stringify(result))
        } catch (err) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            }))
        }
    })

    server.middlewares.use('/api/trainingpeaks/get_new_workouts', async (req, res) => {
        if (handleOptions(req, res)) return
        setCorsHeaders(res)

        if (req.method !== 'POST') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
        }

        try {
            const payload = await readJsonBody(req)
            const workoutsRaw = payload.workouts
            const workouts = Array.isArray(workoutsRaw) ? (workoutsRaw as TrainingPeaksWorkoutInput[]) : []
            console.log('[tp-api] get_new_workouts bejott', {
                count: workouts.length,
                rowKeys: workouts.map((it) => it.rowKey).filter(Boolean),
            })
            const stats = workoutStore.getNewWorkoutKeys(workouts)

            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.statusCode = 200
            res.end(JSON.stringify({ ok: true, ...stats }))
        } catch (err) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            }))
        }
    })

    server.middlewares.use('/api/trainingpeaks/report_workouts', async (req, res) => {
        if (handleOptions(req, res)) return
        setCorsHeaders(res)

        if (req.method !== 'POST') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
        }

        try {
            const payload = await readJsonBody(req)
            const workoutsRaw = payload.workouts
            const workouts = Array.isArray(workoutsRaw) ? (workoutsRaw as TrainingPeaksWorkoutInput[]) : []
            console.log('[tp-api] report_workouts bejott', {
                count: workouts.length,
                rowKeys: workouts.map((it) => it.rowKey).filter(Boolean),
                workoutIds: workouts.map((it) => String((it.raw as Record<string, unknown> | undefined)?.workoutId ?? '')).filter(Boolean),
            })
            const stats = workoutStore.upsertWorkouts(workouts)

            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.statusCode = 200
            res.end(JSON.stringify({ ok: true, ...stats }))
        } catch (err) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            }))
        }
    })
    return workoutStore}
