/**
 * How the event timeline is drawn.
 *
 * Splunk hides the same choice behind "设定时间线的格式" on its timeline, and it is
 * a real preference rather than decoration: a bar chart answers "how busy is
 * each bucket", a line answers "what shape does the traffic take". Bars are the
 * default because the counts are binned — a bar per bucket is the honest shape —
 * and the other two are for reading a trend across a wide window.
 *
 * Remembered per browser like the theme, because it is a reading habit and not a
 * property of any one query.
 */

/** The shapes the timeline can take. */
export type TimelineFormat = 'bar' | 'line' | 'area'

/** Namespaced so it cannot collide with anything else on the origin. */
export const TIMELINE_FORMAT_KEY = 'splunk-cli:timeline-format'

/** Offered in this order; the first is the default. */
export const TIMELINE_FORMATS: ReadonlyArray<{ id: TimelineFormat; label: string }> = [
  { id: 'bar', label: '柱状' },
  { id: 'line', label: '折线' },
  { id: 'area', label: '面积' },
]

export const DEFAULT_TIMELINE_FORMAT: TimelineFormat = 'bar'

/** Narrow a stored string to a format this build knows how to draw. */
export function isTimelineFormat(value: unknown): value is TimelineFormat {
  return TIMELINE_FORMATS.some((item) => item.id === value)
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    // Storage can be blocked outright (private windows, hardened settings).
    return null
  }
}

/** Read the stored format, tolerating missing, malformed or foreign data. */
export function readTimelineFormat(storage: Storage | null = defaultStorage()): TimelineFormat {
  if (storage === null) return DEFAULT_TIMELINE_FORMAT
  try {
    const raw = storage.getItem(TIMELINE_FORMAT_KEY)
    return isTimelineFormat(raw) ? raw : DEFAULT_TIMELINE_FORMAT
  } catch {
    return DEFAULT_TIMELINE_FORMAT
  }
}

/** Persist the choice. A blocked store must not break the chart. */
export function writeTimelineFormat(
  format: TimelineFormat,
  storage: Storage | null = defaultStorage(),
): void {
  if (storage === null) return
  try {
    storage.setItem(TIMELINE_FORMAT_KEY, format)
  } catch {
    // Ignored on purpose: the chart is already drawn the way it was asked for;
    // failing to remember it is a minor loss, not an error worth surfacing.
  }
}
