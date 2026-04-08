import { Decoder, Stream } from '@garmin/fitsdk'
import AdmZip from 'adm-zip'
import { basename, dirname, join } from 'node:path'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import type { ViteDevServer } from 'vite'
import { ActivityStatus, createActivityStore, type ActivityInput } from './activityStore'
import { startDownloadWatcher } from './downloadWatcher'
import { processBuffer } from './fitPipeline'
import { handleOptions, readJsonBody, setCorsHeaders } from '../shared/http'
import type { createTrainingPeaksWorkoutStore } from '../trainingpeaks/workoutStore'

export interface RegisterGarminRoutesOptions {
    dbFilePath: string
    downloadsDir: string
    archiveDir: string
    tpStore?: ReturnType<typeof createTrainingPeaksWorkoutStore>
}

let stopDownloadWatcher: (() => void) | null = null

function pad2(value: number): string {
    return String(value).padStart(2, '0')
}

function localTodayIso(): string {
    const now = new Date()
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

function normalizeMonthToken(raw: string): string {
    return raw
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\.+$/g, '')
        .trim()
}

function monthFromToken(raw: string): string | null {
    const token = normalizeMonthToken(raw)
    const map: Record<string, string> = {
        jan: '01', januar: '01', january: '01',
        feb: '02', febr: '02', februar: '02', february: '02',
        mar: '03', marc: '03', marcius: '03', march: '03',
        apr: '04', aprilis: '04', april: '04',
        maj: '05', majus: '05', may: '05',
        jun: '06', junius: '06', june: '06',
        jul: '07', julius: '07', july: '07',
        aug: '08', augusztus: '08', august: '08',
        szept: '09', szep: '09', szeptember: '09', sep: '09', sept: '09', september: '09',
        okt: '10', oktober: '10', oct: '10', october: '10',
        nov: '11', november: '11',
        dec: '12', december: '12',
    }

    return map[token] ?? null
}

function parseActivityDateToIso(rawDate: string): string | null {
    const value = String(rawDate || '').trim()
    if (!value) return null

    const isoMatch = value.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/)
    if (isoMatch) {
        const year = isoMatch[1]
        const month = pad2(Number(isoMatch[2]))
        const day = pad2(Number(isoMatch[3]))
        return `${year}-${month}-${day}`
    }

    const normalized = value.replace(/,/g, ' ').replace(/\s+/g, ' ').trim()

    const monthDayYear = normalized.match(/^([^\d]+)\s+(\d{1,2})\.?\s+(\d{4})$/)
    if (monthDayYear) {
        const month = monthFromToken(monthDayYear[1])
        if (!month) return null
        const day = pad2(Number(monthDayYear[2]))
        const year = monthDayYear[3]
        return `${year}-${month}-${day}`
    }

    const dayMonthYear = normalized.match(/^(\d{1,2})\.?\s+([^\d]+)\s+(\d{4})$/)
    if (dayMonthYear) {
        const month = monthFromToken(dayMonthYear[2])
        if (!month) return null
        const day = pad2(Number(dayMonthYear[1]))
        const year = dayMonthYear[3]
        return `${year}-${month}-${day}`
    }

    return null
}

function buildTpSection(tp: Record<string, unknown>): string {
    const lines: string[] = []
    lines.push('## TrainingPeaks')
    lines.push('')

    const rows: [string, string][] = []
    if (tp.name) rows.push(['Aktivitás neve', String(tp.name)])
    const tssValue = String(tp.tssValue ?? '').trim()
    const tssUnit = String(tp.tssUnit ?? '').trim()
    if (tssValue) rows.push(['TSS', tssUnit ? `${tssValue} ${tssUnit}` : tssValue])
    if (tp.workoutType) rows.push(['Edzés típus', String(tp.workoutType)])
    if (tp.totalTime) rows.push(['Tervezett idő', String(tp.totalTime)])

    if (rows.length > 0) {
        for (const [k, v] of rows) lines.push(`${k}: ${v}`)
    }

    const description = String(tp.description ?? '').trim()
    if (description) {
        lines.push('')
        lines.push('### Edzői instrukciók')
        lines.push('')
        lines.push(description)
    }

    const comments = Array.isArray(tp.comments)
        ? (tp.comments as Array<{ text: string; date?: string; user?: string }>)
        : []
    if (comments.length > 0) {
        lines.push('')
        lines.push('### Kommentek')
        for (const c of comments) {
            lines.push('')
            const meta = [c.date, c.user].filter(Boolean).join(' — ')
            if (meta) lines.push(`**${meta}**`)
            lines.push('')
            lines.push(c.text)
        }
    }

    return lines.join('\n')
}

