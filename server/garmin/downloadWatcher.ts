import { mkdirSync, watch } from 'node:fs'
import { stat, rename, copyFile, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

interface ZipReadyPayload {
    fileName: string
    archivedFileName: string
    archivedPath: string
    activityId: string | null
}

interface ArchiveTarget {
    relativeDir?: string
    fileName?: string
}

interface DownloadWatcherOptions {
    downloadsDir: string
    archiveDir: string
    onZipReady: (payload: ZipReadyPayload) => void | Promise<void>
    resolveArchiveTarget?: (context: { fileName: string; activityId: string | null }) => ArchiveTarget | Promise<ArchiveTarget>
    logger?: Pick<Console, 'log' | 'warn' | 'error'>
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractActivityIdFromFileName(fileName: string): string | null {
    const match = fileName.match(/(\d{8,})/)
    return match ? match[1] : null
}

function buildArchivedFileName(fileName: string, activityId: string | null): string {
    if (activityId) {
        return `${activityId}.zip`
    }

    const timestampPrefix = new Date().toISOString().replace(/[:.]/g, '-')
    return `${timestampPrefix}-${basename(fileName)}`
}

async function moveFile(sourcePath: string, targetPath: string): Promise<boolean> {
    try {
        await rename(sourcePath, targetPath)
        return true
    } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e?.code === 'ENOENT') return false
        // Csak EXDEV (cross-device) és EPERM (Windows: pl. Defender hold) esetén
        // próbálkozzunk a copy+unlink fallback-kel. Egyéb hibát továbbdobunk.
        if (e?.code !== 'EXDEV' && e?.code !== 'EPERM' && e?.code !== 'EACCES') throw err
    }

    // Windows-on a frissen letöltött fájlt a Defender/SmartScreen néha 1-3 mp-ig
    // exkluzívan szkenneli → EPERM/EBUSY copyFile-nál. Backoff retry-jal
    // próbálkozunk, mielőtt feladnánk.
    const maxAttempts = 6
    let lastErr: unknown
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            await copyFile(sourcePath, targetPath)
            try {
                await unlink(sourcePath)
            } catch (unlinkErr) {
                const ue = unlinkErr as NodeJS.ErrnoException
                if (ue?.code !== 'ENOENT') {
                    // A forrás már nem ott van, vagy nem törölhető — nem kritikus,
                    // a célfájl megvan, csak log.
                    console.warn('[downloads] Forrás unlink nem sikerült:', ue?.code || unlinkErr)
                }
            }
            return true
        } catch (err) {
            const e = err as NodeJS.ErrnoException
            if (e?.code === 'ENOENT') return false
            if (e?.code !== 'EPERM' && e?.code !== 'EBUSY' && e?.code !== 'EACCES') throw err
            lastErr = err
            // 500ms, 1s, 1.5s, 2s, 2.5s, 3s → összesen ~10.5s backoff
            await sleep(500 * attempt)
        }
    }

    throw lastErr instanceof Error ? lastErr : new Error('copyFile retry kifogyott')
}

async function waitForStableFile(filePath: string, retries = 20, delayMs = 500): Promise<boolean> {
    // Növelt retries (20 × 500ms = 10s összesen), hogy a frissen letöltött
    // ZIP-et a Defender/SmartScreen befejezhesse szkennelni, mielőtt move-oljuk.
    let previous: { size: number; mtimeMs: number } | null = null
    let stableCount = 0

    for (let i = 0; i < retries; i += 1) {
        let current
        try {
            current = await stat(filePath)
        } catch {
            await sleep(delayMs)
            continue
        }

        if (previous && previous.size === current.size && previous.mtimeMs === current.mtimeMs && current.size > 0) {
            stableCount += 1
            // Kérünk 2 egymás utáni stabil mintát — egy nem elég, mert a
            // Chrome néha „pause"-ol írás közben.
            if (stableCount >= 2) return true
        } else {
            stableCount = 0
        }

        previous = { size: current.size, mtimeMs: current.mtimeMs }
        await sleep(delayMs)
    }

    return false
}

export function startDownloadWatcher({ downloadsDir, archiveDir, onZipReady, resolveArchiveTarget, logger = console }: DownloadWatcherOptions) {
    mkdirSync(archiveDir, { recursive: true })

    const inFlight = new Set<string>()

    const watcher = watch(downloadsDir, async (_eventType, fileNameRaw) => {
        if (typeof fileNameRaw !== 'string') return

        const fileName = fileNameRaw
        if (!fileName || extname(fileName).toLowerCase() !== '.zip') return
        if (inFlight.has(fileName)) return

        inFlight.add(fileName)
        const sourcePath = join(downloadsDir, fileName)

        try {
            const stable = await waitForStableFile(sourcePath)
            if (!stable) {
                logger.warn('[downloads] A ZIP fájl nem vált stabillá időben:', fileName)
                return
            }

            const activityId = extractActivityIdFromFileName(fileName)
            const target = await Promise.resolve(resolveArchiveTarget?.({ fileName, activityId }) ?? {})

            const archivedFileName = String(target.fileName || '').trim() || buildArchivedFileName(fileName, activityId)
            const archiveTargetDir = target.relativeDir ? join(archiveDir, target.relativeDir) : archiveDir
            mkdirSync(archiveTargetDir, { recursive: true })

            const archivedPath = join(archiveTargetDir, archivedFileName)
            const moved = await moveFile(sourcePath, archivedPath)
            if (!moved) {
                // Forrás ZIP eltűnt (dupla watcher event vagy korábbi futás már bemozgatta).
                // Ha az archív cél már létezik, ÚJRA feldolgozzuk → felülírjuk az outputot.
                let archiveExists = false
                try {
                    const st = await stat(archivedPath)
                    archiveExists = st.isFile() && st.size > 0
                } catch {
                    archiveExists = false
                }
                if (archiveExists) {
                    logger.log('[downloads] Dupla watcher event, archív ZIP-ből újrafeldolgozás:', archivedFileName)
                    await onZipReady({
                        fileName,
                        archivedFileName,
                        archivedPath,
                        activityId,
                    })
                } else {
                    logger.warn('[downloads] Forrás ZIP már nem létezik és archívben sincs, kihagyva:', fileName)
                }
                return
            }

            await onZipReady({
                fileName,
                archivedFileName,
                archivedPath,
                activityId,
            })
        } catch (err) {
            logger.error('[downloads] ZIP feldolgozási hiba:', err)
        } finally {
            inFlight.delete(fileName)
        }
    })

    logger.log('[downloads] Watcher elindult:', downloadsDir)

    return () => watcher.close()
}