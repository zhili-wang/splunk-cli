/** Presentation helpers. Every one of them is honest about missing data. */

import { getLocale, translate, type Locale, type MessageParams } from './i18n'

/** Placeholder shown wherever the backend reported `null`. */
export const UNKNOWN = '—'

/**
 * Every formatter takes the locale to format for, defaulting to the active one.
 *
 * Explicit where the caller knows better — which is what the tests use, so they
 * never depend on a store they did not set up — and the active locale
 * everywhere else, so no component has to thread it through its props.
 */

/**
 * The number a count is *displayed* as.
 *
 * A plural form has to be chosen from the number the reader sees, not the one we
 * were handed: `1.002` prints as `1`, so it must read "1 second" rather than
 * "1 seconds". Rounding here, once, is what keeps the printed number and the
 * plural form from drifting apart.
 */
function displayable(value: number): number {
  return Number.isInteger(value) ? value : Number(value.toFixed(2))
}

/** Render a metric, keeping `null` visibly different from `0`. */
export function formatCount(
  value: number | null | undefined,
  locale: Locale = getLocale(),
): string {
  if (value === null || value === undefined) return UNKNOWN
  return displayable(value).toLocaleString(locale)
}

/**
 * A count for the plural rules, paired with the text to print in its place.
 *
 * The two differ on purpose: `Intl.PluralRules` needs the number to pick a form,
 * while the message has to show the grouped one, because `1,125 events` reads as
 * a quantity and `1125 events` reads as an identifier. Both are derived from
 * `displayable`, so they always agree.
 *
 * A missing count becomes `0` for the rules and `—` for the page, which keeps
 * "we could not find out" from being pluralised as though it were a number.
 */
export function counted(
  value: number | null | undefined,
  locale: Locale = getLocale(),
): MessageParams {
  return { count: displayable(value ?? 0), value: formatCount(value, locale) }
}

/** Render a grouping key, which may be a single field or a tuple. */
export function formatStatKey(
  key: string | string[] | null | undefined,
  locale: Locale = getLocale(),
): string {
  if (key === null || key === undefined) return UNKNOWN
  const parts = Array.isArray(key) ? key : [key]
  const meaningful = parts.filter((part) => part !== '')
  if (meaningful.length === 0) return translate(locale, 'common.none')
  return meaningful.join(' · ')
}

/** Render a Splunk bucket timestamp as a compact local clock time. */
export function formatBucketTime(value: string, locale: Locale = getLocale()): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

/** Render a full timestamp for log rows. */
export function formatTimestamp(value: unknown, locale: Locale = getLocale()): string {
  if (typeof value !== 'string') return UNKNOWN
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString(locale, { hour12: false })
}

/**
 * Render an epoch-seconds instant, the way Splunk reports a resolved window.
 *
 * Local time, like every other timestamp on the page: these are read next to the
 * rows they produced, and those are local too.
 */
export function formatInstant(
  seconds: number | null | undefined,
  locale: Locale = getLocale(),
): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return UNKNOWN
  return new Date(seconds * 1000).toLocaleString(locale, { hour12: false })
}

/** Render a duration in seconds, keeping sub-second runs readable. */
export function formatSeconds(
  seconds: number | null | undefined,
  locale: Locale = getLocale(),
): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return UNKNOWN
  // Below a second the value keeps three decimals, above it two. Both the printed
  // text and the plural form come from the same rounded number: a 1.001s run
  // prints as "1", and printing "1 seconds" beside it is the one thing this
  // function must not do.
  const decimals = seconds < 1 ? 3 : 2
  const rounded = Number(seconds.toFixed(decimals))
  return translate(locale, 'format.seconds', {
    count: rounded,
    value: rounded.toLocaleString(locale, { maximumFractionDigits: decimals }),
  })
}
