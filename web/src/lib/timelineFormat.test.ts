import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TIMELINE_FORMAT,
  TIMELINE_FORMATS,
  TIMELINE_FORMAT_KEY,
  isTimelineFormat,
  readTimelineFormat,
  writeTimelineFormat,
} from './timelineFormat'

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

describe('TIMELINE_FORMATS', () => {
  it('offers bars first, because the default has to be the honest shape', () => {
    expect(TIMELINE_FORMATS.map((item) => item.id)).toEqual(['bar', 'line', 'area'])
    expect(TIMELINE_FORMATS.map((item) => item.label)).toEqual(['柱状', '折线', '面积'])
    expect(DEFAULT_TIMELINE_FORMAT).toBe('bar')
  })
})

describe('isTimelineFormat', () => {
  it('accepts only formats this build knows how to draw', () => {
    expect(isTimelineFormat('bar')).toBe(true)
    expect(isTimelineFormat('area')).toBe(true)
    expect(isTimelineFormat('donut')).toBe(false)
    expect(isTimelineFormat('')).toBe(false)
    expect(isTimelineFormat(null)).toBe(false)
    expect(isTimelineFormat(7)).toBe(false)
  })
})

describe('readTimelineFormat', () => {
  it('returns the stored format', () => {
    const store = storage()
    store.setItem(TIMELINE_FORMAT_KEY, 'line')

    expect(readTimelineFormat(store)).toBe('line')
  })

  it('falls back to bars when nothing is stored', () => {
    expect(readTimelineFormat(storage())).toBe(DEFAULT_TIMELINE_FORMAT)
  })

  it('falls back to bars when the stored value is foreign', () => {
    const store = storage()
    store.setItem(TIMELINE_FORMAT_KEY, '{"shape":"pie"}')

    expect(readTimelineFormat(store)).toBe(DEFAULT_TIMELINE_FORMAT)
  })

  it('survives storage being unavailable', () => {
    // Private windows and hardened settings can block it outright; a blocked
    // store must not stop the chart from being drawn.
    expect(readTimelineFormat(null)).toBe(DEFAULT_TIMELINE_FORMAT)

    const hostile = {
      getItem: () => {
        throw new Error('SecurityError')
      },
    } as unknown as Storage
    expect(readTimelineFormat(hostile)).toBe(DEFAULT_TIMELINE_FORMAT)
  })
})

describe('writeTimelineFormat', () => {
  it('stores the choice', () => {
    const store = storage()

    writeTimelineFormat('area', store)

    expect(store.getItem(TIMELINE_FORMAT_KEY)).toBe('area')
  })

  it('ignores a store that refuses to write', () => {
    const hostile = {
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    } as unknown as Storage

    expect(() => writeTimelineFormat('area', hostile)).not.toThrow()
    expect(() => writeTimelineFormat('area', null)).not.toThrow()
  })
})
