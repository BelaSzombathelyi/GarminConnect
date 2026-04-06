import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { processBuffer } from '../server/garmin/fitPipeline'
import { buildResultsMarkdown, collectResultTextEntries } from '../server/shared/resultsExporter'

const DATA_DIR = join(import.meta.dirname, 'data')

const TEST_FILES = [
    { name: 'Vivicitta',       file: 'Vivicitta.zip' },
    { name: 'BSzM 4',          file: 'BSzM 4.zip' },
    { name: 'VO2max interval', file: 'VO2 max - SUM 20p 4x5 min, 04_05.zip' },
    { name: 'Almádi fagyizás',         file: 'Alsoors-Almadai-fagyi-Alsoors.zip' },
    { name: 'Solymár - 3fél óra terepen', file: 'Solymár - 3fél óra terepen.zip' },
]

function buildExportSlot(idx: number, text: string): { id: string; dayKey: string } {
    const id = String(99000000001 + idx)

    const startFromTable = text.match(/^\|\s*Kezdés\s*\|\s*(\d{4})\.\s*(\d{2})\.\s*(\d{2})\./m)
    if (!startFromTable) {
        throw new Error('A forrás markdown nem tartalmaz kinyerhető "Kezdés" mezőt az export-fixture dátumhoz.')
    }

    return {
        id,
        dayKey: `${startFromTable[1]}-${startFromTable[2]}-${startFromTable[3]}`,
    }
}

const EXPORT_FIXTURE_DIR = join(DATA_DIR, '_export-fixture')
const EXPORT_OUTPUT_PATH = join(DATA_DIR, 'export-results.md')

for (const { name, file } of TEST_FILES) {
    describe(name, () => {
        const buffer = readFileSync(join(DATA_DIR, file))
        const { text, errors } = processBuffer(buffer)

        // Golden-file: mindig felülíródik – git diff mutatja a változásokat
        const outputPath = join(DATA_DIR, `${name}.md`)
        writeFileSync(outputPath, text, 'utf8')

        it('nem üres kimenetet ad', () => {
            expect(text.length).toBeGreaterThan(0)
        })

        it('tartalmaz edzés összefoglalót', () => {
            expect(text).toContain('## Edzés összefoglaló')
            expect(text).toContain('| Adat | Érték |')
        })

        it('tartalmaz körök adatokat', () => {
            expect(text).toContain('## Körök')
            expect(text).toContain('| # | Táv (km) | Pace (min/km) |')
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

describe('results export összefűzés', () => {
    it('a korábbi tesztek md kimeneteit másolva exportálhatóan összefűzi', async () => {
        rmSync(EXPORT_FIXTURE_DIR, { recursive: true, force: true })
        mkdirSync(EXPORT_FIXTURE_DIR, { recursive: true })

        TEST_FILES.forEach(({ name }, idx) => {
            const sourcePath = join(DATA_DIR, `${name}.md`)
            expect(existsSync(sourcePath)).toBe(true)

            const text = readFileSync(sourcePath, 'utf8')
            expect(text.length).toBeGreaterThan(0)

            const slot = buildExportSlot(idx, text)
            const monthKey = slot.dayKey.slice(0, 7)
            const day = slot.dayKey.slice(8, 10)
            const targetDir = join(EXPORT_FIXTURE_DIR, monthKey, day)
            mkdirSync(targetDir, { recursive: true })
            writeFileSync(join(targetDir, `${slot.id}.md`), text, 'utf8')
        })

        const entries = await collectResultTextEntries(EXPORT_FIXTURE_DIR)
        const outputBuffer = await buildResultsMarkdown(entries)
        const outputText = outputBuffer.toString('utf8')

        writeFileSync(EXPORT_OUTPUT_PATH, outputText, 'utf8')

        expect(entries).toHaveLength(TEST_FILES.length)
        expect(outputText).toContain('# Garmin Download Results')
        expect(outputText).toContain('## Tartalomjegyzék')
        expect(outputText).toContain('### 2026-03')
        expect(outputText).toContain('### 2026-04')
        expect(outputText).toContain('#### Edzés összefoglaló')
        expect(outputText).not.toContain('ismeretlen idő • ismeretlen típus')
    })
})
