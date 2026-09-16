import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CUSTOM,
  MAX_TIMELINE_BUCKETS,
  TIME_PRESET_GROUPS,
  TIME_PRESETS,
  editableRange,
  endOfSpan,
  formatDuration,
  fromDatetimeLocal,
  parseRelative,
  pickSpan,
  presetToRange,
  rangeWidthSeconds,
  resolveToIso,
  spanSeconds,
  toDatetimeLocal,
  toEpochSeconds,
  toRelativeLiteral,
} from './timeRange'

/** One fixed instant for every preset-width assertion, so none of them drift. */
const NOW = Date.parse('2024-01-02T03:00:00.000Z')

describe('TIME_PRESETS', () => {
  it('offers the recent and calendar presets, in display order', () => {
    expect(TIME_PRESETS.map((preset) => preset.id)).toEqual([
      '5m',
      '15m',
      '30m',
      '1h',
      '4h',
      '12h',
      '24h',
      '7d',
      'today',
      'yesterday',
      'this-week',
      'last-week',
      'this-month',
      'last-month',
      'this-year',
      'last-year',
    ])
  })

  it('groups them under the two headings the picker renders', () => {
    expect(TIME_PRESET_GROUPS.map((group) => group.title)).toEqual(['最近', '日历'])
  })

  it('keeps every recent preset inside the backend default ceiling', () => {
    // 7 days is `SPLUNK_MAX_TIME_RANGE`'s default. A relative preset longer than
    // that would come back as a SafetyLimitError on every click.
    const recent = TIME_PRESET_GROUPS[0].presets
    for (const preset of recent) {
      const width = rangeWidthSeconds(preset.range.earliest, preset.range.latest, NOW)
      expect(width).not.toBeNull()
      expect(width ?? 0).toBeLessThanOrEqual(7 * 86400)
    }
  })

  it('keeps every calendar preset snapped, so Splunk evaluates the bound', () => {
    // The calendar windows are the ones that can exceed 7 days; they only stay
    // usable because a literal containing `@` is handed to Splunk unevaluated.
    const calendar = TIME_PRESET_GROUPS[1].presets
    for (const preset of calendar) {
      expect(preset.range.earliest).toContain('@')
    }
  })
})

describe('presetToRange', () => {
  it('maps a preset to a Splunk relative time range', () => {
    expect(presetToRange('1h')).toEqual({ earliest: '-1h', latest: 'now' })
  })

  it('maps every preset to the window it declares', () => {
    for (const preset of TIME_PRESETS) {
      expect(presetToRange(preset.id)).toEqual({ ...preset.range })
    }
  })

  it('maps the calendar presets to their snap expressions', () => {
    expect(presetToRange('yesterday')).toEqual({ earliest: '-1d@d', latest: '@d' })
    expect(presetToRange('last-month')).toEqual({ earliest: '-1mon@mon', latest: '@mon' })
    expect(presetToRange('last-year')).toEqual({ earliest: '-1y@y', latest: '@y' })
  })

  it('does not validate the custom range', () => {
    // The backend owns the limits. Guessing here would either block a range
    // Splunk accepts or imply a promise the frontend cannot keep.
    expect(presetToRange('custom', { earliest: '-30d', latest: 'now' })).toEqual({
      earliest: '-30d',
      latest: 'now',
    })
  })

  it('falls back to a bounded default when custom is chosen with no range yet', () => {
    // Selecting "自定义" before typing anything must not emit an unbounded
    // query: `{earliest: undefined}` would ask Splunk for all time.
    expect(presetToRange('custom')).toEqual({ earliest: '-1h', latest: 'now' })
  })
})

describe('editableRange', () => {
  it('keeps a window the editor can display', () => {
    const range = { earliest: '-2h', latest: '-30m' }
    expect(editableRange(range)).toBe(range)
  })

  it('keeps an absolute window', () => {
    const range = { earliest: '2024-01-02T03:00:00.000Z', latest: '2024-01-02T04:00:00.000Z' }
    expect(editableRange(range)).toBe(range)
  })

  it('replaces a window it cannot display with the default', () => {
    // A `datetime-local` input cannot render `@mon`, so carrying a calendar
    // window into the editor would show two blank fields.
    expect(editableRange({ earliest: '-1mon@mon', latest: '@mon' })).toEqual(DEFAULT_CUSTOM)
    expect(editableRange({ earliest: '@d', latest: 'now' })).toEqual(DEFAULT_CUSTOM)
  })

  it('never hands back an unbounded window', () => {
    expect(editableRange({ earliest: '', latest: '' })).toEqual(DEFAULT_CUSTOM)
  })
})

