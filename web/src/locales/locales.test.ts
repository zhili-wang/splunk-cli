/**
 * The catalogs have to stay in step.
 *
 * The type checker already proves every key resolves in the Chinese catalog,
 * because that is the one `MessageKey` is derived from. What it cannot prove is
 * that the English catalog has the *same* keys: `translate` returns the key
 * itself when a message is missing, so a forgotten translation would ship as a
 * literal `job.events` on the page rather than as a build failure. This file is
 * that failure.
 */

import { describe, expect, it } from 'vitest'

import enUS from './en-US.json'
import zhCN from './zh-CN.json'

/** The categories `Intl.PluralRules` can select. */
const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A plural form: an object whose keys are all CLDR categories. */
function isPluralForms(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value)
  return keys.length > 0 && keys.every((key) => PLURAL_CATEGORIES.has(key))
}

/**
 * Every message, keyed by its dotted path.
 *
 * A plural form counts as **one** key: its categories are forms of the same
 * sentence rather than sentences of their own, and the two languages need
 * different numbers of them.
 */
function messages(
  catalog: unknown,
  prefix = '',
  out = new Map<string, string[]>(),
): Map<string, string[]> {
  if (typeof catalog === 'string') {
    out.set(prefix, [...(out.get(prefix) ?? []), catalog])
    return out
  }
  if (!isRecord(catalog)) return out
  if (isPluralForms(catalog)) {
    for (const form of Object.values(catalog)) {
      if (typeof form === 'string') out.set(prefix, [...(out.get(prefix) ?? []), form])
    }
    return out
  }
  for (const [key, value] of Object.entries(catalog)) {
    messages(value, prefix === '' ? key : `${prefix}.${key}`, out)
  }
  return out
}

/**
 * The `{name}` slots one message fills in.
 *
 * Per message, not per key: English spells a plural across two messages, and a
 * slot dropped from one of them would be invisible to a union over the key while
 * the sentence silently lost its number.
 */
function slots(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string))].sort()
}

const zh = messages(zhCN)
const en = messages(enUS)

describe('the locale catalogs', () => {
  it('defines exactly the same keys in both', () => {
    expect([...en.keys()].sort()).toEqual([...zh.keys()].sort())
  })

  it('fills every key with something', () => {
    for (const [key, texts] of [...zh, ...en]) {
      expect(texts.length, key).toBeGreaterThan(0)
      for (const text of texts) expect(text.trim(), key).not.toBe('')
    }
  })

  it('interpolates the same placeholders in both, message by message', () => {
    // A placeholder dropped in translation does not throw — the sentence simply
    // loses its number, which is exactly the kind of bug nobody notices. Every
    // English form is checked against the Chinese text individually, so losing a
    // slot from one plural form cannot hide behind the other one having it.
    for (const [key, texts] of zh) {
      expect(texts, key).toHaveLength(1)
      const reference = slots(texts[0] ?? '')
      for (const text of en.get(key) ?? []) {
        expect(slots(text), key).toEqual(reference)
      }
    }
  })

  it('gives every plural form an `other`, which is the fallback', () => {
    const walk = (node: unknown): void => {
      if (!isRecord(node)) return
      if (isPluralForms(node)) {
        expect(typeof node['other'], JSON.stringify(node)).toBe('string')
        return
      }
      for (const value of Object.values(node)) walk(value)
    }

    walk(zhCN)
    walk(enUS)
  })

  it('keeps Chinese free of the `one` category, which it does not use', () => {
    // Chinese does not inflect for number, so a `one` form there would be dead
    // text that no count could ever reach.
    for (const [key, texts] of zh) expect(texts, key).toHaveLength(1)
  })

  it('uses a plural form only where English actually inflects', () => {
    // The mirror of the previous case: a one-form whose two texts are identical
    // is a sign that a plural was copied without being translated.
    for (const [key, texts] of en) {
      if (texts.length === 1) continue
      expect(new Set(texts).size, key).toBeGreaterThan(1)
    }
  })
})
