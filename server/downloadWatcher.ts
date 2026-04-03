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
        if (!e || e.code !== 'EXDEV') throw err
    }

    try {
        await copyFile(sourcePath, targetPath)
        await unlink(sourcePath)
        return true
    } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e?.code === 'ENOENT') return false
        throw err
    }
}

async function waitForStableFile(filePath: string, retries = 8, delayMs = 1000): Promise<boolean> {
    let previous: { size: number; mtimeMs: number } | null = null

    for (let i = 0; i < retries; i += 1) {
        let current
        try {
            current = await stat(filePath)
        } catch {
            await sleep(delayMs)
            continue
        }

        if (previous && previous.size === current.size && previous.mtimeMs === current.mtimeMs) {
            return true
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
                logger.warn('[downloads] Forrás ZIP már nem létezik (dupla watcher event), kihagyva:', fileName)
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