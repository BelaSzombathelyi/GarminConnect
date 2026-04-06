import { Decoder, Stream } from '@garmin/fitsdk'
import AdmZip from 'adm-zip'
import { FitUploadResponse, buildTextOutput } from '../../src/fitExtractor'
import type { createTrainingPeaksWorkoutStore } from '../trainingpeaks/workoutStore'
import { shouldMaskTpDescription } from '../trainingpeaks/descriptionMasking'

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

function injectTpDataIntoSummary(summaryText: string, tp: Record<string, unknown>): string {
    const lines = summaryText.split('\n')
    const heroineIndex = lines.findIndex((line) => line.startsWith('Heart rate:'))
    let insertIndex = heroineIndex !== -1 ? heroineIndex : lines.length - 1

    const fieldsToAdd: Array<[string, string]> = []
    const tssValue = String(tp.tssValue ?? '').trim()
    const tssUnit = String(tp.tssUnit ?? '').trim()
    if (tssValue) fieldsToAdd.push(['TSS', tssUnit ? `${tssValue} ${tssUnit}` : tssValue])

    const plannedTssValue = String(tp.plannedTssValue ?? '').trim()
    const plannedTssUnit = String(tp.plannedTssUnit ?? '').trim()
    if (plannedTssValue) {
        fieldsToAdd.push([
            'Tervezett TSS',
            plannedTssUnit ? `${plannedTssValue} ${plannedTssUnit}` : plannedTssValue,
        ])
    }

    const description = String(tp.description ?? '').trim()
    if (description && !shouldMaskTpDescription(tp)) {
        fieldsToAdd.push(['Edzői instrukciók', description])
    }

    for (let i = fieldsToAdd.length - 1; i >= 0; i--) {
        const [k, v] = fieldsToAdd[i]
        lines.splice(insertIndex, 0, `${k}: ${v}`)
    }

    return lines.join('\n')
}

function buildCommentsSection(tp: Record<string, unknown>): string {
    const comments = Array.isArray(tp.comments)
        ? (tp.comments as Array<{ text: string; date?: string; user?: string }>)
        : []
    if (comments.length === 0) return ''

    const lines: string[] = []
    lines.push('### Kommentek')
    for (const c of comments) {
        lines.push('')
        const meta = [c.date, c.user].filter(Boolean).join(' — ')
        if (meta) lines.push(`**${meta}**`)
        lines.push('')
        lines.push(c.text)
    }
    return lines.join('\n')
}

function injectSummaryTotalTime(summaryText: string, totalTime: string): string {
    const lines = summaryText.split('\n')
    const distanceLineIndex = lines.findIndex((line) => line.startsWith('Distance:'))
    const alreadyHasTotalTime = lines.some((line) => line.startsWith('Total time:'))
    if (distanceLineIndex === -1 || alreadyHasTotalTime) return summaryText
    lines.splice(distanceLineIndex + 1, 0, `Total time: ${totalTime}`)
    return lines.join('\n')
}

function injectSummaryTitle(summaryText: string, activityName: string): string {
    const lines = summaryText.split('\n')
    const titleIndex = lines.findIndex((line) => line.startsWith('Title:'))
    if (titleIndex === -1) return summaryText

    const currentTitle = lines[titleIndex].slice('Title:'.length).trim()
    if (!currentTitle) {
        lines[titleIndex] = `Title: ${activityName}`
        return lines.join('\n')
    }

    const hasTypeAlready = activityName.toLowerCase().includes(currentTitle.toLowerCase())
    const nextTitle = hasTypeAlready ? activityName : `${activityName} - ${currentTitle}`
    lines[titleIndex] = `Title: ${nextTitle}`
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
            const summaryMatch = text.match(/^## Summary[\s\S]*?(?=\n##\s|$)/)
            if (summaryMatch) {
                const tpName = String(tpMatch.fileContent?.name ?? '').trim()
                const tpTotalTime = String(tpMatch.fileContent?.totalTime ?? '').trim()
                let summaryText = summaryMatch[0].trim()
                if (tpName) summaryText = injectSummaryTitle(summaryText, tpName)
                if (tpTotalTime) summaryText = injectSummaryTotalTime(summaryText, tpTotalTime)
                summaryText = injectTpDataIntoSummary(summaryText, tpMatch.fileContent)
                let restText = text.slice(summaryMatch[0].length).trimStart()
                
                const commentsSection = buildCommentsSection(tpMatch.fileContent)
                if (commentsSection) {
                    // Insert comments before ### Pause Events section (or before ## Körók if no pause events)
                    const pauseEventsIndex = restText.indexOf('### Pause Events')
                    const insertIndex = pauseEventsIndex !== -1 ? pauseEventsIndex : restText.indexOf('## Körök')
                    
                    if (insertIndex !== -1) {
                        restText = restText.slice(0, insertIndex).trimEnd() + '\n\n' + commentsSection + '\n\n' + restText.slice(insertIndex)
                    } else {
                        restText = restText ? `${restText}\n\n${commentsSection}` : commentsSection
                    }
                }
                
                finalText = restText ? `${summaryText}\n\n${restText}` : summaryText
            }
        }
    }

    return { text: finalText, activityId, startTimeIso, errors: errors.map(String) }
}
