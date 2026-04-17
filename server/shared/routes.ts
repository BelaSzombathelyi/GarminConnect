import type { ViteDevServer } from 'vite'
import { basename, dirname, join } from 'node:path'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { buildResultsMarkdown, collectResultTextEntries } from './resultsExporter'
import { handleOptions, readJsonBody, setCorsHeaders } from './http'
import { processBuffer } from '../garmin/fitPipeline'
import type { createTrainingPeaksWorkoutStore } from '../trainingpeaks/workoutStore'

export interface RegisterSharedRoutesOptions {
    archiveDir: string
    tpStore?: ReturnType<typeof createTrainingPeaksWorkoutStore>
}

async function findZipByGarminActivityId(archiveDir: string, garminActivityId: string): Promise<string | null> {
    async function walk(dir: string): Promise<string | null> {
        let entries
        try {
            entries = await readdir(dir, { withFileTypes: true })
        } catch {
            return null
        }

        for (const entry of entries) {
            const fullPath = join(dir, entry.name)
            if (entry.isDirectory()) {
                const nested = await walk(fullPath)
                if (nested) return nested
                continue
            }

            if (entry.isFile() && entry.name === `${garminActivityId}.zip`) {
                return fullPath
            }
        }

        return null
    }

    return walk(archiveDir)
}

async function collectZipPathsRecursively(dir: string): Promise<string[]> {
    let entries
    try {
        entries = await readdir(dir, { withFileTypes: true })
    } catch {
        return []
    }

    const nested = await Promise.all(
        entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => collectZipPathsRecursively(join(dir, entry.name))),
    )

    const localZips = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.zip'))
        .map((entry) => join(dir, entry.name))

    return [...localZips, ...nested.flat()]
}

async function tryLinkTpWorkoutToGarminActivity(
    archiveDir: string,
    tpWorkoutId: string,
    tpStore: ReturnType<typeof createTrainingPeaksWorkoutStore>,
): Promise<string | null> {
    const alreadyLinked = String(tpStore.getByWorkoutId(tpWorkoutId)?.garminActivityId ?? '').trim()
    if (alreadyLinked) return alreadyLinked

    const zipPaths = await collectZipPathsRecursively(archiveDir)
    for (const zipPath of zipPaths) {
        const fileName = basename(zipPath)
        const activityId = fileName.match(/^(\d+)\.zip$/)?.[1] ?? ''
        if (!activityId) continue

        try {
            const buffer = await readFile(zipPath)
            processBuffer(buffer, { activityId, tpStore })
        } catch {
            continue
        }

        const linkedAfterScan = String(tpStore.getByWorkoutId(tpWorkoutId)?.garminActivityId ?? '').trim()
        if (linkedAfterScan) {
            return linkedAfterScan
        }
    }

    return null
}

export async function reprocessWorkoutByGarminId(
    archiveDir: string,
    garminActivityId: string,
    tpStore?: ReturnType<typeof createTrainingPeaksWorkoutStore>,
): Promise<{ zipPath: string; mdPath: string; startTimeIso: string | null }> {
    const zipPath = await findZipByGarminActivityId(archiveDir, garminActivityId)
    if (!zipPath) {
        throw new Error(`Nem található ZIP ehhez a Garmin ID-hoz: ${garminActivityId}`)
    }

    const buffer = await readFile(zipPath)
    const { text, startTimeIso, errors } = processBuffer(buffer, { activityId: garminActivityId, tpStore })

    if (errors.length > 0) {
        console.warn(`[reprocess-by-id] Dekódolási hibák (${garminActivityId}):`, errors)
    }

    const mdPath = join(dirname(zipPath), `${garminActivityId}.md`)
    await writeFile(mdPath, text, 'utf-8')

    return { zipPath, mdPath, startTimeIso }
}

function getQueryParam(req: any, key: string): string {
    const reqUrl = new URL(req.url || '', 'http://localhost')
    return String(reqUrl.searchParams.get(key) ?? '').trim()
}

