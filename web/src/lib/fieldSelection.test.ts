import { describe, expect, it } from 'vitest'

import {
  FIELD_SELECTION_KEY,
  isFieldVisible,
  readFieldSelection,
  toggleField,
  withAllVisible,
  writeFieldSelection,
} from './fieldSelection'

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

describe('isFieldVisible', () => {
  it('follows the rule when nothing was chosen', () => {
    expect(isFieldVisible({}, 'host')).toBe(true)
    expect(isFieldVisible({}, '_time')).toBe(true)
    expect(isFieldVisible({}, '_raw')).toBe(true)
    // Splunk's bookkeeping fields stay out of the way by default.
    expect(isFieldVisible({}, '_bkt')).toBe(false)
  })

  it('lets an explicit choice win over the rule', () => {
    expect(isFieldVisible({ _bkt: true }, '_bkt')).toBe(true)
    expect(isFieldVisible({ host: false }, 'host')).toBe(false)
  })
})

describe('toggleField', () => {
  it('records the opposite of what is showing', () => {
    expect(toggleField({}, 'host')).toEqual({ host: false })
    expect(toggleField({}, '_bkt')).toEqual({ _bkt: true })
  })

  it('flips back', () => {
    expect(toggleField(toggleField({}, 'host'), 'host')).toEqual({ host: true })
  })

  it('leaves the input untouched', () => {
    const before = { host: false }
    toggleField(before, 'level')
    expect(before).toEqual({ host: false })
  })
})

describe('withAllVisible', () => {
  it('turns on every field in hand without dropping the other choices', () => {
    expect(withAllVisible({ host: false }, ['host', '_bkt'])).toEqual({
      host: true,
      _bkt: true,
    })
  })
})

describe('readFieldSelection', () => {
  it('returns nothing when there is no storage at all', () => {
    expect(readFieldSelection(null)).toEqual({})
  })

  it('reads back what was written', () => {
    const store = storage()
    writeFieldSelection({ host: false, _bkt: true }, store)
    expect(readFieldSelection(store)).toEqual({ host: false, _bkt: true })
  })

  it('survives malformed or foreign data', () => {
    const store = storage()
    store.setItem(FIELD_SELECTION_KEY, 'not json')
    expect(readFieldSelection(store)).toEqual({})

    store.setItem(FIELD_SELECTION_KEY, '[true, false]')
    expect(readFieldSelection(store)).toEqual({})

    store.setItem(FIELD_SELECTION_KEY, '"a string"')
    expect(readFieldSelection(store)).toEqual({})
  })

  it('drops entries that are not real booleans', () => {
    const store = storage()
    store.setItem(
      FIELD_SELECTION_KEY,
      JSON.stringify({ host: false, level: 'yes', count: 1, '': true, _bkt: true }),
    )
    expect(readFieldSelection(store)).toEqual({ host: false, _bkt: true })
  })

  it('gives up rather than throwing when the store raises', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
    } as unknown as Storage
    expect(readFieldSelection(throwing)).toEqual({})
  })
})

describe('writeFieldSelection', () => {
  it('does nothing without storage', () => {
    expect(() => writeFieldSelection({ host: false }, null)).not.toThrow()
  })

  it('does not throw when the store is full or blocked', () => {
    const throwing = {
      setItem: () => {
        throw new Error('quota')
      },
    } as unknown as Storage
    // The columns are already on screen; failing to remember the choice is minor.
    expect(() => writeFieldSelection({ host: false }, throwing)).not.toThrow()
  })
})
