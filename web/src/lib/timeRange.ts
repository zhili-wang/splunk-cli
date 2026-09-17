/**
 * Time-range presets.
 *
 * Deliberately no validation. The backend's SafetyPolicy owns the limits, and a
 * range it rejects comes back as a SafetyLimitError that the dashboard shows
 * verbatim. Re-implementing the ceiling here would either block a range Splunk
 * accepts or promise a bound the frontend cannot enforce.
 */

import { getLocale, translate, type Locale, type MessageKey } from './i18n'

/**
 * Presets, grouped the way the operator thinks about them.
 *
 * Every literal here was run against a live Splunk: `@d` / `@w0` / `@mon` / `@y`
 * are the standard calendar forms, and all of them are accepted. They are listed
 * rather than generated because the literal *is* the contract — `-7d@w0 → @w0`
 * is a different window from `-7d → now`, and only naming it keeps that visible.
 *
 * The 最近 group stops at 7 days: that is the backend's default ceiling, so a
 * "last 30 days" preset would fail every time it was clicked. The 日历 group is
 * written with snaps (`@mon` … `now`), which the backend hands to Splunk
 * unevaluated — that is the only reason month- and year-scoped windows can be
 * offered at all, and it is also why the picker says the width is evaluated by
 * Splunk rather than printing a number it cannot know. Anything else is
 * reachable through the custom editor, where a refusal is explained rather than
 * pre-empted.
 *
 * Each heading and preset carries a message key instead of its text. The text
 * lives in `src/locales`; the key is typed against the Chinese catalog, so a
 * heading naming a message nobody wrote is a compile error rather than a blank
 * button.
 */

/** One heading in the picker, and the presets filed under it. */
interface PresetGroup {
  readonly titleKey: MessageKey
  readonly presets: readonly {
    readonly id: string
    readonly labelKey: MessageKey
    readonly range: ResolvedRange
  }[]
}

export const TIME_PRESET_GROUPS = [
  {
    titleKey: 'timeRange.groups.recent',
    presets: [
      { id: '5m', labelKey: 'timeRange.presets.m5', range: { earliest: '-5m', latest: 'now' } },
      { id: '15m', labelKey: 'timeRange.presets.m15', range: { earliest: '-15m', latest: 'now' } },
      { id: '30m', labelKey: 'timeRange.presets.m30', range: { earliest: '-30m', latest: 'now' } },
      { id: '1h', labelKey: 'timeRange.presets.h1', range: { earliest: '-1h', latest: 'now' } },
      { id: '4h', labelKey: 'timeRange.presets.h4', range: { earliest: '-4h', latest: 'now' } },
      { id: '12h', labelKey: 'timeRange.presets.h12', range: { earliest: '-12h', latest: 'now' } },
      { id: '24h', labelKey: 'timeRange.presets.h24', range: { earliest: '-24h', latest: 'now' } },
      { id: '7d', labelKey: 'timeRange.presets.d7', range: { earliest: '-7d', latest: 'now' } },
    ],
  },
  {
    titleKey: 'timeRange.groups.calendar',
    presets: [
      {
        id: 'today',
        labelKey: 'timeRange.presets.today',
        range: { earliest: '@d', latest: 'now' },
      },
      {
        id: 'yesterday',
        labelKey: 'timeRange.presets.yesterday',
        range: { earliest: '-1d@d', latest: '@d' },
      },
      {
        id: 'this-week',
        labelKey: 'timeRange.presets.thisWeek',
        range: { earliest: '@w', latest: 'now' },
      },
      {
        id: 'last-week',
        labelKey: 'timeRange.presets.lastWeek',
        range: { earliest: '-7d@w0', latest: '@w0' },
      },
      {
        id: 'this-month',
        labelKey: 'timeRange.presets.thisMonth',
        range: { earliest: '@mon', latest: 'now' },
      },
      {
        id: 'last-month',
        labelKey: 'timeRange.presets.lastMonth',
        range: { earliest: '-1mon@mon', latest: '@mon' },
      },
      {
        id: 'this-year',
        labelKey: 'timeRange.presets.thisYear',
        range: { earliest: '@y', latest: 'now' },
      },
      {
        id: 'last-year',
        labelKey: 'timeRange.presets.lastYear',
        range: { earliest: '-1y@y', latest: '@y' },
      },
    ],
  },
] as const satisfies readonly PresetGroup[]

/** One entry in the picker: the literal pair, plus how it is labelled. */
export type TimePreset = (typeof TIME_PRESET_GROUPS)[number]['presets'][number]

