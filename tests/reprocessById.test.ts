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
        completedTotalTime: String(raw.completedTotalTime ?? raw.totalTime ?? ''),
        completedDistance: String(raw.completedDistance ?? raw.distance ?? ''),
        completedTssValue: String(raw.completedTssValue ?? raw.tssValue ?? ''),
        completedTssUnit: String(raw.completedTssUnit ?? raw.tssUnit ?? ''),
        description: String(raw.description ?? ''),
        comments: Array.isArray(raw.comments) ? (raw.comments as TrainingPeaksComment[]) : [],
        raw: { workoutId: String(raw.workoutId ?? '') },
    }
}

describe('reprocess by id', () => {
    let openStore: ReturnType<typeof createTrainingPeaksWorkoutStore> | null = null

    beforeEach(() => {
        rmSync(TMP_DIR, { recursive: true, force: true })
        mkdirSync(TMP_DATA_DIR, { recursive: true })
    })

    afterEach(() => {
        openStore?.close()
        openStore = null
        rmSync(TMP_DIR, { recursive: true, force: true })
    })

    it('reprocesses Garmin activity by Garmin ID and returns markdown', async () => {
        const result = await reprocessWorkoutByGarminId(GARMIN_ARCHIVE_DIR, '22417526163')
        const markdown = readFileSync(result.mdPath, 'utf8')

        expect(markdown.length).toBeGreaterThan(100)
        expect(markdown).toContain('Sport profil:')
        expect(result.mdPath.endsWith('22417526163.md')).toBe(true)
        expect(existsSync(result.mdPath)).toBe(true)
    })

    it('resolves linked TP workout to Garmin activity and reprocesses with TP section', async () => {
        const fixtureRel = '2026-05/11/3719988536.json'
        const fixtureSrc = join(TP_FIXTURE_DIR, fixtureRel)
        const fixtureDst = join(TMP_DATA_DIR, 'TrainingPeaks', fixtureRel)
        mkdirSync(join(fixtureDst, '..'), { recursive: true })
        writeFileSync(fixtureDst, readFileSync(fixtureSrc))

        const store = createTrainingPeaksWorkoutStore(TMP_DB_PATH, TMP_DATA_DIR)
        openStore = store
        store.upsertWorkouts([toInputFromFixture(fixtureSrc)])
        store.linkGarminActivity('3719988536', '22839150987')

        const linked = store.getByWorkoutId('3719988536')
        expect(linked?.garminActivityId).toBe('22839150987')

        const result = await reprocessWorkoutByGarminId(GARMIN_ARCHIVE_DIR, linked!.garminActivityId, store)
        const markdown = readFileSync(result.mdPath, 'utf8')

        // Az `Aktivitás neve` sor felesleges, ha a markdown cím a FIT wktName-t mutatja.
        expect(markdown).not.toContain('Aktivitás neve:')
        expect(markdown).toContain('TSS: 81 rTSS')
        expect(markdown).toContain('### Kommentek')
    })
})
