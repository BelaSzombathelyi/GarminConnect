import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import { Decoder, Stream } from '@garmin/fitsdk'
import AdmZip from 'adm-zip'
import PDFDocument from 'pdfkit'
import { resolve } from 'node:path'
import { dirname, join } from 'node:path'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { processBuffer } from './server/fitPipeline'
import { ActivityStatus, createActivityStore, type ActivityInput } from './server/activityStore'
import { startDownloadWatcher } from './server/downloadWatcher'

const DB_FILE_PATH = resolve(process.cwd(), 'data', 'garmin-activities.sqlite')
const DOWNLOADS_DIR = process.env.GARMIN_DOWNLOADS_DIR || resolve(process.env.HOME || '.', 'Downloads')
const ARCHIVE_DIR = resolve(process.cwd(), 'data')

const activityStore = createActivityStore(DB_FILE_PATH)
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

function setCorsHeaders(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Activity-Id')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }

    if (chunks.length === 0) return {}
    const raw = Buffer.concat(chunks).toString('utf-8')
    return JSON.parse(raw) as Record<string, unknown>
}

function handleOptions(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method !== 'OPTIONS') return false
    setCorsHeaders(res)
    res.statusCode = 204
    res.end()
    return true
}

interface ResultTextEntry {
    dateKey: string
    activityId: string
    filePath: string
    text: string
}

async function collectTxtFilesRecursive(rootDir: string): Promise<string[]> {
    const files: string[] = []

    async function walk(currentDir: string): Promise<void> {
        let entries
        try {
            entries = await readdir(currentDir, { withFileTypes: true })
        } catch {
            return
        }

        for (const entry of entries) {
            const fullPath = join(currentDir, entry.name)
            if (entry.isDirectory()) {
                await walk(fullPath)
                continue
            }

            if (entry.isFile() && entry.name.toLowerCase().endsWith('.txt')) {
                files.push(fullPath)
            }
        }
    }

    await walk(rootDir)
    return files
}

function extractDateAndIdFromPath(filePath: string): { dateKey: string; activityId: string } {
    const normalized = filePath.replace(/\\/g, '/')
    const pathMatch = normalized.match(/\/(\d{4}-\d{2})\/(\d{2})\/(\d+)\.txt$/)
    if (pathMatch) {
        return {
            dateKey: `${pathMatch[1]}-${pathMatch[2]}`,
            activityId: pathMatch[3],
        }
    }

    const fileNameMatch = normalized.match(/\/(\d+)\.txt$/)
    return {
        dateKey: 'ismeretlen-datum',
        activityId: fileNameMatch ? fileNameMatch[1] : 'ismeretlen-activity',
    }
}

async function collectResultTextEntries(rootDir: string): Promise<ResultTextEntry[]> {
    const txtFiles = await collectTxtFilesRecursive(rootDir)
    const entries: ResultTextEntry[] = []

    for (const filePath of txtFiles) {
        const { dateKey, activityId } = extractDateAndIdFromPath(filePath)
        const text = await readFile(filePath, 'utf-8')
        entries.push({
            dateKey,
            activityId,
            filePath,
            text,
        })
    }

    entries.sort((a, b) => {
        if (a.dateKey !== b.dateKey) return a.dateKey.localeCompare(b.dateKey)
        return a.activityId.localeCompare(b.activityId)
    })

    return entries
}

async function buildResultsPdf(entries: ResultTextEntry[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, autoFirstPage: true })
        const chunks: Buffer[] = []

        doc.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        doc.on('end', () => resolve(Buffer.concat(chunks)))
        doc.on('error', reject)

        doc.fontSize(18).text('Garmin Download Results', { underline: true })
        doc.moveDown(0.5)
        doc.fontSize(10).fillColor('gray').text(`Generated: ${new Date().toISOString()}`)
        doc.moveDown()
        doc.fillColor('black')

        if (entries.length === 0) {
            doc.fontSize(12).text('Nincs elerheto TXT eredmeny fajl a data mappaban.')
            doc.end()
            return
        }

        let currentDate = ''
        for (const entry of entries) {
            if (entry.dateKey !== currentDate) {
                currentDate = entry.dateKey
                doc.moveDown(0.8)
                doc.fontSize(14).fillColor('black').text(`${currentDate}`, { underline: true })
                doc.moveDown(0.3)
            }

            doc.fontSize(11).fillColor('black').text(`Activity: ${entry.activityId}`)
            doc.fontSize(9).fillColor('gray').text(`Forras: ${entry.filePath}`)
            doc.moveDown(0.2)
            doc.fontSize(10).fillColor('black').text(entry.text || '(ures)', {
                lineGap: 1,
            })
            doc.moveDown(0.8)
        }

        doc.end()
    })
}

function fitUploadPlugin(): Plugin {
    return {
        name: 'fit-upload',
        configureServer(server: ViteDevServer) {
            if (!stopDownloadWatcher) {
                stopDownloadWatcher = startDownloadWatcher({
                    downloadsDir: DOWNLOADS_DIR,
                    archiveDir: ARCHIVE_DIR,
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
                            const { text, errors } = processBuffer(buffer, activityId)
                            if (errors.length > 0) {
                                console.warn(`[downloads] Dekódolási hibák (${activityId}):`, errors)
                            }

                            const txtPath = join(dirname(archivedPath), `${activityId}.txt`)
                            await writeFile(txtPath, text, 'utf-8')

                            activityStore.markProcessed(activityId)
                            console.log(`[downloads] PROCESSED: ${activityId} (${txtPath})`)
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
                    const stats = activityStore.upsertActivities(activities)
                    const newItems = activityStore.getByStatus(ActivityStatus.NEW, 2000)

                    res.setHeader('Content-Type', 'application/json; charset=utf-8')
                    res.statusCode = 200
                    res.end(JSON.stringify({
                        ok: true,
                        ...stats,
                        newCount: newItems.length,
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
                    const { text, errors } = processBuffer(buffer, activityId)
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

            server.middlewares.use('/api/download_results_pdf', async (req, res) => {
                if (handleOptions(req, res)) return
                setCorsHeaders(res)

                if (req.method !== 'GET') {
                    res.statusCode = 405
                    res.end('Method Not Allowed')
                    return
                }

                try {
                    const entries = await collectResultTextEntries(ARCHIVE_DIR)
                    const pdfBuffer = await buildResultsPdf(entries)
                    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)

                    res.statusCode = 200
                    res.setHeader('Content-Type', 'application/pdf')
                    res.setHeader('Content-Disposition', `attachment; filename="download-results-${stamp}.pdf"`)
                    res.end(pdfBuffer)
                } catch (err) {
                    res.statusCode = 500
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
        },
    }
}

export default defineConfig({
    plugins: [fitUploadPlugin()],
    test: {
        environment: 'node',
    },
})