/**
 * Every preset, in the order the picker shows them.
 *
 * The annotation is load-bearing: `flatMap` cannot infer a common element type
 * from a tuple of two differently-shaped tuples on its own.
 */
export const TIME_PRESETS: readonly TimePreset[] = TIME_PRESET_GROUPS.flatMap<TimePreset>(
  (group) => [...group.presets],
)

/** A preset id, or `custom` for the editor. */
export type PresetId = TimePreset['id'] | 'custom'

export interface ResolvedRange {
  earliest: string
  latest: string
}

/** Where the custom editor starts when nothing better is known. */
export const DEFAULT_CUSTOM: ResolvedRange = { earliest: '-1h', latest: 'now' }

/**
 * The window the custom editor is able to display.
 *
 * A calendar window (`@mon` … `now`) has no locally resolvable endpoints, and a
 * `datetime-local` input cannot render a snap: opening the editor on one would
 * show two blank fields and a summary line that contradicts them. Such a window
 * therefore falls back to the default — the operator is about to name a window
 * anyway, and the editor states which one is in effect.
 */
export function editableRange(range: ResolvedRange): ResolvedRange {
  const resolvable =
    resolveToIso(range.earliest) !== null && resolveToIso(range.latest) !== null
  return resolvable ? range : DEFAULT_CUSTOM
}

/** Turn a preset into the earliest/latest pair the API expects. */
export function presetToRange(preset: PresetId, custom?: ResolvedRange): ResolvedRange {
  if (preset === 'custom') return custom ?? DEFAULT_CUSTOM
  const found = TIME_PRESETS.find((item) => item.id === preset)
  return found === undefined ? DEFAULT_CUSTOM : { ...found.range }
}

const UNIT_SECONDS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86400 }

/** Spans Splunk understands, coarse to fine. */
const SPANS: ReadonlyArray<{ span: string; seconds: number }> = [
  { span: '1s', seconds: 1 },
  { span: '5s', seconds: 5 },
  { span: '10s', seconds: 10 },
  { span: '30s', seconds: 30 },
  { span: '1m', seconds: 60 },
  { span: '5m', seconds: 300 },
  { span: '10m', seconds: 600 },
  { span: '30m', seconds: 1800 },
  { span: '1h', seconds: 3600 },
  { span: '3h', seconds: 10800 },
  { span: '12h', seconds: 43200 },
  { span: '1d', seconds: 86400 },
  { span: '7d', seconds: 604800 },
]

/**
 * Buckets we are willing to draw.
 *
 * The backend caps a timeline at 500 buckets and truncates with `head`, so a
 * span that is too fine does not merely look dense — it silently covers only the
 * beginning of the requested window. 120 keeps the axis readable and the whole
 * range honest.
 */
const TARGET_BUCKETS = 120

/**
 * The backend's bucket cap, mirrored from `MAX_BUCKETS` in
 * `server/services/timeline.ts`.
 *
 * Mirrored rather than fetched because the dashboard has to *notice* when a
 * timeline came back full — a full result does not mean the window was covered.
 */
export const MAX_TIMELINE_BUCKETS = 500

/**
 * The span used when only Splunk can measure the window.
 *
 * A snapped window (`@mon` … `now`) has no locally computable width, and picking
 * a fine span for it is the one genuinely harmful guess: the backend trims a
 * timeline with `head`, so the histogram would silently draw the beginning of
 * the window and contradict the event table underneath it. Daily buckets keep
 * the cap covering 500 days, which is more than the picker can ask for, so the
 * failure mode becomes "coarse" rather than "missing time".
 */
const UNKNOWN_WIDTH_SPAN = '1d'

/** Seconds represented by a span such as `5m`. */
export function spanSeconds(span: string): number | null {
  const match = /^(\d+)([smhd])$/.exec(span)
  if (match === null) return null
  return Number(match[1]) * (UNIT_SECONDS[match[2] as string] ?? 0)
}

/**
 * Resolve a time literal to epoch seconds, or `null` when only Splunk can.
 *
 * Mirrors what the backend accepts (relative, ISO-8601, epoch) and gives up on
 * the snapped forms (`-1d@d`), which are evaluated server-side.
 */
export function toEpochSeconds(value: string, now: number = Date.now()): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.toLowerCase() === 'now') return Math.floor(now / 1000)
  if (trimmed.includes('@')) return null

  const relative = /^-?(\d+)([smhd])$/.exec(trimmed)
  if (relative !== null) {
    // A bare `15m` means the same as `-15m`: "15 minutes back".
    const seconds = Number(relative[1]) * (UNIT_SECONDS[relative[2] as string] ?? 0)
    return Math.floor(now / 1000) - seconds
  }

  if (/^\d{9,11}(\.\d+)?$/.test(trimmed)) return Math.floor(Number(trimmed))
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const parsed = Date.parse(trimmed)
    return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000)
  }
  return null
}

