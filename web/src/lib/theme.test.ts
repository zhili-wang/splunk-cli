import { describe, expect, it } from 'vitest'

import { DEFAULT_THEME, THEME_KEY, isTheme, readTheme, writeTheme } from './theme'

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

describe('isTheme', () => {
  it('accepts only the two themes the stylesheet defines', () => {
    expect(isTheme('dark')).toBe(true)
    expect(isTheme('light')).toBe(true)
    expect(isTheme('solarized')).toBe(false)
    expect(isTheme(null)).toBe(false)
  })
})

describe('readTheme', () => {
  it('defaults to dark, which is what the stylesheet declares', () => {
    expect(DEFAULT_THEME).toBe('dark')
    expect(readTheme(null)).toBe('dark')
    expect(readTheme(storage())).toBe('dark')
  })

  it('reads back a stored choice', () => {
    const store = storage()
    writeTheme('light', store)
    expect(readTheme(store)).toBe('light')
  })

  it('falls back to dark for a value it does not recognise', () => {
    const store = storage()
    store.setItem(THEME_KEY, 'sepia')
    expect(readTheme(store)).toBe('dark')
  })

  it('gives up rather than throwing when the store raises', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
    } as unknown as Storage
    expect(readTheme(throwing)).toBe('dark')
  })
})

describe('writeTheme', () => {
  it('does nothing without storage', () => {
    expect(() => writeTheme('light', null)).not.toThrow()
  })

  it('does not throw when the store is full or blocked', () => {
    const throwing = {
      setItem: () => {
        throw new Error('quota')
      },
    } as unknown as Storage
    // The theme is already applied; failing to remember it costs the next reload.
    expect(() => writeTheme('light', throwing)).not.toThrow()
  })
})
