import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
    createTrainingPeaksWorkoutStore,
    type TrainingPeaksWorkoutInput,
    type TrainingPeaksComment,
} from '../server/trainingpeaks/workoutStore'

const TEST_DATA_DIR = join(import.meta.dirname, 'data')
const TP_FIXTURE_DIR = join(TEST_DATA_DIR, 'TrainingPeaks')
const TMP_DIR = join(TEST_DATA_DIR, '_tmp-trainingpeaks-store')
const TMP_DB_PATH = join(TMP_DIR, 'trainingpeaks-workouts.sqlite')
const TMP_DATA_DIR = join(TMP_DIR, 'data')

interface TpFixtureFile {
    relPath: string
    workoutId: string
}

const TP_FIXTURES: TpFixtureFile[] = [
    { relPath: '2026-05/11/3719988536.json', workoutId: '3719988536' },
]

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

function copyFixturesToTempDataDir(): TrainingPeaksWorkoutInput[] {
    const inputs: TrainingPeaksWorkoutInput[] = []

    for (const fixture of TP_FIXTURES) {
        const srcPath = join(TP_FIXTURE_DIR, fixture.relPath)
        expect(existsSync(srcPath)).toBe(true)
        inputs.push(toInputFromFixture(srcPath))

        const dstPath = join(TMP_DATA_DIR, 'TrainingPeaks', fixture.relPath)
        mkdirSync(join(dstPath, '..'), { recursive: true })
        writeFileSync(dstPath, readFileSync(srcPath))
    }

    return inputs
}

describe('trainingpeaks workout store fixtures', () => {
    let openStore: ReturnType<typeof createTrainingPeaksWorkoutStore> | null = null

    beforeEach(() => {
        rmSync(TMP_DIR, { recursive: true, force: true })
        mkdirSync(TMP_DATA_DIR, { recursive: true })
    })

    afterEach(() => {
        // Windows alatt a SQLite handle-t le kell zárni, mielőtt töröljük a
        // mappát, különben EBUSY-val esik el az unlink.
        openStore?.close()
        openStore = null
        rmSync(TMP_DIR, { recursive: true, force: true })
    })

    it('loads TP fixtures and matches workouts by Garmin start datetime', () => {
        const store = createTrainingPeaksWorkoutStore(TMP_DB_PATH, TMP_DATA_DIR)
        openStore = store
        const inputs = copyFixturesToTempDataDir()
        const summary = store.upsertWorkouts(inputs)

        expect(summary.received).toBe(TP_FIXTURES.length)

        const runMatch = store.findByDateTimeNear('2026-05-11T06:47:45', 60)
        expect(runMatch?.workoutId).toBe('3719988536')
        // Útvonal-szeparátor platform-független ellenőrzése.
        expect(runMatch?.filePath.replace(/\\/g, '/')).toContain('TrainingPeaks/2026-05/11/3719988536.json')

        // ±60s toleranciasáv: 30 másodperccel későbbi indítás még illeszkedik.
        const runMatchNear = store.findByDateTimeNear('2026-05-11T06:48:15', 60)
        expect(runMatchNear?.workoutId).toBe('3719988536')

        // Túl messzi datetime nem ad találatot.
        const noMatch = store.findByDateTimeNear('2026-05-11T09:00:00', 60)
        expect(noMatch).toBeNull()
    })

    it('links Garmin activity ID to workout and resolves both directions', () => {
        const store = createTrainingPeaksWorkoutStore(TMP_DB_PATH, TMP_DATA_DIR)
        openStore = store
        store.upsertWorkouts(copyFixturesToTempDataDir())

        // A nyers TP export még nem tartalmaz garminActivityId-t — azt a
        // reprocess útvonal írja be a `linkGarminActivity` hívással, miután a
        // datetime alapján megtalálta az aktivitást.
        store.linkGarminActivity('3719988536', '22839150987')

        const workout = store.getByWorkoutId('3719988536')
        expect(workout).not.toBeNull()
        expect(String(workout?.garminActivityId ?? '')).toBe('22839150987')

        const byGarmin = store.getByGarminActivityId('22839150987')
        expect(byGarmin?.workoutId).toBe('3719988536')
    })
})
