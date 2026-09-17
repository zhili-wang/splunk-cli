// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_KEY,
  applyLocale,
  getLocale,
  isLocale,
  readLocale,
  resetLocale,
  setLocale,
  subscribe,
  translate,
  writeLocale,
  type MessageKey,
} from './i18n'

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

beforeEach(() => {
  localStorage.clear()
  resetLocale()
})

afterEach(() => {
  document.documentElement.lang = ''
  document.title = ''
})

describe('isLocale', () => {
  it('accepts only the locales this build ships', () => {
    expect(isLocale('zh-CN')).toBe(true)
    expect(isLocale('en-US')).toBe(true)
    expect(isLocale('fr-FR')).toBe(false)
    expect(isLocale('zh')).toBe(false)
    expect(isLocale(null)).toBe(false)
  })

  it('ships Chinese first, because it is the default', () => {
    expect(LOCALES[0]).toBe('zh-CN')
    expect(DEFAULT_LOCALE).toBe('zh-CN')
  })
})

describe('readLocale', () => {
  it('defaults to Chinese, which is what the markup already declares', () => {
    expect(readLocale(null)).toBe('zh-CN')
    expect(readLocale(storage())).toBe('zh-CN')
  })

  it('reads back a stored choice', () => {
    const store = storage()
    writeLocale('en-US', store)
    expect(readLocale(store)).toBe('en-US')
  })

  it('falls back to Chinese for a value it does not recognise', () => {
    const store = storage()
    store.setItem(LOCALE_KEY, 'de-DE')
    expect(readLocale(store)).toBe('zh-CN')
  })

  it('gives up rather than throwing when the store raises', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
    } as unknown as Storage
    expect(readLocale(throwing)).toBe('zh-CN')
  })
})

describe('writeLocale', () => {
  it('does nothing without storage', () => {
    expect(() => writeLocale('en-US', null)).not.toThrow()
  })

  it('does not throw when the store is full or blocked', () => {
    const throwing = {
      setItem: () => {
        throw new Error('quota')
      },
    } as unknown as Storage
    // The page is already in the chosen language; failing to remember it costs
    // the next reload, not this one.
    expect(() => writeLocale('en-US', throwing)).not.toThrow()
  })
})

describe('translate', () => {
  it('returns the message for the locale asked for', () => {
    expect(translate('zh-CN', 'connection.ok')).toBe('已连接')
    expect(translate('en-US', 'connection.ok')).toBe('Connected')
  })

  it('reads a message nested several levels deep', () => {
    expect(translate('zh-CN', 'timeRange.presets.today')).toBe('今天')
    expect(translate('en-US', 'timeRange.presets.today')).toBe('Today')
  })

  it('fills placeholders from the params', () => {
    expect(translate('zh-CN', 'api.httpError', { status: 503 })).toBe('服务器返回 HTTP 503')
    expect(translate('en-US', 'api.httpError', { status: 503 })).toBe(
      'The server returned HTTP 503',
    )
  })

  it('fills the same placeholder more than once', () => {
    expect(translate('en-US', 'query.deleteRecord', { query: 'index=app' })).toBe(
      'Delete record index=app',
    )
  })

  it('leaves a placeholder with no value in place, so the gap is visible', () => {
    // Printing "undefined" would look like a real message. Braces do not.
    expect(translate('en-US', 'api.httpError')).toBe('The server returned HTTP {status}')
  })

  it('returns the key itself when the message is missing, so the gap is visible', () => {
    expect(translate('zh-CN', 'no.such.key' as MessageKey)).toBe('no.such.key')
    expect(translate('en-US', 'timeRange.presets' as MessageKey)).toBe('timeRange.presets')
  })
})

describe('translate plurals', () => {
  it('picks the form Intl.PluralRules selects for the count', () => {
    expect(translate('en-US', 'format.seconds', { count: 1, value: '1' })).toBe('1 second')
    expect(translate('en-US', 'format.seconds', { count: 2, value: '2' })).toBe('2 seconds')
    expect(translate('en-US', 'format.seconds', { count: 0, value: '0' })).toBe('0 seconds')
  })

  it('falls back to the other form for a locale that only has one', () => {
    // Chinese does not inflect for number, so a count of 1 takes the same form
    // as any other.
    expect(translate('zh-CN', 'format.seconds', { count: 1, value: '1' })).toBe('1 秒')
    expect(translate('zh-CN', 'format.seconds', { count: 9, value: '9' })).toBe('9 秒')
  })

  it('uses the other form when no count was given at all', () => {
    // A caller that only wants the unit name, such as the editor's unit picker.
    // Its own key, because the phrase with a number in it is a different message.
    expect(translate('en-US', 'timeRange.units.h')).toBe('hours')
    expect(translate('zh-CN', 'timeRange.units.h')).toBe('小时')
  })

  it('ignores a count that is not a number', () => {
    // `value` is the already-formatted text; a caller that passes its formatted
    // string as `count` by mistake must not crash the plural rules.
    expect(translate('en-US', 'format.seconds', { count: '1,125', value: '1,125' })).toBe(
      '1,125 seconds',
    )
  })

  it('handles a fractional count, which a run duration really does produce', () => {
    expect(translate('en-US', 'format.seconds', { count: 1.5, value: '1.5' })).toBe('1.5 seconds')
    expect(translate('en-US', 'timeRange.duration.h', { count: 1.5, value: '1.5' })).toBe(
      '1.5 hours',
    )
    expect(translate('en-US', 'timeRange.duration.h', { count: 1, value: '1' })).toBe('1 hour')
    expect(translate('zh-CN', 'timeRange.duration.h', { count: 1, value: '1' })).toBe('1 小时')
  })
})

describe('the locale store', () => {
  it('starts at the stored locale', () => {
    expect(getLocale()).toBe('zh-CN')
  })

  it('notifies subscribers and persists the choice', () => {
    const listener = vi.fn()
    const unsubscribe = subscribe(listener)

    setLocale('en-US')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(getLocale()).toBe('en-US')
    expect(localStorage.getItem(LOCALE_KEY)).toBe('en-US')
    unsubscribe()
  })

  it('stops notifying a listener that unsubscribed', () => {
    const listener = vi.fn()
    subscribe(listener)()

    setLocale('en-US')

    expect(listener).not.toHaveBeenCalled()
  })

  it('re-reads storage on reset, which is what a test file needs between cases', () => {
    setLocale('en-US')
    localStorage.clear()

    resetLocale()

    expect(getLocale()).toBe('zh-CN')
  })
})

describe('applyLocale', () => {
  it('puts the language on <html>, where the document declares it', () => {
    applyLocale('en-US')
    expect(document.documentElement.lang).toBe('en-US')

    applyLocale('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('translates the document title, which lives outside the React tree', () => {
    applyLocale('en-US')
    expect(document.title).toBe('Splunk Log Dashboard')

    applyLocale('zh-CN')
    expect(document.title).toBe('Splunk 日志面板')
  })

  it('does nothing when there is no document to apply it to', () => {
    // The libs are also imported by Node-only tests, which have no DOM.
    const original = globalThis.document
    // @ts-expect-error -- deliberately removing the global to prove the guard.
    delete globalThis.document
    try {
      expect(() => applyLocale('en-US')).not.toThrow()
    } finally {
      globalThis.document = original
    }
  })
})
