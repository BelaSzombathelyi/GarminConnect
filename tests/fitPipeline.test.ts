import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { processBuffer } from '../server/garmin/fitPipeline'
import { buildResultsMarkdown, buildResultTextEntryFromText, compareResultEntries } from '../server/shared/resultsExporter'
import { createTrainingPeaksWorkoutStore, type TrainingPeaksWorkoutInput, type TrainingPeaksComment } from '../server/trainingpeaks/workoutStore'

const DATA_DIR = join(import.meta.dirname, 'data')
const GARMIN_DATA_DIR = join(DATA_DIR, 'Garmin')

const TEST_FILES = [
    { name: 'Vivicitta', activityId: '22257203916', dayKey: '2026-03-22' },
    { name: 'BSzM 4', activityId: '22025969195', dayKey: '2026-03-01' },
    { name: 'VO2max interval', activityId: '22367706617', dayKey: '2026-04-01' },
    { name: 'Almádi fagyizás', activityId: '22417526163', dayKey: '2026-04-05' },
    { name: 'Solymár - 3fél óra terepen', activityId: '22403957560', dayKey: '2026-04-04' },
]

function activityFilePath(dayKey: string, activityId: string, ext: 'zip' | 'md'): string {
    const monthKey = dayKey.slice(0, 7)
    const day = dayKey.slice(8, 10)
    return join(GARMIN_DATA_DIR, monthKey, day, `${activityId}.${ext}`)
}

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
const sharedTpDbPath = join(TP_FIXTURE_DIR, 'trainingpeaks-workouts.sqlite')
rmSync(sharedTpDbPath, { force: true })
const sharedTpStore = createTrainingPeaksWorkoutStore(sharedTpDbPath, DATA_DIR)
const allTpFixtures = findJsonFiles(TP_FIXTURE_DIR)
if (allTpFixtures.length > 0) {
    sharedTpStore.upsertWorkouts(allTpFixtures.map(toTpInputFromFixture))
}

for (const { name, activityId, dayKey } of TEST_FILES) {
    describe(name, () => {
        const buffer = readFileSync(activityFilePath(dayKey, activityId, 'zip'))
        const { text, errors } = processBuffer(buffer, { tpStore: sharedTpStore })

        // Golden-file: mindig felülíródik – git diff mutatja a változásokat
        const outputPath = activityFilePath(dayKey, activityId, 'md')
        writeFileSync(outputPath, text, 'utf8')

        it('nem üres kimenetet ad', () => {
            expect(text.length).toBeGreaterThan(0)
        })

        it('tartalmaz edzés összefoglalót', () => {
            expect(text).toContain('## Edzés összefoglaló')
            expect(text).toContain('Sport profil:')
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

        const runZip = readFileSync(activityFilePath('2026-04-05', '22417526163', 'zip'))
        const { text } = processBuffer(runZip, { activityId: '99000000004', tpStore })

        expect(text.startsWith('## Summary')).toBe(true)
        expect(text).toContain('TSS: 99 rTSS')
        expect(text).toContain('Edzői instrukciók:')
        expect(text).toContain('## Edzés összefoglaló')

        rmSync(tmpTpDir, { recursive: true, force: true })
    })
})

describe('results export összefűzés', () => {
    it('a korábbi tesztek md kimeneteit összefűzi', async () => {
        const entries = TEST_FILES.map(({ activityId, dayKey }, idx) => {
            const sourcePath = activityFilePath(dayKey, activityId, 'md')
            expect(existsSync(sourcePath)).toBe(true)
            const text = readFileSync(sourcePath, 'utf8')
            expect(text.length).toBeGreaterThan(0)
            return buildResultTextEntryFromText(text, String(99000000001 + idx))
        })
        entries.sort(compareResultEntries)

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
