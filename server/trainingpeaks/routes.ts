import type { ViteDevServer } from 'vite'
import { createTrainingPeaksWorkoutStore, type TrainingPeaksWorkoutInput } from './workoutStore'
import { handleOptions, readJsonBody, setCorsHeaders } from '../shared/http'

export interface RegisterTrainingPeaksRoutesOptions {
    dbFilePath: string
}

export function registerTrainingPeaksRoutes(server: ViteDevServer, options: RegisterTrainingPeaksRoutesOptions): void {
    const workoutStore = createTrainingPeaksWorkoutStore(options.dbFilePath)

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
