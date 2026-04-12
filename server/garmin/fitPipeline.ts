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

    let tpFileContent: Record<string, unknown> | null = null
    if (startTimeIso && options.tpStore) {
        const tpMatch = options.tpStore.findByDateTimeNear(startTimeIso, 60)
        if (tpMatch) {
            if (activityId) {
                options.tpStore.linkGarminActivity(tpMatch.workoutId, activityId)
            }
            tpFileContent = tpMatch.fileContent
        }
    }

    const finalText = buildTextOutput(data, false, tpFileContent)

    return { text: finalText, activityId, startTimeIso, errors: errors.map(String) }
}
