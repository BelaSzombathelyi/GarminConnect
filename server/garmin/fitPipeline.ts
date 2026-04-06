import { Decoder, Stream } from '@garmin/fitsdk'
import AdmZip from 'adm-zip'
import { FitUploadResponse, buildTextOutput } from '../../src/fitExtractor'
import type { createTrainingPeaksWorkoutStore } from '../trainingpeaks/workoutStore'

export interface ProcessResult {
    text: string
    activityId: string | null
    startTimeIso: string | null
    errors: string[]
}

export interface ProcessBufferOptions {
    activityId?: string | null
    tpStore?: ReturnType<typeof createTrainingPeaksWorkoutStore>
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
        lines.push('| Adat | Érték |')
        lines.push('| :--- | ---: |')
        for (const [k, v] of rows) lines.push(`| ${k} | ${v} |`)
    }

    const description = String(tp.description ?? '').trim()
    if (description) {
        lines.push('')
        lines.push('### Leírás')
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

function toLocalIso(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function processBuffer(buffer: Buffer, optionsOrActivityId: ProcessBufferOptions | string | null = null): ProcessResult {
    const options: ProcessBufferOptions =
        typeof optionsOrActivityId === 'object' && optionsOrActivityId !== null
            ? optionsOrActivityId
            : { activityId: optionsOrActivityId }
    const activityId = options.activityId ?? null
    // ZIP detektálás: ZIP fájl fejléce 50 4B 03 04 ("PK\x03\x04")
    if (buffer[0] === 0x50 && buffer[1] === 0x4B) {
        const zip = new AdmZip(buffer)
        const fitEntry = zip.getEntries().find(e => e.entryName.endsWith('.fit'))
        if (!fitEntry) {
            throw new Error('Nem található .fit fájl a ZIP archívumban')
        }
        buffer = fitEntry.getData()
    }

    // FIT formátum ellenőrzése
    const stream = Stream.fromByteArray(new Uint8Array(buffer))
    if (!Decoder.isFIT(stream)) {
        throw new Error('A fájl nem érvényes FIT formátum')
    }

    // FIT dekódolás
    const decoder = new Decoder(stream)
    const { messages, errors } = decoder.read()

    const data: FitUploadResponse = {
        activityId,
        messages: messages as Record<string, unknown[]>,
        errors: errors.map(String),
    }

    const text = buildTextOutput(data)

    // Kezdési időpont kinyerése (lokális idő) a TP egyeztetéshez
    let startTimeIso: string | null = null
    const sessionMesgs = data.messages['sessionMesgs'] as Record<string, unknown>[] | undefined
    const session = sessionMesgs?.[0]
    if (session?.['startTime']) {
        const val = session['startTime']
        let d: Date | null = null
        if (val instanceof Date) d = val
        else if (typeof val === 'number') d = new Date(val * 1000)
        if (d) startTimeIso = toLocalIso(d)
    }

    let finalText = text
    if (startTimeIso && options.tpStore) {
        const tpMatch = options.tpStore.findByDateTimeNear(startTimeIso, 60)
        if (tpMatch) {
            if (activityId) {
                options.tpStore.linkGarminActivity(tpMatch.workoutId, activityId)
            }
            finalText = buildTpSection(tpMatch.fileContent) + '\n\n' + text
        }
    }

    return { text: finalText, activityId, startTimeIso, errors: errors.map(String) }
}
