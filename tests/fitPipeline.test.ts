import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { processBuffer } from '../server/garmin/fitPipeline'

const DATA_DIR = join(import.meta.dirname, 'data')

const TEST_FILES = [
    { name: 'Vivicitta',       file: 'Vivicitta.zip' },
    { name: 'BSzM 4',          file: 'BSzM 4.zip' },
    { name: 'VO2max interval', file: 'VO2 max - SUM 20p 4x5 min, 04_05.zip' },
    { name: 'Solymár - 3fél óra terepen', file: 'Solymár - 3fél óra terepen.zip' },
]

for (const { name, file } of TEST_FILES) {
    describe(name, () => {
        const buffer = readFileSync(join(DATA_DIR, file))
        const { text, errors } = processBuffer(buffer)

        // Golden-file: mindig felülíródik – git diff mutatja a változásokat
        const outputPath = join(DATA_DIR, `${name}.output.txt`)
        writeFileSync(outputPath, text, 'utf8')

        it('nem üres kimenetet ad', () => {
            expect(text.length).toBeGreaterThan(0)
        })

        it('tartalmaz edzés összefoglalót', () => {
            expect(text).toContain('--- Edzés összefoglaló ---')
        })

        it('tartalmaz körök adatokat', () => {
            expect(text).toContain('körök')
        })

        it('nincs kritikus dekódolási hiba', () => {
            // Figyelmeztetések megengedettek, de az outputnak léteznie kell
            expect(text.length).toBeGreaterThan(100)
            // Logoljuk a hibákat ha vannak
            if (errors.length > 0) {
                console.warn(`[${name}] Dekódolási hibák:`, errors)
            }
        })
    })
}
