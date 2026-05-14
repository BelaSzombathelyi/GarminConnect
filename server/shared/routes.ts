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
    options: { waitForZipMs?: number } = {},
): Promise<{ zipPath: string; mdPath: string; startTimeIso: string | null }> {
    // A userscript akkor hív minket, amikor a `pollActivityStatus` már
    // RECEIVED/PROCESSED-et látott. A chokidar watcher viszont esetenként
    // még épp dolgozik a ZIP átmozgatásán, vagy a status az activityStore-ból
    // egy korábbi futás maradványa. Ezért rövid retry-jal próbálkozunk
    // megtalálni a ZIP-et az archívumban, mielőtt feladnánk.
    const waitForZipMs = Math.max(0, options.waitForZipMs ?? 4000)
    const pollIntervalMs = 250
    const deadline = Date.now() + waitForZipMs

    let zipPath = await findZipByGarminActivityId(archiveDir, garminActivityId)
    while (!zipPath && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollIntervalMs))
        zipPath = await findZipByGarminActivityId(archiveDir, garminActivityId)
    }
    if (!zipPath) {
        throw new Error(`Nem található ZIP ehhez a Garmin ID-hoz: ${garminActivityId}`)
    }

    const buffer = await readFile(zipPath)
    const garminExtra = await loadGarminExtraJson(dirname(zipPath), garminActivityId)
    const { text, startTimeIso, errors } = processBuffer(buffer, { activityId: garminActivityId, tpStore, garminExtra })

    if (errors.length > 0) {
        console.warn(`[reprocess-by-id] Dekódolási hibák (${garminActivityId}):`, errors)
    }

    const mdPath = join(dirname(zipPath), `${garminActivityId}.md`)
    await writeFile(mdPath, text, 'utf-8')

    return { zipPath, mdPath, startTimeIso }
}

/**
 * A userscript által iframe módban scrape-elt extra adatok
 * (`{activityId}.json`). Best-effort: ha nincs / nem parse-olható, null-t ad.
 */
async function loadGarminExtraJson(dir: string, activityId: string): Promise<Record<string, unknown> | null> {
    const jsonPath = join(dir, `${activityId}.json`)
    try {
        const raw = await readFile(jsonPath, 'utf-8')
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
    } catch {
        return null
    }
}

function getQueryParam(req: any, key: string): string {
    const reqUrl = new URL(req.url || '', 'http://localhost')
    return String(reqUrl.searchParams.get(key) ?? '').trim()
}