describe('spanSeconds', () => {
  it('reads the units Splunk spans use', () => {
    expect(spanSeconds('30s')).toBe(30)
    expect(spanSeconds('5m')).toBe(300)
    expect(spanSeconds('3h')).toBe(10800)
    expect(spanSeconds('7d')).toBe(604800)
  })

  it('returns null for anything it cannot read', () => {
    expect(spanSeconds('5m@m')).toBeNull()
    expect(spanSeconds('')).toBeNull()
  })
})

describe('toEpochSeconds', () => {
  const now = Date.parse('2024-01-02T03:00:00.000Z')

  it('understands now and the relative forms the API accepts', () => {
    expect(toEpochSeconds('now', now)).toBe(Math.floor(now / 1000))
    expect(toEpochSeconds('-1h', now)).toBe(Math.floor(now / 1000) - 3600)
    expect(toEpochSeconds('-7d', now)).toBe(Math.floor(now / 1000) - 604800)
  })

  it('understands ISO timestamps and epoch seconds', () => {
    expect(toEpochSeconds('2024-01-02T03:00:00.000Z', now)).toBe(Math.floor(now / 1000))
    expect(toEpochSeconds('1704164400', now)).toBe(1704164400)
  })

  it('gives up on the forms only Splunk can evaluate', () => {
    // Snap-to expressions need the server's clock and calendar.
    expect(toEpochSeconds('-1d@d', now)).toBeNull()
    expect(toEpochSeconds('whenever', now)).toBeNull()
    expect(toEpochSeconds('', now)).toBeNull()
  })
})

describe('rangeWidthSeconds', () => {
  const now = Date.parse('2024-01-02T03:00:00.000Z')

  it('measures a relative window', () => {
    expect(rangeWidthSeconds('-1h', 'now', now)).toBe(3600)
    expect(rangeWidthSeconds('-7d', 'now', now)).toBe(604800)
  })

  it('measures an absolute window', () => {
    expect(
      rangeWidthSeconds('2024-01-02T03:00:00.000Z', '2024-01-02T04:00:00.000Z', now),
    ).toBe(3600)
  })

  it('refuses a window it cannot measure, or one that runs backwards', () => {
    expect(rangeWidthSeconds('-1d@d', 'now', now)).toBeNull()
    expect(rangeWidthSeconds('now', '-1h', now)).toBeNull()
  })
})

describe('pickSpan', () => {
  const now = Date.parse('2024-01-02T03:00:00.000Z')

  it('keeps the bucket count within what the backend will return whole', () => {
    // The backend caps a timeline at 500 buckets with `head`, so too fine a
    // span would silently cover only the start of the window.
    for (const [earliest, latest, span] of [
      ['-1h', 'now', '30s'],
      ['-24h', 'now', '30m'],
      ['-7d', 'now', '3h'],
    ] as const) {
      const buckets = (rangeWidthSeconds(earliest, latest, now) ?? 0) / (spanSeconds(span) ?? 1)
      expect(buckets).toBeLessThanOrEqual(120)
      expect(pickSpan(earliest, latest, now)).toBe(span)
    }
  })

  it('uses the finest useful span for a short window', () => {
    expect(pickSpan('-5m', 'now', now)).toBe('5s')
  })

  it('uses daily buckets when only Splunk can measure the window', () => {
    // Anything finer can be trimmed by the backend's bucket cap, which would
    // leave the histogram covering only the start of the window.
    expect(pickSpan('-1d@d', 'now', now)).toBe('1d')
    expect(pickSpan('@mon', 'now', now)).toBe('1d')
    expect(pickSpan('-1y@y', '@y', now)).toBe('1d')
  })

  it('keeps a year inside the bucket cap at the unknown-width span', () => {
    const span = pickSpan('@y', 'now', now)
    const daysPerBucket = (spanSeconds(span) ?? 1) / 86400
    expect(366 / daysPerBucket).toBeLessThanOrEqual(MAX_TIMELINE_BUCKETS)
  })

  it('caps the span for a window longer than the coarsest one', () => {
    expect(pickSpan('-365d', 'now', now)).toBe('7d')
  })
})

