import { defineConfig } from 'vite'
import { Decoder, Stream } from '@garmin/fitsdk'
import AdmZip from 'adm-zip'
import { resolve } from 'node:path'
import { processBuffer } from './server/fitPipeline'
import { ActivityStatus, createActivityStore } from './server/activityStore'
import { startDownloadWatcher } from './server/downloadWatcher'

const DB_FILE_PATH = resolve(process.cwd(), 'data', 'garmin-activities.sqlite')
const DOWNLOADS_DIR = process.env.GARMIN_DOWNLOADS_DIR || resolve(process.env.HOME || '.', 'Downloads')
const ARCHIVE_DIR = resolve(process.cwd(), 'downloads-archive')

const activityStore = createActivityStore(DB_FILE_PATH)
let stopDownloadWatcher = null

function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Activity-Id')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

async function readJsonBody(req) {
    const chunks = []
    for await (const chunk of req) {
        chunks.push(chunk)
    }

    if (chunks.length === 0) return {}
    const raw = Buffer.concat(chunks).toString('utf-8')
    return JSON.parse(raw)
}

function handleOptions(req, res) {
    if (req.method !== 'OPTIONS') return false
    setCorsHeaders(res)
    res.statusCode = 204
    res.end()
    return true
}

function fitUploadPlugin() {
    return {
        name: 'fit-upload',
        configureServer(server) {
            if (!stopDownloadWatcher) {
                stopDownloadWatcher = startDownloadWatcher({
                    downloadsDir: DOWNLOADS_DIR,
                    archiveDir: ARCHIVE_DIR,
                    onZipReady: ({ fileName, activityId, archivedFileName }) => {
                        if (!activityId) {
                            console.warn('[downloads] Nem sikerült activity ID-t kinyerni:', fileName)
                            return
                        }

                        activityStore.markReceived(activityId, archivedFileName)
                        console.log(`[downloads] RECEIVED: ${activityId} (${archivedFileName})`)
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
                    const activities = Array.isArray(payload?.activities) ? payload.activities : []
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

            server.middlewares.use('/api/mark_opened', async (req, res) => {
                if (handleOptions(req, res)) return
                setCorsHeaders(res)

                if (req.method !== 'POST') {
                    res.statusCode = 405
                    res.end('Method Not Allowed')
                    return
                }

                try {
                    const payload = await readJsonBody(req)
                    const activityId = String(payload?.activityId || '').trim()
                    if (!activityId) {
                        res.statusCode = 400
                        res.end(JSON.stringify({ ok: false, error: 'activityId kötelező' }))
                        return
                    }

                    activityStore.markOpened(activityId)
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
                    const activityId = String(payload?.activityId || '').trim()
                    if (!activityId) {
                        res.statusCode = 400
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
                    res.statusCode = 405;
                    res.end('Method Not Allowed');
                    return;
                }

                const chunks = [];
                for await (const chunk of req) {
                    chunks.push(chunk);
                }
                const buffer = Buffer.concat(chunks);
                const activityId = req.headers['x-activity-id'] ?? null;

                try {
                    const { text, errors } = processBuffer(buffer, activityId);
                    if (errors.length > 0) {
                        console.warn('[process] Dekódolási hibák:', errors);
                    }
                    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                    res.statusCode = 200;
                    res.end(text);
                } catch (err) {
                    res.statusCode = 422;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
                }
            });

            server.middlewares.use('/api/fit-upload', async (req, res) => {
                console.log('[GarminConnect] FIT feltöltés API hívva.');

                if (req.method !== 'POST') {
                    res.statusCode = 405;
                    res.end('Method Not Allowed');
                    return;
                }

                // Request body összegyűjtése Buffer-be
                const chunks = [];
                for await (const chunk of req) {
                    chunks.push(chunk);
                }
                let buffer = Buffer.concat(chunks);

                // ZIP detektálás: a Garmin download API ZIP-ben adja vissza a FIT fájlt
                // ZIP fájl fejléce: 50 4B 03 04 ("PK\x03\x04")
                if (buffer[0] === 0x50 && buffer[1] === 0x4B) {
                    const zip = new AdmZip(buffer);
                    const fitEntry = zip.getEntries().find(e => e.entryName.endsWith('.fit'));
                    if (!fitEntry) {
                        res.statusCode = 422;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({ error: 'Nem található .fit fájl a ZIP archívumban' }));
                        return;
                    }
                    buffer = fitEntry.getData();
                }

                // FIT formátum ellenőrzése
                const stream = Stream.fromByteArray(new Uint8Array(buffer));
                if (!Decoder.isFIT(stream)) {
                    res.statusCode = 422;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'A fájl nem érvényes FIT formátum' }));
                    return;
                }

                // FIT dekódolás
                const decoder = new Decoder(stream);
                const { messages, errors } = decoder.read();

                const activityId = req.headers['x-activity-id'] ?? null;
                console.log(`[fit-upload] Aktivitás feldolgozva: ${activityId}`);
                if (errors.length > 0) {
                    console.warn('[fit-upload] Dekódolási hibák:', errors);
                }

                res.setHeader('Content-Type', 'application/json');
                res.statusCode = 200;
                res.end(JSON.stringify({ activityId, messages, errors }));
            });
        }
    }
}

export default defineConfig({
    plugins: [fitUploadPlugin()],
    test: {
        environment: 'node',
    },
})