function workoutStartToIsoDate(value: unknown): string {
    const text = String(value ?? '').trim()
    const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/)
    if (isoMatch) {
        return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`
    }

    const slashMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
    if (!slashMatch) {
        return ''
    }

    const day = slashMatch[1].padStart(2, '0')
    const month = slashMatch[2].padStart(2, '0')
    let year = Number(slashMatch[3])
    if (year < 100) year += 2000
    return `${year}-${month}-${day}`
}

function buildWorkoutMarkdownFileName(workoutStart: unknown, tpWorkoutId: string): string {
    const isoDate = workoutStartToIsoDate(workoutStart)
    const safeWorkoutId = String(tpWorkoutId ?? '').trim()
    if (!isoDate || !safeWorkoutId) {
        return `tp-workout-${safeWorkoutId || 'unknown'}.md`
    }
    return `${isoDate}_${safeWorkoutId}.md`
}

function parseGarminDateFromZipPath(zipPath: string): string {
    const normalized = String(zipPath || '').replace(/\\/g, '/')
    const m = normalized.match(/\/(\d{4}-\d{2})\/(\d{2})\/\d+\.zip$/)
    if (!m) return ''
    return `${m[1]}-${m[2]}`
}

function buildGarminMarkdownFileName(zipPath: string, activityId: string): string {
    const dateToken = parseGarminDateFromZipPath(zipPath) || 'unknown-date'
    const safeId = String(activityId ?? '').trim() || 'unknown'
    return `${dateToken}-${safeId}.md`
}

function parseActivityIdsFromUnknown(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    const ids = value
        .map((item) => String(item ?? '').trim())
        .filter((id) => /^\d+$/.test(id))
    return Array.from(new Set(ids))
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

        if (req.method !== 'GET') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
        }

        const garminActivityId = getQueryParam(req, 'garminActivityId')
        if (!/^\d+$/.test(garminActivityId)) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ ok: false, error: 'garminActivityId kötelező (numerikus)' }))
            return
        }

        try {
            const { mdPath } = await reprocessWorkoutByGarminId(archiveDir, garminActivityId, tpStore)
            const markdown = await readFile(mdPath, 'utf-8')
            res.statusCode = 200
            res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
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

    server.middlewares.use('/api/download_workout_markdown', async (req, res) => {
        if (handleOptions(req, res)) return
        setCorsHeaders(res)

        if (req.method !== 'POST') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
        }

        try {
            const body = await readJsonBody(req)
            const tpWorkoutId = String(body.tpWorkoutId ?? '').trim()
            const requestedGarminActivityId = String(body.garminActivityId ?? '').trim()
            const requestedGarminActivityIds = parseActivityIdsFromUnknown(body.garminActivityIds)

            if (!tpWorkoutId && !requestedGarminActivityId && requestedGarminActivityIds.length === 0) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.end(JSON.stringify({ ok: false, error: 'tpWorkoutId vagy garminActivityId vagy garminActivityIds kötelező' }))
                return
            }

            if (requestedGarminActivityIds.length > 0 && !tpWorkoutId && !requestedGarminActivityId) {
                for (const id of requestedGarminActivityIds) {
                    await reprocessWorkoutByGarminId(archiveDir, id, tpStore)
                }

                const allEntries = await collectResultTextEntries(archiveDir)
                const wanted = new Set(requestedGarminActivityIds)
                const entries = allEntries.filter((entry) => wanted.has(entry.activityId))
                const markdownBuffer = await buildResultsMarkdown(entries)
                const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)

                res.statusCode = 200
                res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
                res.setHeader('Content-Disposition', `attachment; filename="download-results-${stamp}.md"`)
                res.end(markdownBuffer)
                return
            }

            let garminActivityId = requestedGarminActivityId

            if (!garminActivityId && tpWorkoutId) {
                if (!tpStore) {
                    res.statusCode = 500
                    res.setHeader('Content-Type', 'application/json; charset=utf-8')
                    res.end(JSON.stringify({ ok: false, error: 'TrainingPeaks store nincs konfigurálva' }))
                    return
                }

                const workout = tpStore.getByWorkoutId(tpWorkoutId)
                if (!workout) {
                    res.statusCode = 404
                    res.setHeader('Content-Type', 'application/json; charset=utf-8')
                    res.end(JSON.stringify({ ok: false, error: `TP workout nem található: ${tpWorkoutId}` }))
                    return
                }

                const effectiveTpWorkoutId = String(workout.workoutId ?? '').trim()
                garminActivityId = String(workout.garminActivityId ?? '').trim()
                if (!garminActivityId) {
                    garminActivityId = (await tryLinkTpWorkoutToGarminActivity(archiveDir, effectiveTpWorkoutId, tpStore)) ?? ''
                }

                if (!garminActivityId) {
                    res.statusCode = 409
                    res.setHeader('Content-Type', 'application/json; charset=utf-8')
                    res.end(JSON.stringify({ ok: false, error: `Ehhez a TP workouthoz még nincs társítva Garmin ID: ${tpWorkoutId}` }))
                    return
                }
            }

            if (!/^\d+$/.test(garminActivityId)) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.end(JSON.stringify({ ok: false, error: 'garminActivityId kötelező (numerikus)' }))
                return
            }

            const { zipPath, mdPath } = await reprocessWorkoutByGarminId(archiveDir, garminActivityId, tpStore)
            const markdown = await readFile(mdPath, 'utf-8')
            const downloadFileName = buildGarminMarkdownFileName(zipPath, garminActivityId)

            res.statusCode = 200
            res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
            res.setHeader('Content-Disposition', `attachment; filename="${downloadFileName}"`)
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
