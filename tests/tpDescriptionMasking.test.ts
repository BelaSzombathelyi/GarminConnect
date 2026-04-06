import { describe, expect, it } from 'vitest'
import { shouldMaskTpDescriptionWithRules, type DescriptionMaskRule } from '../server/trainingpeaks/descriptionMasking'

const rules: DescriptionMaskRule[] = [
    {
        workoutType: 'Other',
        nameEquals: ['Hengerezés'],
        dayOfWeek: ['Friday', 'Péntek'],
        timeRange: { start: '00:00', end: '11:59' },
    },
    {
        workoutType: 'Strength',
        nameContains: ['H10'],
    },
    {
        workoutType: 'Strength',
        nameEquals: ['Gerinctorna', 'Gerinctorna Judittal'],
    },
]

describe('tp description masking rules', () => {
    it('masks Hengerezés on Friday morning for Other workout', () => {
        const tp = {
            workoutType: 'Other',
            name: 'Hengerezés',
            workoutStart: '2026-04-03T07:58:57',
        }
        expect(shouldMaskTpDescriptionWithRules(tp, rules)).toBe(true)
    })

    it('does not mask Hengerezés on Friday afternoon', () => {
        const tp = {
            workoutType: 'Other',
            name: 'Hengerezés',
            workoutStart: '2026-04-03T13:05:00',
        }
        expect(shouldMaskTpDescriptionWithRules(tp, rules)).toBe(false)
    })

    it('masks H10 strength workouts', () => {
        const tp = {
            workoutType: 'Strength',
            name: 'H10 erősítő blokk',
            workoutStart: '2026-04-02T18:00:00',
        }
        expect(shouldMaskTpDescriptionWithRules(tp, rules)).toBe(true)
    })

    it('masks Gerinctorna and Gerinctorna Judittal strength workouts', () => {
        expect(
            shouldMaskTpDescriptionWithRules(
                {
                    workoutType: 'Strength',
                    name: 'Gerinctorna',
                    workoutStart: '2026-04-06T18:00:00',
                },
                rules,
            ),
        ).toBe(true)

        expect(
            shouldMaskTpDescriptionWithRules(
                {
                    workoutType: 'Strength',
                    name: 'Gerinctorna Judittal',
                    workoutStart: '2026-04-06T18:00:00',
                },
                rules,
            ),
        ).toBe(true)
    })
})
