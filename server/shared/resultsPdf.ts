import PDFDocument from 'pdfkit'
import { join } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'

interface ResultTextEntry {
    dateKey: string
    activityId: string
    filePath: string
    text: string
    dayKey: string
    monthKey: string
    sportProfile: string
    sport: string
    subSport: string
    activityTypeLabel: string
    startIso: string | null
    startTimeLabel: string
    pdfDestination: string
}

interface ParsedTextMeta {
    sportProfile: string
    sport: string
    subSport: string
    startIso: string | null
    dayKey: string | null
    startTimeLabel: string
}

function pad2(value: number): string {
    return String(value).padStart(2, '0')
}

function firstMatch(text: string, pattern: RegExp): string {
    const match = text.match(pattern)
    return match ? String(match[1] || '').trim() : ''
}

function parseStartDateTimeToIso(raw: string): string | null {
    const value = String(raw || '').trim()
    if (!value) return null

    const match = value.match(/(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})\.?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/) 
    if (!match) return null

    const year = match[1]
    const month = pad2(Number(match[2]))
    const day = pad2(Number(match[3]))
    const hour = pad2(Number(match[4]))
    const minute = pad2(Number(match[5]))
    const second = pad2(Number(match[6] ?? '0'))
    return `${year}-${month}-${day}T${hour}:${minute}:${second}`
}

function parseResultTextMeta(text: string): ParsedTextMeta {
    const sportProfile = firstMatch(text, /^Sport profil:\s*(.+)$/m)
    const sport = firstMatch(text, /^Sport:\s*(.+)$/m)
    const subSport = firstMatch(text, /^Alsport:\s*(.+)$/m)
    const startRaw = firstMatch(text, /^Kezdés:\s*(.+)$/m)
    const startIso = parseStartDateTimeToIso(startRaw)

    return {
        sportProfile,
        sport,
        subSport,
        startIso,
        dayKey: startIso ? startIso.slice(0, 10) : null,
        startTimeLabel: startIso ? startIso.slice(11, 19) : 'ismeretlen idő',
    }
}

function buildActivityTypeLabel(meta: ParsedTextMeta): string {
    if (meta.sportProfile) return meta.sportProfile
    if (meta.sport) return meta.sport
    if (meta.subSport) return meta.subSport
    return 'ismeretlen típus'
}

function compareResultEntries(a: ResultTextEntry, b: ResultTextEntry): number {
    const aKnown = a.dayKey !== 'ismeretlen-datum'
    const bKnown = b.dayKey !== 'ismeretlen-datum'
    if (aKnown !== bKnown) return aKnown ? -1 : 1

    if (a.dayKey !== b.dayKey) return b.dayKey.localeCompare(a.dayKey)

    if (a.startIso && b.startIso && a.startIso !== b.startIso) {
        return a.startIso.localeCompare(b.startIso)
    }

    if (a.startIso && !b.startIso) return -1
    if (!a.startIso && b.startIso) return 1

    return a.activityId.localeCompare(b.activityId)
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

export async function collectResultTextEntries(rootDir: string): Promise<ResultTextEntry[]> {
    const txtFiles = await collectTxtFilesRecursive(rootDir)
    const entries: ResultTextEntry[] = []

    for (const filePath of txtFiles) {
        const { dateKey, activityId } = extractDateAndIdFromPath(filePath)
        const text = await readFile(filePath, 'utf-8')
        const meta = parseResultTextMeta(text)
        const dayKey = meta.dayKey ?? dateKey
        const monthKey = dayKey !== 'ismeretlen-datum' ? dayKey.slice(0, 7) : dayKey
        entries.push({
            dateKey,
            activityId,
            filePath,
            text,
            dayKey,
            monthKey,
            sportProfile: meta.sportProfile,
            sport: meta.sport,
            subSport: meta.subSport,
            activityTypeLabel: buildActivityTypeLabel(meta),
            startIso: meta.startIso,
            startTimeLabel: meta.startTimeLabel,
            pdfDestination: `activity-${dayKey}-${activityId}`,
        })
    }

    entries.sort(compareResultEntries)

    return entries
}

export async function buildResultsPdf(entries: ResultTextEntry[]): Promise<Buffer> {
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

        doc.fontSize(14).fillColor('black').text('Tartalomjegyzék', { underline: true })
        doc.moveDown(0.5)

        let currentMonthKey = ''
        let currentDayKey = ''
        for (const entry of entries) {
            if (entry.monthKey !== currentMonthKey) {
                currentMonthKey = entry.monthKey
                currentDayKey = ''
                doc.moveDown(0.4)
                doc.fontSize(12).fillColor('black').text(`${currentMonthKey}`)
            }

            if (entry.dayKey !== currentDayKey) {
                currentDayKey = entry.dayKey
                doc.fontSize(10).fillColor('black').text(`  ${currentDayKey}`)
            }

            doc.fontSize(10).fillColor('#1d4ed8').text(
                `    ${entry.startTimeLabel} [${entry.activityTypeLabel}] #${entry.activityId}`,
                { goTo: entry.pdfDestination },
            )
        }

        doc.addPage()

        let currentDate = ''
        for (const entry of entries) {
            if (entry.dayKey !== currentDate) {
                currentDate = entry.dayKey
                doc.moveDown(0.8)
                doc.fontSize(14).fillColor('black').text(`${currentDate}`, { underline: true })
                doc.moveDown(0.3)
            }

            doc.fontSize(11).fillColor('black').text(
                `Activity: ${entry.activityId} | Típus: ${entry.activityTypeLabel} | Kezdés: ${entry.startTimeLabel}`,
                { destination: entry.pdfDestination },
            )
            doc.moveDown(0.2)
            doc.fontSize(10).fillColor('black').text(entry.text || '(ures)', {
                lineGap: 1,
            })
            doc.moveDown(0.8)
        }

        doc.end()
    })
}
