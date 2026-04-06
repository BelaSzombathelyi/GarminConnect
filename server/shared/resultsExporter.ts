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
    markdownId: string
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
    const extractField = (names: string[]): string => {
        for (const name of names) {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            const lineValue = firstMatch(text, new RegExp(`^${escaped}:\\s*(.+)$`, 'mi'))
            if (lineValue) return lineValue
            const tableValue = firstMatch(text, new RegExp(`^\\|\\s*${escaped}\\s*\\|\\s*([^|]+)\\|\\s*$`, 'mi'))
            if (tableValue) return tableValue
        }
        return ''
    }

    const sportProfile = extractField(['Sport profil', 'Sport profile'])
    const sport = extractField(['Sport'])
    const subSport = extractField(['Alsport', 'Subsport', 'Sub sport'])
    const startRaw = extractField(['Kezdés', 'Start'])
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

function normalizeEmbeddedMarkdown(text: string): string {
    // Keep embedded content renderable while avoiding heading-level collisions.
    return text
        .split('\n')
        .map((line) => {
            const match = line.match(/^(#{1,6})\s+(.*)$/)
            if (!match) return line
            const level = Math.min(6, match[1].length + 2)
            return `${'#'.repeat(level)} ${match[2]}`
        })
        .join('\n')
}

export function compareResultEntries(a: ResultTextEntry, b: ResultTextEntry): number {
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

async function collectMarkdownFilesRecursive(rootDir: string): Promise<string[]> {
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

            if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
                files.push(fullPath)
            }
        }
    }

    await walk(rootDir)
    return files
}

function extractDateAndIdFromPath(filePath: string): { dateKey: string; activityId: string } {
    const normalized = filePath.replace(/\\/g, '/')
    const pathMatch = normalized.match(/\/(\d{4}-\d{2})\/(\d{2})\/(\d+)\.md$/)
    if (pathMatch) {
        return {
            dateKey: `${pathMatch[1]}-${pathMatch[2]}`,
            activityId: pathMatch[3],
        }
    }

    const fileNameMatch = normalized.match(/\/(\d+)\.md$/)
    return {
        dateKey: 'ismeretlen-datum',
        activityId: fileNameMatch ? fileNameMatch[1] : 'ismeretlen-activity',
    }
}

export function buildResultTextEntryFromText(text: string, activityId: string): ResultTextEntry {
    const meta = parseResultTextMeta(text)
    const dayKey = meta.dayKey ?? 'ismeretlen-datum'
    const monthKey = dayKey !== 'ismeretlen-datum' ? dayKey.slice(0, 7) : dayKey
    return {
        dateKey: dayKey,
        activityId,
        filePath: '',
        text,
        dayKey,
        monthKey,
        sportProfile: meta.sportProfile,
        sport: meta.sport,
        subSport: meta.subSport,
        activityTypeLabel: buildActivityTypeLabel(meta),
        startIso: meta.startIso,
        startTimeLabel: meta.startTimeLabel,
        markdownId: `activity-${dayKey}-${activityId}`,
    }
}

export async function collectResultTextEntries(rootDir: string): Promise<ResultTextEntry[]> {
    const mdFiles = await collectMarkdownFilesRecursive(rootDir)
    const entries: ResultTextEntry[] = []

    for (const filePath of mdFiles) {
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
            markdownId: `activity-${dayKey}-${activityId}`,
        })
    }

    entries.sort(compareResultEntries)

    return entries
}

export async function buildResultsMarkdown(entries: ResultTextEntry[]): Promise<Buffer> {
    const lines: string[] = []

    // Header
    lines.push('# Garmin Download Results')
    lines.push('')
    lines.push(`Generated: ${new Date().toISOString()}`)
    lines.push('')

    if (entries.length === 0) {
        lines.push('Nincs elérhető markdown eredmény fájl a data mappában.')
        return Buffer.from(lines.join('\n'), 'utf-8')
    }

    // Table of Contents
    lines.push('## Tartalomjegyzék')
    lines.push('')

    let currentMonthKey = ''
    let currentDayKey = ''
    for (const entry of entries) {
        if (entry.monthKey !== currentMonthKey) {
            currentMonthKey = entry.monthKey
            currentDayKey = ''
            lines.push(`### ${currentMonthKey}`)
        }

        if (entry.dayKey !== currentDayKey) {
            currentDayKey = entry.dayKey
            lines.push(`- **${currentDayKey}**`)
        }

        lines.push(`  - [${entry.startTimeLabel} • ${entry.activityTypeLabel}](#${entry.markdownId})`)
    }

    lines.push('')
    lines.push('---')
    lines.push('')

    // Activities
    let currentDate = ''
    for (const entry of entries) {
        if (entry.dayKey !== currentDate) {
            currentDate = entry.dayKey
            lines.push(`## ${currentDate}`)
            lines.push('')
        }

        lines.push(`<a id="${entry.markdownId}"></a>`)
        lines.push(normalizeEmbeddedMarkdown(entry.text || '(üres)'))
        lines.push('')
    }

    return Buffer.from(lines.join('\n'), 'utf-8')
}
