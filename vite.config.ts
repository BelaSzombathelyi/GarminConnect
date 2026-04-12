import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import { resolve } from 'node:path'
import { registerGarminRoutes } from './server/garmin/routes'
import { registerTrainingPeaksRoutes } from './server/trainingpeaks/routes'
import { registerSharedRoutes } from './server/shared/routes'

const DATA_DIR = resolve(process.cwd(), 'data')
const GARMIN_DIR = resolve(DATA_DIR, 'Garmin')
const GARMIN_DB_FILE_PATH = resolve(GARMIN_DIR, 'garmin-activities.sqlite')
const TRAININGPEAKS_DB_FILE_PATH = resolve(DATA_DIR, 'TrainingPeaks', 'trainingpeaks-workouts.sqlite')
const DOWNLOADS_DIR = process.env.GARMIN_DOWNLOADS_DIR || resolve(process.env.HOME || '.', 'Downloads')

function fitUploadPlugin(): Plugin {
    return {
        name: 'fit-upload',
        configureServer(server: ViteDevServer) {
            const tpStore = registerTrainingPeaksRoutes(server, {
                dbFilePath: TRAININGPEAKS_DB_FILE_PATH,
                dataDir: DATA_DIR,
            })

            registerGarminRoutes(server, {
                dbFilePath: GARMIN_DB_FILE_PATH,
                downloadsDir: DOWNLOADS_DIR,
                archiveDir: GARMIN_DIR,
                tpStore,
            })

            registerSharedRoutes(server, {
                archiveDir: GARMIN_DIR,
                tpStore,
            })
        },
    }
}

export default defineConfig({
    plugins: [fitUploadPlugin()],
    server: {
        host: '127.0.0.1',
        port: 5173,
        cors: {
            origin: ['https://connect.garmin.com', 'https://app.trainingpeaks.com', 'http://localhost:3000'],
            methods: ['GET', 'POST', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'X-Activity-Id'],
            credentials: false,
        },
    },
})
