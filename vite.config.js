import { defineConfig } from 'vite'
import { Decoder, Stream } from '@garmin/fitsdk'
import AdmZip from 'adm-zip'
import { processBuffer } from './server/fitPipeline'

function fitUploadPlugin() {
    return {
        name: 'fit-upload',
        configureServer(server) {
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