async function cleanupIncompleteActivities(
    activityStore: ReturnType<typeof createActivityStore>,
    archiveDir: string,
    tpStore?: ReturnType<typeof createTrainingPeaksWorkoutStore>,
): Promise<void> {
    function extractActivityIdFromZipName(fileName: string): string | null {
        const match = fileName.match(/^(\d+)\.zip$/)
        return match?.[1] ?? null
    }

    async function exists(path: string): Promise<boolean> {
        try {
            await access(path)
            return true
        } catch {
            return false
        }
    }

    let scannedZipCount = 0
    let generatedMdCount = 0
    let alreadyPresentCount = 0
    let skippedNoIdCount = 0
    let errorCount = 0

    async function walkAndRecover(dir: string): Promise<void> {
        let entries
        try {
            entries = await readdir(dir, { withFileTypes: true })
        } catch {
            return
        }

        for (const entry of entries) {
            const fullPath = join(dir, entry.name)
            if (entry.isDirectory()) {
                await walkAndRecover(fullPath)
                continue
            }

            if (!entry.isFile() || !entry.name.endsWith('.zip')) continue

            scannedZipCount += 1
            const activityId = extractActivityIdFromZipName(entry.name)
            if (!activityId) {
                skippedNoIdCount += 1
                continue
            }

            const mdPath = join(dirname(fullPath), `${activityId}.md`)
            if (await exists(mdPath)) {
                alreadyPresentCount += 1
                continue
            }

            try {
                const buffer = await readFile(fullPath)
                const { text, startTimeIso, errors: decodeErrors } = processBuffer(buffer, { activityId, tpStore })
                if (decodeErrors.length > 0) {
                    console.warn(`[startup-recovery] Dekódolási hibák (${activityId}):`, decodeErrors)
                }

                let mdText = text
                if (startTimeIso && tpStore) {
                    const tpMatch = tpStore.findByDateTimeNear(startTimeIso, 60)
                    if (tpMatch) {
                        tpStore.linkGarminActivity(tpMatch.workoutId, activityId)
                        mdText = buildTpSection(tpMatch.fileContent) + '\n\n' + text
                        console.log(`[startup-recovery] TP egyezés: ${activityId} <-> ${tpMatch.workoutId} (${startTimeIso})`)
                    }
                }

                await writeFile(mdPath, mdText, 'utf-8')
                activityStore.markReceived(activityId, basename(fullPath))
                if (startTimeIso) {
                    activityStore.updateDate(activityId, startTimeIso)
                }
                activityStore.markProcessed(activityId)
                generatedMdCount += 1
                console.log(`[startup-recovery] MD generálva: ${activityId} (${mdPath})`)
            } catch (err) {
                errorCount += 1
                console.error(`[startup-recovery] Hiba (${activityId}):`, err)
            }
        }
    }

    await walkAndRecover(archiveDir)
    console.log(
        `[startup-recovery] ZIP: ${scannedZipCount}, generált MD: ${generatedMdCount}, ` +
        `már megvolt: ${alreadyPresentCount}, ID nélkül kihagyva: ${skippedNoIdCount}, hibás: ${errorCount}`,
    )
}

