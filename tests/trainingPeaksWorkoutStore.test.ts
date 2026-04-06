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
    { relPath: '2026-04/01/3640712028.json', workoutId: '3640712028' },
    { relPath: '2026-04/04/3655296297.json', workoutId: '3655296297' },
    { relPath: '2026-04/05/3655297128.json', workoutId: '3655297128' },
    { relPath: '2026-04/05/3665674049.json', workoutId: '3665674049' },
    { relPath: '2026-04/05/3665734922.json', workoutId: '3665734922' },
]

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
    beforeEach(() => {
        rmSync(TMP_DIR, { recursive: true, force: true })
        mkdirSync(TMP_DATA_DIR, { recursive: true })
    })

    afterEach(() => {
        rmSync(TMP_DIR, { recursive: true, force: true })
    })

    it('loads TP fixtures and matches workouts by Garmin start datetime', () => {
        const store = createTrainingPeaksWorkoutStore(TMP_DB_PATH, TMP_DATA_DIR)
        const inputs = copyFixturesToTempDataDir()
        const summary = store.upsertWorkouts(inputs)

        expect(summary.received).toBe(TP_FIXTURES.length)

        const runMatch = store.findByDateTimeNear('2026-04-05T15:18:24', 60)
        expect(runMatch?.workoutId).toBe('3655297128')
        expect(runMatch?.filePath).toContain('TrainingPeaks/2026-04/05/3655297128.json')

        const trailMatch = store.findByDateTimeNear('2026-04-04T10:11:25', 60)
        expect(trailMatch?.workoutId).toBe('3655296297')

        const vo2Match = store.findByDateTimeNear('2026-04-01T06:17:28', 60)
        expect(vo2Match?.workoutId).toBe('3640712028')
    })

    it('keeps matching deterministic near two same-day bike workouts', () => {
        const store = createTrainingPeaksWorkoutStore(TMP_DB_PATH, TMP_DATA_DIR)
        store.upsertWorkouts(copyFixturesToTempDataDir())

        const firstBike = store.findByDateTimeNear('2026-04-05T14:53:21', 60)
        expect(firstBike?.workoutId).toBe('3665674049')

        const secondBike = store.findByDateTimeNear('2026-04-05T16:54:49', 60)
        expect(secondBike?.workoutId).toBe('3665734922')
    })
})
