import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import { resolve } from 'node:path'
import { registerGarminRoutes } from './server/garmin/routes'
import { registerTrainingPeaksRoutes } from './server/trainingpeaks/routes'
import { registerSharedRoutes } from './server/shared/routes'

const GARMIN_DB_FILE_PATH = resolve(process.cwd(), 'data', 'garmin-activities.sqlite')
const TRAININGPEAKS_DB_FILE_PATH = resolve(process.cwd(), 'data', 'TrainingPeaks', 'trainingpeaks-workouts.sqlite')
const DOWNLOADS_DIR = process.env.GARMIN_DOWNLOADS_DIR || resolve(process.env.HOME || '.', 'Downloads')
const ARCHIVE_DIR = resolve(process.cwd(), 'data')

function fitUploadPlugin(): Plugin {
    return {
        name: 'fit-upload',
        configureServer(server: ViteDevServer) {
            const tpStore = registerTrainingPeaksRoutes(server, {
                dbFilePath: TRAININGPEAKS_DB_FILE_PATH,
                dataDir: ARCHIVE_DIR,
            })

            registerGarminRoutes(server, {
                dbFilePath: GARMIN_DB_FILE_PATH,
                downloadsDir: DOWNLOADS_DIR,
                archiveDir: ARCHIVE_DIR,
                tpStore,
            })

            registerSharedRoutes(server, {
                archiveDir: ARCHIVE_DIR,
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