export function registerGarminRoutes(server: ViteDevServer, options: RegisterGarminRoutesOptions): void {
    const { dbFilePath, downloadsDir, archiveDir, tpStore } = options
    const activityStore = createActivityStore(dbFilePath)

    cleanupIncompleteActivities(activityStore, archiveDir, tpStore).catch((err) =>
        console.error('[startup-recovery] Hiba az indításkori recovery közben:', err)
    )

    // Startup migráció: régi lokál-formátumú dátumok átalakítása ISO-ra (YYYY-MM-DDT00:00:00).
    // A pontos időpont csak ZIP feldolgozáskor kerül bele, ez csak a napot menősíti.
    ;(async () => {
        try {
            const toMigrate = activityStore.getAllForDateMigration()
            if (toMigrate.length === 0) return
            let migrated = 0
            for (const { activityId, date } of toMigrate) {
                const iso = parseActivityDateToIso(date)
                if (iso) {
                    activityStore.updateDate(activityId, `${iso}T00:00:00`)
                    migrated++
                }
            }
            console.log(`[garmin-migration] ${migrated}/${toMigrate.length} date mező konvertálva ISO formátumra`)
        } catch (err) {
            console.error('[garmin-migration] Hiba:', err)
        }
    })()

    if (!stopDownloadWatcher) {
        stopDownloadWatcher = startDownloadWatcher({
            downloadsDir,
            archiveDir,
            resolveArchiveTarget: ({ fileName: _fileName, activityId }) => {
                if (!activityId) return {}

                const activity = activityStore.getById(activityId)
                const isoDate = parseActivityDateToIso(activity?.date ?? '') ?? localTodayIso()
                const relativeDir = `${isoDate.slice(0, 7)}/${isoDate.slice(8, 10)}`
                return {
                    relativeDir,
                    fileName: `${activityId}.zip`,
                }
            },
            onZipReady: async ({ fileName, activityId, archivedFileName, archivedPath }) => {
                if (!activityId) {
                    console.warn('[downloads] Nem sikerült activity ID-t kinyerni:', fileName)
                    return
                }

                activityStore.markReceived(activityId, archivedFileName)
                console.log(`[downloads] RECEIVED: ${activityId} (${archivedFileName})`)

                try {
                    const buffer = await readFile(archivedPath)
                    const { text, startTimeIso, errors } = processBuffer(buffer, { activityId, tpStore })
                    if (errors.length > 0) {
                        console.warn(`[downloads] Dekódolási hibák (${activityId}):`, errors)
                    }

                    let mdText = text
                    if (startTimeIso && tpStore) {
                        const tpMatch = tpStore.findByDateTimeNear(startTimeIso, 60)
                        if (tpMatch) {
                            tpStore.linkGarminActivity(tpMatch.workoutId, activityId)
                            mdText = buildTpSection(tpMatch.fileContent) + '\n\n' + text
                            console.log(`[downloads] TP egyezés: ${activityId} <-> ${tpMatch.workoutId} (${startTimeIso})`)
                        }
                    }

                    const mdPath = join(dirname(archivedPath), `${activityId}.md`)
                    await writeFile(mdPath, mdText, 'utf-8')

                    if (startTimeIso) {
                        activityStore.updateDate(activityId, startTimeIso)
                    }
                    activityStore.markProcessed(activityId)
                    console.log(`[downloads] PROCESSED: ${activityId} (${mdPath})`)
                } catch (err) {
                    console.error(`[downloads] Feldolgozási hiba (${activityId}):`, err)
                }
            },
            logger: console,
        })
    }

    server.middlewares.use('/api/report_activities', async (req, res) => {
        if (handleOptions(req, res)) return
        setCorsHeaders(res)

        if (req.method !== 'POST') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
        }

        try {
            const payload = await readJsonBody(req)
            const activitiesRaw = payload.activities
            const activities = Array.isArray(activitiesRaw) ? (activitiesRaw as ActivityInput[]) : []
            const submittedIds = activities
                .map((a) => String(a.activityId ?? a.id ?? '').trim())
                .filter(Boolean)
            const stats = activityStore.upsertActivities(activities)
            const downloadableIds = activityStore.filterDownloadable(submittedIds)

            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.statusCode = 200
            res.end(JSON.stringify({
                ok: true,
                ...stats,
                newCount: downloadableIds.length,
                newActivityIds: downloadableIds,
            }))
        } catch (err) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            }))
        }
    })

    server.middlewares.use('/api/get_new_activities', (req, res) => {
        if (handleOptions(req, res)) return
        setCorsHeaders(res)

        if (req.method !== 'GET') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
        }

        const reqUrl = new URL(req.url || '', 'http://localhost')
        const limit = Math.min(Number(reqUrl.searchParams.get('limit') || 25), 100)
        const items = activityStore.getByStatus(ActivityStatus.NEW, Number.isFinite(limit) ? limit : 25)

        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.statusCode = 200
        res.end(JSON.stringify({ ok: true, activities: items }))
    })

    server.middlewares.use('/api/mark_processed', async (req, res) => {
        if (handleOptions(req, res)) return
        setCorsHeaders(res)

        if (req.method !== 'POST') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
        }

        try {
            const payload = await readJsonBody(req)
            const activityId = String(payload.activityId || '').trim()
            if (!activityId) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.end(JSON.stringify({ ok: false, error: 'activityId kötelező' }))
                return
            }

            activityStore.markProcessed(activityId)
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.statusCode = 200
            res.end(JSON.stringify({ ok: true }))
        } catch (err) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            }))
        }
    })

    server.middlewares.use('/api/process', async (req, res) => {
        if (req.method !== 'POST') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
        }

        const chunks: Buffer[] = []
        for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }
        const buffer = Buffer.concat(chunks)
        const activityId = req.headers['x-activity-id'] ?? null

        try {
            const { text, errors } = processBuffer(buffer, { activityId, tpStore })
            if (errors.length > 0) {
                console.warn('[process] Dekódolási hibák:', errors)
            }
            res.setHeader('Content-Type', 'text/plain; charset=utf-8')
            res.statusCode = 200
            res.end(text)
        } catch (err) {
            res.statusCode = 422
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        }
    })

    server.middlewares.use('/api/garmin/upload_activity_zip', async (req, res) => {
        if (handleOptions(req, res)) return
        setCorsHeaders(res)

        if (req.method !== 'POST') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
        }

        try {
            const payload = await readJsonBody(req)
            const activityId = String(payload.activityId ?? '').trim()
            const zipBase64 = String(payload.zipBase64 ?? '').trim()

            if (!activityId || !zipBase64) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.end(JSON.stringify({ ok: false, error: 'activityId és zipBase64 kötelező' }))
                return
            }

            const zipBuffer = Buffer.from(zipBase64, 'base64')
            if (zipBuffer.length === 0) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.end(JSON.stringify({ ok: false, error: 'Üres ZIP payload' }))
                return
            }

            const activity = activityStore.getById(activityId)
            const isoDate = parseActivityDateToIso(activity?.date ?? '') ?? localTodayIso()
            const relativeDir = `${isoDate.slice(0, 7)}/${isoDate.slice(8, 10)}`
            const targetDir = join(archiveDir, relativeDir)
            const zipFileName = `${activityId}.zip`
            const targetZipPath = join(targetDir, zipFileName)

            await mkdir(targetDir, { recursive: true })
            await writeFile(targetZipPath, zipBuffer)

            activityStore.markReceived(activityId, zipFileName)

            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.statusCode = 200
            res.end(JSON.stringify({
                ok: true,
                activityId,
                relativeDir,
                zipPath: targetZipPath,
            }))
        } catch (err) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            }))
        }
    })

    server.middlewares.use('/api/fit-upload', async (req, res) => {
        console.log('[GarminConnect] FIT feltöltés API hívva.')

        if (req.method !== 'POST') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
        }

        const chunks: Buffer[] = []
        for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }
        let buffer = Buffer.concat(chunks)

        if (buffer[0] === 0x50 && buffer[1] === 0x4B) {
            const zip = new AdmZip(buffer)
            const fitEntry = zip.getEntries().find((e) => e.entryName.endsWith('.fit'))
            if (!fitEntry) {
                res.statusCode = 422
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'Nem található .fit fájl a ZIP archívumban' }))
                return
            }
            buffer = fitEntry.getData()
        }

        const stream = Stream.fromByteArray(new Uint8Array(buffer))
        if (!Decoder.isFIT(stream)) {
            res.statusCode = 422
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'A fájl nem érvényes FIT formátum' }))
            return
        }

        const decoder = new Decoder(stream)
        const { messages, errors } = decoder.read()

        const activityId = req.headers['x-activity-id'] ?? null
        console.log(`[fit-upload] Aktivitás feldolgozva: ${activityId}`)
        if (errors.length > 0) {
            console.warn('[fit-upload] Dekódolási hibák:', errors)
        }

        res.setHeader('Content-Type', 'application/json')
        res.statusCode = 200
        res.end(JSON.stringify({ activityId, messages, errors }))
    })

    server.middlewares.use('/api/reprocess_all_activities', async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'POST') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
        }

        handleOptions(req, res)
        setCorsHeaders(res)

        const reqUrl = new URL(req.url || '', 'http://localhost')
        const daysParam = reqUrl.searchParams.get('days')
        const daysLimit = daysParam !== null ? Math.max(1, Number(daysParam)) : null

        // Ha days meg van adva, csak a DB-ben legalább annyira frissen létrehozott aktivitásokat processeljük.
        let allowedIds: Set<string> | null = null
        if (daysLimit !== null && Number.isFinite(daysLimit)) {
            const cutoff = new Date(Date.now() - daysLimit * 24 * 60 * 60 * 1000)
            const y = cutoff.getFullYear()
            const m = pad2(cutoff.getMonth() + 1)
            const d = pad2(cutoff.getDate())
            const cutoffIso = `${y}-${m}-${d}`
            allowedIds = activityStore.getActivityIdsSince(cutoffIso)
        }

        try {
            let reprocessedCount = 0;
            let errorCount = 0;
            let skippedCount = 0;
            const errors: string[] = [];

            async function walkAndProcess(dir: string): Promise<void> {
                let entries;
                try {
                    entries = await readdir(dir, { withFileTypes: true });
                } catch {
                    return;
                }

                for (const entry of entries) {
                    const fullPath = join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await walkAndProcess(fullPath);
                        continue;
                    }

                    if (!entry.isFile() || !entry.name.endsWith('.zip')) continue;

                    const idMatch = entry.name.match(/^(\d+)\.zip$/);
                    if (!idMatch) continue;

                    if (allowedIds !== null && !allowedIds.has(idMatch[1])) {
                        skippedCount++
                        continue
                    }

                    const activityId = idMatch[1];

                    try {
                        const buffer = await readFile(fullPath);
                        const { text, startTimeIso, errors: decodeErrors } = processBuffer(buffer, { activityId, tpStore });

                        if (decodeErrors.length > 0) {
                            console.warn(`[reprocess] Dekódolási hibák (${activityId}):`, decodeErrors);
                        }

                        const mdPath = join(dirname(fullPath), `${activityId}.md`);
                        await writeFile(mdPath, text, 'utf-8');

                        if (startTimeIso) {
                            activityStore.updateDate(activityId, startTimeIso);
                        }

                        console.log(`[reprocess] FELDOLGOZVA: ${activityId} (${mdPath})`);
                        reprocessedCount += 1;
                    } catch (err) {
                        errorCount += 1;
                        const msg = err instanceof Error ? err.message : String(err);
                        errors.push(`${activityId}: ${msg}`);
                        console.error(`[reprocess] Hiba (${activityId}):`, err);
                    }
                }
            }

            await walkAndProcess(archiveDir);

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({
                ok: true,
                reprocessedCount,
                skippedCount,
                errorCount,
                daysLimit,
                errors: errors.length > 0 ? errors : undefined,
            }));
        } catch (err) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            }));
        }
    })
}