/** Width of a window in seconds, or `null` when it cannot be known locally. */
export function rangeWidthSeconds(
  earliest: string,
  latest: string,
  now: number = Date.now(),
): number | null {
  const start = toEpochSeconds(earliest, now)
  const end = toEpochSeconds(latest, now)
  if (start === null || end === null) return null
  const width = end - start
  return width > 0 ? width : null
}

/**
 * Pick a bucket width that covers the whole window without exceeding the
 * backend's bucket cap.
 */
export function pickSpan(earliest: string, latest: string, now: number = Date.now()): string {
  const width = rangeWidthSeconds(earliest, latest, now)
  if (width === null) return UNKNOWN_WIDTH_SPAN
  for (const candidate of SPANS) {
    if (width / candidate.seconds <= TARGET_BUCKETS) return candidate.span
  }
  return SPANS[SPANS.length - 1]?.span ?? '7d'
}

/**
 * The exclusive end of a bucket that started at `iso`.
 *
 * Selecting a bucket on the timeline means "this bucket"; the API wants a
 * half-open window, so `latest` is the start of the next one.
 */
export function endOfSpan(iso: string, span: string): string {
  const seconds = spanSeconds(span)
  const start = Date.parse(iso)
  if (seconds === null || Number.isNaN(start)) return iso
  return new Date(start + seconds * 1000).toISOString()
}

/** A time unit the editor offers. */
export type TimeUnit = 's' | 'm' | 'h' | 'd'

/** Read `-15m` (or `15m`) back into an amount and a unit, for editing. */
export function parseRelative(value: string): { amount: number; unit: TimeUnit } | null {
  const match = /^-?(\d+)([smhd])$/.exec(value.trim())
  if (match === null) return null
  const amount = Number(match[1])
  if (!Number.isInteger(amount) || amount <= 0) return null
  return { amount, unit: match[2] as TimeUnit }
}

/**
 * The largest unit that divides `seconds` exactly, as a relative literal.
 *
 * Used when swapping the editor from an absolute window back to a relative one,
 * so `2 hours` becomes `-2h` rather than `-1h` or `-120m`.
 */
export function toRelativeLiteral(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const ladder: ReadonlyArray<[TimeUnit, number]> = [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ]
  for (const [unit, size] of ladder) {
    if (seconds % size === 0) return `-${seconds / size}${unit}`
  }
  return null
}

/** Resolve any accepted literal to an absolute instant, or `null` if only Splunk can. */
export function resolveToIso(value: string, now: number = Date.now()): string | null {
  const epoch = toEpochSeconds(value, now)
  if (epoch === null) return null
  return new Date(epoch * 1000).toISOString()
}

/**
 * The wall-clock value a `<input type="datetime-local">` needs.
 *
 * Local time and no offset, because that is the only thing the control accepts —
 * which is also why the editor is friendlier than the raw literal it replaces.
 * Returns `''` for a literal this cannot resolve, leaving the picker empty
 * rather than showing a wrong time.
 */
export function toDatetimeLocal(value: string, now: number = Date.now()): string {
  const epoch = toEpochSeconds(value, now)
  if (epoch === null) return ''
  const date = new Date(epoch * 1000)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** What the picker hands back, as an API-ready instant. */
export function fromDatetimeLocal(value: string): string | null {
  if (value.trim() === '') return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/** A window width an operator can read at a glance. */
export function formatDuration(seconds: number, locale: Locale = getLocale()): string {
  const ladder: ReadonlyArray<[MessageKey, number]> = [
    ['timeRange.duration.d', 86400],
    ['timeRange.duration.h', 3600],
    ['timeRange.duration.m', 60],
    ['timeRange.duration.s', 1],
  ]
  for (const [key, size] of ladder) {
    if (seconds >= size) {
      const value = seconds / size
      const rounded = Number.isInteger(value) ? String(value) : value.toFixed(1)
      // `count` picks the plural form from the real width, `value` is what gets
      // printed: 1.5 hours must not be pluralised off a rounded 2.
      return translate(locale, key, { count: Number(rounded), value: rounded })
    }
  }
  return translate(locale, 'timeRange.duration.s', { count: seconds, value: String(seconds) })
}