export function registerSharedRoutes(server: ViteDevServer, options: RegisterSharedRoutesOptions): void {
    const { archiveDir, tpStore } = options

    server.middlewares.use('/api/workout_links', async (req, res) => {
        if (handleOptions(req, res)) return
        setCorsHeaders(res)

        if (req.method !== 'GET') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
        }

        if (!tpStore) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ ok: false, error: 'TrainingPeaks store nincs konfigurálva' }))
            return
        }

        try {
            const tpWorkoutId = getQueryParam(req, 'tpWorkoutId')
            const garminActivityId = getQueryParam(req, 'garminActivityId')

            if (!tpWorkoutId && !garminActivityId) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.end(JSON.stringify({ ok: false, error: 'tpWorkoutId vagy garminActivityId kötelező' }))
                return
            }

            let resolvedTpWorkoutId = tpWorkoutId
            let resolvedGarminActivityId = garminActivityId

            if (tpWorkoutId) {
                const workout = tpStore.getByWorkoutId(tpWorkoutId)
                resolvedGarminActivityId = String(workout?.garminActivityId ?? '').trim()
            } else if (garminActivityId) {
                const workout = tpStore.getByGarminActivityId(garminActivityId)
                resolvedTpWorkoutId = String(workout?.workoutId ?? '').trim()
            }

            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({
                ok: true,
                tpWorkoutId: resolvedTpWorkoutId || '',
                garminActivityId: resolvedGarminActivityId || '',
            }))
        } catch (err) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            }))
        }
    })

    server.middlewares.use('/api/reprocess_workout_by_garmin_id', async (req, res) => {
        if (handleOptions(req, res)) return
        setCorsHeaders(res)

        if (req.method !== 'GET' && req.method !== 'POST') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
        }

        try {
            const body = req.method === 'POST' ? await readJsonBody(req) : {}
            const garminActivityId = req.method === 'POST'
                ? String(body.garminActivityId ?? '').trim()
                : getQueryParam(req, 'garminActivityId')

            if (!garminActivityId) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.end(JSON.stringify({ ok: false, error: 'garminActivityId kötelező' }))
                return
            }

            const result = await reprocessWorkoutByGarminId(archiveDir, garminActivityId, tpStore)
            const markdown = await readFile(result.mdPath, 'utf-8')

            res.statusCode = 200
            res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
            res.setHeader('X-Garmin-Activity-Id', garminActivityId)
            res.setHeader('X-Reprocessed-File', result.mdPath)
            res.end(markdown)
        } catch (err) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            }))
        }
    })

    server.middlewares.use('/api/reprocess_workout_by_tp_id', async (req, res) => {
        if (handleOptions(req, res)) return
        setCorsHeaders(res)

        if (req.method !== 'GET' && req.method !== 'POST') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
        }

        if (!tpStore) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ ok: false, error: 'TrainingPeaks store nincs konfigurálva' }))
            return
        }

        try {
            const body = req.method === 'POST' ? await readJsonBody(req) : {}
            const tpWorkoutId = req.method === 'POST'
                ? String(body.tpWorkoutId ?? '').trim()
                : getQueryParam(req, 'tpWorkoutId')

            if (!tpWorkoutId) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.end(JSON.stringify({ ok: false, error: 'tpWorkoutId kötelező' }))
                return
            }

            const workout = tpStore.getByWorkoutId(tpWorkoutId)
            if (!workout) {
                res.statusCode = 404
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.end(JSON.stringify({ ok: false, error: `TP workout nem található: ${tpWorkoutId}` }))
                return
            }

            let garminActivityId = String(workout.garminActivityId ?? '').trim()
            if (!garminActivityId) {
                garminActivityId = (await tryLinkTpWorkoutToGarminActivity(archiveDir, tpWorkoutId, tpStore)) ?? ''
            }

            if (!garminActivityId) {
                res.statusCode = 409
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.end(JSON.stringify({
                    ok: false,
                    error: `Ehhez a TP workouthoz még nincs társítva Garmin ID: ${tpWorkoutId}`,
                }))
                return
            }

            const result = await reprocessWorkoutByGarminId(archiveDir, garminActivityId, tpStore)
            const markdown = await readFile(result.mdPath, 'utf-8')

            res.statusCode = 200
            res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
            res.setHeader('X-TP-Workout-Id', tpWorkoutId)
            res.setHeader('X-Garmin-Activity-Id', garminActivityId)
            res.setHeader('X-Reprocessed-File', result.mdPath)
            res.end(markdown)
        } catch (err) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            }))
        }
    })

    server.middlewares.use('/api/download_results_markdown', async (req, res) => {
        if (handleOptions(req, res)) return
        setCorsHeaders(res)

        if (req.method !== 'GET') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
        }

        try {
            const entries = await collectResultTextEntries(archiveDir)
            const markdownBuffer = await buildResultsMarkdown(entries)
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)

            res.statusCode = 200
            res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
            res.setHeader('Content-Disposition', `attachment; filename="download-results-${stamp}.md"`)
            res.end(markdownBuffer)
        } catch (err) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            }))
        }
    })
}
