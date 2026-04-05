import { Decoder, Stream } from '@garmin/fitsdk'
import AdmZip from 'adm-zip'
import { FitUploadResponse, buildTextOutput } from '../../src/fitExtractor'

export interface ProcessResult {
    text: string
    activityId: string | null
    startTimeIso: string | null
    errors: string[]
}

function toLocalIso(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function processBuffer(buffer: Buffer, activityId: string | null = null): ProcessResult {
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

    return { text, activityId, startTimeIso, errors: errors.map(String) }
}
