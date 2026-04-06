import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { processBuffer } from '../server/garmin/fitPipeline'
import { buildResultsMarkdown, collectResultTextEntries } from '../server/shared/resultsExporter'
import { createTrainingPeaksWorkoutStore, type TrainingPeaksWorkoutInput, type TrainingPeaksComment } from '../server/trainingpeaks/workoutStore'

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
const TP_FIXTURE_DIR = join(DATA_DIR, 'TrainingPeaks')

function toTpInputFromFixture(filePath: string): TrainingPeaksWorkoutInput {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
    return {
        rowKey: String(raw.rowKey ?? ''),
        name: String(raw.name ?? ''),
        workoutStart: String(raw.workoutStart ?? ''),
        workoutType: String(raw.workoutType ?? ''),
        totalTime: String(raw.totalTime ?? ''),
        distance: String(raw.distance ?? ''),
        tssValue: String(raw.tssValue ?? ''),
        tssUnit: String(raw.tssUnit ?? ''),
        description: String(raw.description ?? ''),
        comments: Array.isArray(raw.comments) ? (raw.comments as TrainingPeaksComment[]) : [],
        raw: { workoutId: String(raw.workoutId ?? '') },
    }
}

function findJsonFiles(dir: string): string[] {
    const results: string[] = []
    if (!existsSync(dir)) return results
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) results.push(...findJsonFiles(full))
        else if (entry.name.endsWith('.json')) results.push(full)
    }
    return results
}

// Megosztott TP store a golden fájlok TP-vel való gazdagításához
const sharedTpDbPath = join(DATA_DIR, '_tmp-golden-tp.sqlite')
rmSync(sharedTpDbPath, { force: true })
const sharedTpStore = createTrainingPeaksWorkoutStore(sharedTpDbPath, DATA_DIR)
const allTpFixtures = findJsonFiles(TP_FIXTURE_DIR)
if (allTpFixtures.length > 0) {
    sharedTpStore.upsertWorkouts(allTpFixtures.map(toTpInputFromFixture))
}

for (const { name, file } of TEST_FILES) {
    describe(name, () => {
        const buffer = readFileSync(join(DATA_DIR, file))
        const { text, errors } = processBuffer(buffer, { tpStore: sharedTpStore })

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

describe('fitPipeline TP enrich', () => {
    it('processBuffer TP blokkot fuz, ha tpStore es datetime egyezes van', () => {
        const tmpTpDir = join(DATA_DIR, '_tmp-fitpipeline-tp')
        const tmpTpDataDir = join(tmpTpDir, 'data')
        const tmpTpDb = join(tmpTpDir, 'trainingpeaks-workouts.sqlite')

        rmSync(tmpTpDir, { recursive: true, force: true })
        mkdirSync(tmpTpDataDir, { recursive: true })

        const fixtureRel = '2026-04/05/3655297128.json'
        const fixtureSrc = join(TP_FIXTURE_DIR, fixtureRel)
        expect(existsSync(fixtureSrc)).toBe(true)

        const fixtureDst = join(tmpTpDataDir, 'TrainingPeaks', fixtureRel)
        mkdirSync(join(fixtureDst, '..'), { recursive: true })
        writeFileSync(fixtureDst, readFileSync(fixtureSrc))

        const tpStore = createTrainingPeaksWorkoutStore(tmpTpDb, tmpTpDataDir)
        tpStore.upsertWorkouts([toTpInputFromFixture(fixtureSrc)])

        const runZip = readFileSync(join(DATA_DIR, 'Alsoors-Almadai-fagyi-Alsoors.zip'))
        const { text } = processBuffer(runZip, { activityId: '99000000004', tpStore })

        expect(text.startsWith('## TrainingPeaks')).toBe(true)
        expect(text).toContain('| Aktivitás neve | 70 perc kötetlen |')
        expect(text).toContain('## Edzés összefoglaló')

        rmSync(tmpTpDir, { recursive: true, force: true })
    })
})

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
