import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTrainingPeaksWorkoutStore, type TrainingPeaksWorkoutInput, type TrainingPeaksComment } from '../server/trainingpeaks/workoutStore'
import { reprocessWorkoutByGarminId } from '../server/shared/routes'

const TEST_DATA_DIR = join(import.meta.dirname, 'data')
const TP_FIXTURE_DIR = join(TEST_DATA_DIR, 'TrainingPeaks')
const TMP_DIR = join(TEST_DATA_DIR, '_tmp-reprocess-by-id')
const TMP_DB_PATH = join(TMP_DIR, 'trainingpeaks-workouts.sqlite')
const TMP_DATA_DIR = join(TMP_DIR, 'data')
const GARMIN_ARCHIVE_DIR = join(TEST_DATA_DIR, 'Garmin')

function toInputFromFixture(filePath: string): TrainingPeaksWorkoutInput {
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

describe('reprocess by id', () => {
    beforeEach(() => {
        rmSync(TMP_DIR, { recursive: true, force: true })
        mkdirSync(TMP_DATA_DIR, { recursive: true })
    })

    afterEach(() => {
        rmSync(TMP_DIR, { recursive: true, force: true })
    })

    it('reprocesses Garmin activity by Garmin ID and returns markdown', async () => {
        const result = await reprocessWorkoutByGarminId(GARMIN_ARCHIVE_DIR, '22417526163')
        const markdown = readFileSync(result.mdPath, 'utf8')

        expect(markdown.length).toBeGreaterThan(100)
        expect(markdown).toContain('## Edzés összefoglaló')
        expect(result.mdPath.endsWith('22417526163.md')).toBe(true)
        expect(existsSync(result.mdPath)).toBe(true)
    })

    it('resolves linked TP workout to Garmin activity and reprocesses with TP section', async () => {
        const fixtureRel = '2026-04/05/3655297128.json'
        const fixtureSrc = join(TP_FIXTURE_DIR, fixtureRel)
        const fixtureDst = join(TMP_DATA_DIR, 'TrainingPeaks', fixtureRel)
        mkdirSync(join(fixtureDst, '..'), { recursive: true })
        writeFileSync(fixtureDst, readFileSync(fixtureSrc))

        const store = createTrainingPeaksWorkoutStore(TMP_DB_PATH, TMP_DATA_DIR)
        store.upsertWorkouts([toInputFromFixture(fixtureSrc)])
        store.linkGarminActivity('3655297128', '22417526163')

        const linked = store.getByWorkoutId('3655297128')
        expect(linked?.garminActivityId).toBe('22417526163')

        const result = await reprocessWorkoutByGarminId(GARMIN_ARCHIVE_DIR, linked!.garminActivityId, store)
        const markdown = readFileSync(result.mdPath, 'utf8')

        expect(markdown).toContain('Aktivitás neve: 70 perc kötetlen')
        expect(markdown).toContain('TSS: 99 rTSS')
        expect(markdown).toContain('### Kommentek')
    })
})