describe('endOfSpan', () => {
  it('returns the start of the next bucket', () => {
    expect(endOfSpan('2024-01-02T03:00:00.000Z', '5m')).toBe('2024-01-02T03:05:00.000Z')
  })

  it('leaves the value alone when it cannot do better', () => {
    expect(endOfSpan('2024-01-02T03:00:00.000Z', 'nonsense')).toBe('2024-01-02T03:00:00.000Z')
    expect(endOfSpan('not-a-time', '5m')).toBe('not-a-time')
  })
})

describe('parseRelative', () => {
  it('reads back an amount and a unit for the editor', () => {
    expect(parseRelative('-15m')).toEqual({ amount: 15, unit: 'm' })
    expect(parseRelative('15m')).toEqual({ amount: 15, unit: 'm' })
    expect(parseRelative('-2d')).toEqual({ amount: 2, unit: 'd' })
  })

  it('rejects anything that is not a single whole amount', () => {
    expect(parseRelative('now')).toBeNull()
    expect(parseRelative('-0m')).toBeNull()
    expect(parseRelative('-1.5h')).toBeNull()
    expect(parseRelative('-45m30s')).toBeNull()
    expect(parseRelative('')).toBeNull()
  })
})

describe('toRelativeLiteral', () => {
  it('picks the largest unit that divides the window exactly', () => {
    expect(toRelativeLiteral(3600)).toBe('-1h')
    expect(toRelativeLiteral(7200)).toBe('-2h')
    expect(toRelativeLiteral(86400)).toBe('-1d')
    expect(toRelativeLiteral(90)).toBe('-90s')
  })

  it('falls back to seconds rather than rounding', () => {
    // 45m30s has no single-unit form, and this API takes only one unit.
    expect(toRelativeLiteral(2730)).toBe('-2730s')
  })

  it('refuses a width that is not a positive number', () => {
    expect(toRelativeLiteral(0)).toBeNull()
    expect(toRelativeLiteral(-60)).toBeNull()
    expect(toRelativeLiteral(Number.NaN)).toBeNull()
  })
})

describe('resolveToIso', () => {
  const now = Date.parse('2024-01-02T03:00:00.000Z')

  it('freezes "now" and the relative forms into an instant', () => {
    expect(resolveToIso('now', now)).toBe('2024-01-02T03:00:00.000Z')
    expect(resolveToIso('-1h', now)).toBe('2024-01-02T02:00:00.000Z')
  })

  it('leaves an instant alone', () => {
    expect(resolveToIso('2024-01-02T03:00:00.000Z', now)).toBe('2024-01-02T03:00:00.000Z')
  })

  it('returns null when only Splunk can evaluate the literal', () => {
    expect(resolveToIso('-1d@d', now)).toBeNull()
  })
})

describe('toDatetimeLocal / fromDatetimeLocal', () => {
  it('renders the local wall clock, which is the only shape the picker takes', () => {
    const local = toDatetimeLocal('2024-01-02T03:00:00.000Z')

    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    // Same instant, expressed in the browser's own zone.
    expect(new Date(local).toISOString()).toBe('2024-01-02T03:00:00.000Z')
  })

  it('leaves the picker empty rather than showing a wrong time', () => {
    expect(toDatetimeLocal('-1d@d')).toBe('')
  })

  it('turns what the picker hands back into an instant', () => {
    expect(fromDatetimeLocal('2024-01-02T05:30')).toBe(new Date('2024-01-02T05:30').toISOString())
  })

  it('rejects an empty or malformed picker value', () => {
    expect(fromDatetimeLocal('')).toBeNull()
    expect(fromDatetimeLocal('   ')).toBeNull()
    expect(fromDatetimeLocal('yesterday')).toBeNull()
  })
})

describe('formatDuration', () => {
  it('states a width in the largest unit that fits', () => {
    expect(formatDuration(86400)).toBe('1 天')
    expect(formatDuration(3600)).toBe('1 小时')
    expect(formatDuration(5400)).toBe('1.5 小时')
    expect(formatDuration(90)).toBe('1.5 分钟')
    expect(formatDuration(45)).toBe('45 秒')
  })
})
