import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

export interface DescriptionMaskTimeRange {
    start: string
    end: string
}

export interface DescriptionMaskRule {
    workoutType?: string
    nameEquals?: string[]
    nameContains?: string[]
    dayOfWeek?: string[]
    timeRange?: DescriptionMaskTimeRange
}

interface DescriptionMaskConfig {
    maskDescriptionRules?: DescriptionMaskRule[]
}

let cachePath = ''
let cacheMtimeMs = -1
let cacheRules: DescriptionMaskRule[] = []

function normalize(value: string): string {
    return String(value ?? '').trim().toLowerCase()
}

function parseHm(value: string): number | null {
    const m = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})$/)
    if (!m) return null
    const h = Number(m[1])
    const min = Number(m[2])
    if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null
    return h * 60 + min
}

function dayAliases(): Record<string, number> {
    return {
        vasarnap: 0,
        vasárnap: 0,
        sunday: 0,
        hetfo: 1,
        hétfő: 1,
        monday: 1,
        kedd: 2,
        tuesday: 2,
        szerda: 3,
        wednesday: 3,
        csutortok: 4,
        csütörtök: 4,
        thursday: 4,
        pentek: 5,
        péntek: 5,
        friday: 5,
        szombat: 6,
        saturday: 6,
    }
}

function getConfigPath(): string {
    const fromEnv = String(process.env.TP_DESCRIPTION_MASK_CONFIG ?? '').trim()
    if (fromEnv) return resolve(fromEnv)
    return resolve(process.cwd(), 'data', 'TrainingPeaks', 'description-mask-rules.json')
}

function loadRules(): DescriptionMaskRule[] {
    const path = getConfigPath()
    if (!existsSync(path)) {
        cachePath = path
        cacheMtimeMs = -1
        cacheRules = []
        return cacheRules
    }

    const mtimeMs = statSync(path).mtimeMs
    if (cachePath === path && cacheMtimeMs === mtimeMs) {
        return cacheRules
    }

    try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as DescriptionMaskConfig
        cachePath = path
        cacheMtimeMs = mtimeMs
        cacheRules = Array.isArray(raw.maskDescriptionRules) ? raw.maskDescriptionRules : []
        return cacheRules
    } catch {
        cachePath = path
        cacheMtimeMs = mtimeMs
        cacheRules = []
        return cacheRules
    }
}

function parseLocalDateTime(value: string): Date | null {
    const trimmed = String(value ?? '').trim()
    if (!trimmed) return null
    const d = new Date(trimmed)
    if (!Number.isNaN(d.getTime())) return d

    const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/)
    if (!m) return null
    const y = Number(m[1])
    const mo = Number(m[2]) - 1
    const day = Number(m[3])
    const h = Number(m[4])
    const mi = Number(m[5])
    const s = Number(m[6] ?? 0)
    return new Date(y, mo, day, h, mi, s)
}

function matchRule(tp: Record<string, unknown>, rule: DescriptionMaskRule): boolean {
    const workoutType = normalize(String(tp.workoutType ?? ''))
    const name = normalize(String(tp.name ?? ''))

    if (rule.workoutType && normalize(rule.workoutType) !== workoutType) return false

    if (Array.isArray(rule.nameEquals) && rule.nameEquals.length > 0) {
        const equalsList = rule.nameEquals.map(normalize).filter(Boolean)
        if (!equalsList.includes(name)) return false
    }

    if (Array.isArray(rule.nameContains) && rule.nameContains.length > 0) {
        const containsList = rule.nameContains.map(normalize).filter(Boolean)
        if (!containsList.some((part) => part && name.includes(part))) return false
    }

    if (Array.isArray(rule.dayOfWeek) && rule.dayOfWeek.length > 0) {
        const date = parseLocalDateTime(String(tp.workoutStart ?? ''))
        if (!date) return false
        const day = date.getDay()
        const dayMap = dayAliases()
        const wanted = rule.dayOfWeek
            .map((v) => dayMap[normalize(v)])
            .filter((v): v is number => Number.isFinite(v))
        if (!wanted.includes(day)) return false
    }

    if (rule.timeRange) {
        const date = parseLocalDateTime(String(tp.workoutStart ?? ''))
        if (!date) return false
        const start = parseHm(rule.timeRange.start)
        const end = parseHm(rule.timeRange.end)
        if (start === null || end === null) return false
        const current = date.getHours() * 60 + date.getMinutes()
        if (current < start || current > end) return false
    }

    return true
}

export function shouldMaskTpDescription(tp: Record<string, unknown>): boolean {
    const rules = loadRules()
    if (rules.length === 0) return false
    return rules.some((rule) => matchRule(tp, rule))
}

export function shouldMaskTpDescriptionWithRules(tp: Record<string, unknown>, rules: DescriptionMaskRule[]): boolean {
    return (rules ?? []).some((rule) => matchRule(tp, rule))
}
