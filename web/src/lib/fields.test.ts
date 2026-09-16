import { describe, expect, it } from 'vitest'

import {
  fieldCounts,
  fieldNames,
  highlight,
  isInternalField,
  orderedFields,
  queryTerms,
} from './fields'

describe('isInternalField', () => {
  it('flags the bookkeeping fields and keeps the readable ones', () => {
    expect(isInternalField('_bkt')).toBe(true)
    expect(isInternalField('_cd')).toBe(true)
    expect(isInternalField('_raw')).toBe(false)
    expect(isInternalField('_time')).toBe(false)
    expect(isInternalField('host')).toBe(false)
  })
})

describe('fieldNames', () => {
  it('puts the well-known fields first, then the rest alphabetically', () => {
    const names = fieldNames([
      { zebra: 1, message: 'm', _time: 't', host: 'h', _bkt: 'b', alpha: 2, level: 'ERROR' },
    ])

    expect(names).toEqual(['_time', 'host', 'level', 'message', 'alpha', 'zebra', '_bkt'])
  })

  it('unions the fields across rows that carry different ones', () => {
    expect(fieldNames([{ host: 'a' }, { level: 'ERROR', host: 'b' }])).toEqual(['host', 'level'])
  })

  it('returns nothing for no rows', () => {
    expect(fieldNames([])).toEqual([])
  })
})

describe('orderedFields', () => {
  const rows = [{ _time: 't', _raw: 'r', host: 'h', _bkt: 'b', level: 'ERROR' }]

  it('leads with time and the event text, and hides the bookkeeping fields', () => {
    expect(orderedFields(rows)).toEqual(['_time', '_raw', 'host', 'level'])
  })

  it('appends the bookkeeping fields when they are asked for', () => {
    expect(orderedFields(rows, { includeInternal: true })).toEqual([
      '_time',
      '_raw',
      'host',
      'level',
      '_bkt',
    ])
  })
})

describe('fieldCounts', () => {
  it('counts only the rows that actually carry a value', () => {
    const counts = fieldCounts([
      { host: 'a', message: '' },
      { host: 'b', message: 'boom', level: null },
    ])

    // `''` and `null` mean "the event does not carry this field", not "empty".
    expect(counts).toEqual([
      { name: 'host', count: 2 },
      { name: 'level', count: 0 },
      { name: 'message', count: 1 },
    ])
  })
})

describe('queryTerms', () => {
  it('reduces field=value to the value', () => {
    expect(queryTerms('index=app level=ERROR')).toEqual(['app', 'ERROR'])
  })

  it('keeps a quoted phrase whole', () => {
    expect(queryTerms('error "timed out" host=api-01')).toEqual([
      'error',
      'timed out',
      'api-01',
    ])
  })

  it('accepts single-quoted phrases too', () => {
    expect(queryTerms("error 'timed out'")).toEqual(['error', 'timed out'])
  })

  it('stops at the first pipe: those are commands, not search terms', () => {
    expect(queryTerms('index=app | stats count by host')).toEqual(['app'])
  })

  it('drops wildcards down to their literal prefix', () => {
    expect(queryTerms('index=app* sourcetype=*nginx')).toEqual(['app', 'nginx'])
  })

  it('ignores one-character terms and bare operators', () => {
    // Highlighting "a" or "AND" would paint most of the event.
    expect(queryTerms('a=1 AND OR NOT x search')).toEqual([])
  })

  it('deduplicates case-insensitively but keeps the first spelling', () => {
    expect(queryTerms('level=ERROR level=error')).toEqual(['ERROR'])
  })

  it('handles an empty query', () => {
    expect(queryTerms('')).toEqual([])
  })
})

describe('highlight', () => {
  it('returns the whole text unmarked when there is nothing to look for', () => {
    expect(highlight('boom', [])).toEqual([{ text: 'boom', hit: false }])
  })

  it('marks the matching runs and leaves the rest alone', () => {
    expect(highlight('api-01 ERROR boom', ['ERROR'])).toEqual([
      { text: 'api-01 ', hit: false },
      { text: 'ERROR', hit: true },
      { text: ' boom', hit: false },
    ])
  })

  it('matches case-insensitively', () => {
    expect(highlight('Boom', ['boom'])).toEqual([{ text: 'Boom', hit: true }])
  })

  it('prefers the longer term when two overlap', () => {
    expect(highlight('timed out', ['timed', 'timed out'])).toEqual([
      { text: 'timed out', hit: true },
    ])
  })

  it('finds every occurrence, not just the first', () => {
    const parts = highlight('a ERROR b ERROR c', ['ERROR'])
    expect(parts.filter((part) => part.hit).map((part) => part.text)).toEqual(['ERROR', 'ERROR'])
    expect(parts.map((part) => part.text).join('')).toBe('a ERROR b ERROR c')
  })

  it('treats a term as a literal, not a pattern', () => {
    // A query term is data; `a.c` must not match `abc`.
    expect(highlight('abc a.c', ['a.c'])).toEqual([
      { text: 'abc ', hit: false },
      { text: 'a.c', hit: true },
    ])
  })

  it('handles an empty text', () => {
    expect(highlight('', ['boom'])).toEqual([])
  })
})
