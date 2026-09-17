import { describe, expect, it } from 'vitest'

import {
  UNKNOWN,
  counted,
  formatBucketTime,
  formatCount,
  formatInstant,
  formatSeconds,
  formatStatKey,
  formatTimestamp,
} from './format'

describe('formatCount', () => {
  it('renders an unknown value as an em dash, never as zero', () => {
    // A failed sub-query reports null. Printing 0 would turn "we could not find
    // out" into "there is nothing", which is a different and false claim.
    expect(formatCount(null)).toBe('—')
  })

  it('treats a missing value exactly like a null one', () => {
    expect(formatCount(undefined)).toBe(UNKNOWN)
  })

  it('renders a real zero as zero', () => {
    expect(formatCount(0)).toBe('0')
  })

  it('groups thousands', () => {
    expect(formatCount(23521)).toBe('23,521')
  })

  it('drops the trailing .0 Splunk adds to totals', () => {
    expect(formatCount(23521.0)).toBe('23,521')
  })

  it('keeps a meaningful fraction', () => {
    expect(formatCount(12.5)).toBe('12.5')
  })
})

describe('formatStatKey', () => {
  it('joins a multi-field grouping key', () => {
    expect(formatStatKey(['payment', 'api-01'])).toBe('payment · api-01')
  })

  it('passes a single-field key through', () => {
    expect(formatStatKey('payment')).toBe('payment')
  })

  it('names an empty key', () => {
    expect(formatStatKey([])).toBe('(无)')
    expect(formatStatKey('')).toBe('(无)')
  })

  it('treats a missing key as unknown rather than empty', () => {
    // `null`/`undefined` mean the backend could not group; `''` means it
    // grouped and the value was blank. They render differently on purpose.
    expect(formatStatKey(null)).toBe(UNKNOWN)
    expect(formatStatKey(undefined)).toBe(UNKNOWN)
  })

  it('drops blank parts of a tuple but keeps the meaningful ones', () => {
    expect(formatStatKey(['', 'api-01'])).toBe('api-01')
    expect(formatStatKey(['', ''])).toBe('(无)')
  })
})

describe('formatBucketTime', () => {
  it('renders a bucket timestamp as a compact local clock time', () => {
    expect(formatBucketTime('2024-01-02T03:04:05')).toBe('03:04')
  })

  it('passes an unparseable value through instead of printing Invalid Date', () => {
    expect(formatBucketTime('not-a-date')).toBe('not-a-date')
  })
})

describe('formatTimestamp', () => {
  it('renders a full timestamp for log rows', () => {
    expect(formatTimestamp('2024-01-02T03:04:05')).toBe('2024/1/2 03:04:05')
  })

  it('renders a non-string field as unknown', () => {
    // Splunk results are `Record<string, unknown>`: a numeric epoch or a null
    // must not become the string "123" or "null" in the time column.
    expect(formatTimestamp(1704164645)).toBe(UNKNOWN)
    expect(formatTimestamp(null)).toBe(UNKNOWN)
    expect(formatTimestamp(undefined)).toBe(UNKNOWN)
  })

  it('passes an unparseable string through', () => {
    expect(formatTimestamp('n/a')).toBe('n/a')
  })
})

describe('formatInstant', () => {
  it('treats the value as epoch seconds, not milliseconds', () => {
    // Milliseconds would land in 1970 — the classic off-by-1000. A job's resolved
    // window comes from Splunk in seconds.
    expect(formatInstant(1785513600)).toContain('2026')
    expect(formatInstant(1785513600000)).not.toContain('2026')
  })

  it('reports an unknown instant as an em dash, never as 1970', () => {
    expect(formatInstant(null)).toBe(UNKNOWN)
    expect(formatInstant(undefined)).toBe(UNKNOWN)
    expect(formatInstant(Number.NaN)).toBe(UNKNOWN)
  })
})

describe('formatSeconds', () => {
  it('keeps sub-second runs readable', () => {
    // Splunk reports run durations like 0.049; rounding that to "0 秒" would hide
    // that the search was fast rather than instant.
    expect(formatSeconds(0.049)).toBe('0.049 秒')
  })

  it('renders whole and fractional seconds', () => {
    expect(formatSeconds(1.5)).toBe('1.5 秒')
    expect(formatSeconds(12)).toBe('12 秒')
  })

  it('reports an unknown duration as an em dash', () => {
    expect(formatSeconds(null)).toBe(UNKNOWN)
    expect(formatSeconds(undefined)).toBe(UNKNOWN)
  })

  it('chooses the plural form from the number it prints, not the raw one', () => {
    // A 1.001s run prints as "1" once the fraction is dropped to two decimals.
    // Choosing the form from the raw 1.001 selects `other` and prints the
    // self-contradicting "1 seconds" beside the "1".
    expect(formatSeconds(1.001, 'en-US')).toBe('1 second')
    expect(formatSeconds(1.002, 'en-US')).toBe('1 second')
    expect(formatSeconds(1.999, 'en-US')).toBe('2 seconds')
  })
})

describe('counted', () => {
  it('pairs the raw number with the grouped text the message prints', () => {
    // The two differ on purpose: Intl.PluralRules needs the number to pick a
    // form, the message has to show the grouped one.
    expect(counted(23521)).toEqual({ count: 23521, value: '23,521' })
  })

  it('keeps a missing count from being pluralised as though it were zero', () => {
    // "we could not find out" is not "there are none", and the em dash has to
    // survive into the pluralised message.
    expect(counted(null)).toEqual({ count: 0, value: UNKNOWN })
  })

  it('picks the form from the number it prints, so the two cannot disagree', () => {
    // Same trap as `formatSeconds`: 1.002 prints as "1", so pluralising it off
    // the raw value would read "1 rows".
    expect(counted(1.002)).toEqual({ count: 1, value: '1' })
    expect(counted(12.5)).toEqual({ count: 12.5, value: '12.5' })
    expect(counted(12.567)).toEqual({ count: 12.57, value: '12.57' })
  })
})

describe('formatting for another locale', () => {
  it('uses the date order that locale writes', () => {
    // Asserting the order rather than the exact string: a locale's punctuation
    // moves between ICU versions, but "month before year" is the point of
    // formatting for en-US at all.
    expect(formatTimestamp('2024-01-02T03:04:05', 'zh-CN')).toMatch(/^2024\/1\/2/)
    expect(formatTimestamp('2024-01-02T03:04:05', 'en-US')).toMatch(/^1\/2\/2024/)
  })

  it('translates the words it owns', () => {
    expect(formatStatKey([], 'zh-CN')).toBe('(无)')
    expect(formatStatKey([], 'en-US')).toBe('(none)')
  })

  it('inflects a duration for the locale that needs it', () => {
    expect(formatSeconds(1, 'zh-CN')).toBe('1 秒')
    expect(formatSeconds(1, 'en-US')).toBe('1 second')
    expect(formatSeconds(2, 'en-US')).toBe('2 seconds')
  })

  it('groups numbers the way that locale writes them', () => {
    expect(formatCount(23521, 'en-US')).toBe('23,521')
    expect(formatCount(12.5, 'en-US')).toBe('12.5')
  })
})
