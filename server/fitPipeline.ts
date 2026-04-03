import { Decoder, Stream } from '@garmin/fitsdk'
import AdmZip from 'adm-zip'
import { FitUploadResponse, buildTextOutput } from '../src/fitExtractor'

export interface ProcessResult {
    text: string
    activityId: string | null
    errors: string[]
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
    return { text, activityId, errors: errors.map(String) }
}
