/** Presentation helpers. Every one of them is honest about missing data. */

/** Placeholder shown wherever the backend reported `null`. */
export const UNKNOWN = '—'

/** Render a metric, keeping `null` visibly different from `0`. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return UNKNOWN
  if (Number.isInteger(value)) return value.toLocaleString('zh-CN')
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

/** Render a grouping key, which may be a single field or a tuple. */
export function formatStatKey(key: string | string[] | null | undefined): string {
  if (key === null || key === undefined) return UNKNOWN
  const parts = Array.isArray(key) ? key : [key]
  const meaningful = parts.filter((part) => part !== '')
  if (meaningful.length === 0) return '(无)'
  return meaningful.join(' · ')
}

/** Render a Splunk bucket timestamp as a compact local clock time. */
export function formatBucketTime(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/** Render a full timestamp for log rows. */
export function formatTimestamp(value: unknown): string {
  if (typeof value !== 'string') return UNKNOWN
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString('zh-CN', { hour12: false })
}

/**
 * Render an epoch-seconds instant, the way Splunk reports a resolved window.
 *
 * Local time, like every other timestamp on the page: these are read next to the
 * rows they produced, and those are local too.
 */
export function formatInstant(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return UNKNOWN
  return new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false })
}

/** Render a duration in seconds, keeping sub-second runs readable. */
export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return UNKNOWN
  const text =
    seconds < 1 ? seconds.toFixed(3) : seconds.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  return `${text} 秒`
}
