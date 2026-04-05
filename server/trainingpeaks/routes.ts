import type { ViteDevServer } from 'vite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
    const records = workoutStore.getAllForCleanup()
    if (records.length === 0) {
        console.log('[tp-cleanup] 0 rekord vizsgálva')
        return
    }

        const toDelete: string[] = []

        for (const r of records) {
            if (!existsSync(join(dataDir, r.filePath))) {
                toDelete.push(r.rowKey)
                console.log(`[tp-cleanup] hiányzó fájl: ${r.filePath}`)
            }
    }

    if (toDelete.length === 0) {
        console.log(`[tp-cleanup] ${records.length} rekord vizsgálva, nincs törlendő`)
        return
    }

        workoutStore.deleteByRowKeys(toDelete)
    console.log(`[tp-cleanup] ${toDelete.length} rekord törölve (${records.length} vizsgálva)`)
}

export function registerTrainingPeaksRoutes(server: ViteDevServer, options: RegisterTrainingPeaksRoutesOptions): void {
    const { dataDir } = options
    const workoutStore = createTrainingPeaksWorkoutStore(options.dbFilePath, dataDir)

    cleanupOrphanedWorkouts(workoutStore, dataDir).catch((err) =>
        console.error('[tp-cleanup] Hiba az indításkori takarításban:', err)
    )

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
}
