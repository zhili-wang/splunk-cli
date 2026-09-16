import { describe, expect, it } from 'vitest'

import {
  HISTORY_KEY,
  HISTORY_LIMIT,
  addQuery,
  readHistory,
  removeQuery,
  writeHistory,
} from './queryHistory'

/** A Storage stand-in, so the tests never touch the real localStorage. */
class MemoryStorage {
  private readonly data = new Map<string, string>()

  get length(): number {
    return this.data.size
  }

  clear(): void {
    this.data.clear()
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.data.delete(key)
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value)
  }
}

function storage(): Storage {
  return new MemoryStorage() as unknown as Storage
}

describe('addQuery', () => {
  it('puts the newest query first', () => {
    expect(addQuery(['old'], 'new')).toEqual(['new', 'old'])
  })

  it('trims, and ignores a query that is only whitespace', () => {
    expect(addQuery([], '  index=app  ')).toEqual(['index=app'])
    expect(addQuery(['a=1'], '   ')).toEqual(['a=1'])
  })

  it('moves a repeated query to the top instead of storing it twice', () => {
    expect(addQuery(['a=1', 'b=2'], 'b=2')).toEqual(['b=2', 'a=1'])
  })

  it('treats a query that differs only in case as the same one', () => {
    // Splunk field names and values are usually case-sensitive, but re-running
    // "the same" query should not fill the list with near-duplicates.
    expect(addQuery(['index=APP'], 'index=app')).toEqual(['index=app'])
  })

  it('drops the oldest entry past the cap', () => {
    const full = Array.from({ length: HISTORY_LIMIT }, (_, index) => `q${index}`)
    const next = addQuery(full, 'newest')

    expect(next).toHaveLength(HISTORY_LIMIT)
    expect(next[0]).toBe('newest')
    expect(next).not.toContain(`q${HISTORY_LIMIT - 1}`)
  })
})

describe('removeQuery', () => {
  it('drops exactly the named entry', () => {
    expect(removeQuery(['a=1', 'b=2'], 'a=1')).toEqual(['b=2'])
  })

  it('is a no-op for something that is not there', () => {
    expect(removeQuery(['a=1'], 'nope')).toEqual(['a=1'])
  })
})

describe('readHistory', () => {
  it('returns nothing when there is no storage at all', () => {
    expect(readHistory(null)).toEqual([])
  })

  it('returns nothing for an empty store', () => {
    expect(readHistory(storage())).toEqual([])
  })

  it('reads back what was written', () => {
    const store = storage()
    writeHistory(['a=1', 'b=2'], store)
    expect(readHistory(store)).toEqual(['a=1', 'b=2'])
  })

  it('survives malformed or foreign data', () => {
    const store = storage()
    store.setItem(HISTORY_KEY, 'not json')
    expect(readHistory(store)).toEqual([])

    store.setItem(HISTORY_KEY, '{"not":"an array"}')
    expect(readHistory(store)).toEqual([])
  })

  it('drops entries that are not usable query strings', () => {
    const store = storage()
    store.setItem(HISTORY_KEY, JSON.stringify(['keep', 42, null, '   ', 'also keep']))
    expect(readHistory(store)).toEqual(['keep', 'also keep'])
  })

  it('caps a list that was written by something else', () => {
    const store = storage()
    store.setItem(HISTORY_KEY, JSON.stringify(Array.from({ length: 40 }, (_, i) => `q${i}`)))
    expect(readHistory(store)).toHaveLength(HISTORY_LIMIT)
  })

  it('gives up rather than throwing when the store raises', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
    } as unknown as Storage
    expect(readHistory(throwing)).toEqual([])
  })
})

describe('writeHistory', () => {
  it('does nothing without storage', () => {
    expect(() => writeHistory(['a=1'], null)).not.toThrow()
  })

  it('does not throw when the store is full or blocked', () => {
    const throwing = {
      setItem: () => {
        throw new Error('quota')
      },
    } as unknown as Storage
    // The query already ran; failing to remember it must not surface as an error.
    expect(() => writeHistory(['a=1'], throwing)).not.toThrow()
  })
})
