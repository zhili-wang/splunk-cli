import { describe, expect, it } from 'vitest'

import {
  UNKNOWN,
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
})
