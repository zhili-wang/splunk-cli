/**
 * The interface language.
 *
 * Every visible string lives in `src/locales/<locale>.json` and is reached
 * through this module. The catalogs are JSON rather than a TypeScript object so
 * the editor's i18n tooling reads them natively — it can preview a translation
 * inline and extract a hardcoded string into the right file — while the types
 * below still make a mistyped key a compile error.
 *
 * The active locale is a module-level store read through `useLocale`, the same
 * shape as the theme and the field selection. It lives here rather than in the
 * hook because `format.ts`, `timeRange.ts` and `api/client.ts` are plain
 * modules that format numbers and dates for the active locale, and none of them
 * may depend on React.
 *
 * Only `count` is special: `Intl.PluralRules` reads it to choose a plural form,
 * and it is never printed. Messages show `{value}` instead, which is the number
 * already formatted for the locale (`1,125` rather than `1125`).
 */

import enUS from '../locales/en-US.json'
import zhCN from '../locales/zh-CN.json'

/**
 * The locales this build ships.
 *
 * Chinese is first and is the default: the markup, the CLI and the server all
 * speak it, so an unconfigured visitor gets the language the rest of the tool
 * already uses. Adding a language is a new JSON file plus one entry here.
 */
export type Locale = 'zh-CN' | 'en-US'

export const LOCALES: readonly Locale[] = ['zh-CN', 'en-US']

/** What a visitor with no stored preference gets. */
export const DEFAULT_LOCALE: Locale = 'zh-CN'

/** Namespaced so it cannot collide with anything else on the origin. */
export const LOCALE_KEY = 'splunk-cli:locale'

/** A message that inflects, keyed by the CLDR plural category. */
interface PluralForms {
  readonly one?: string
  readonly other: string
}

/** Values a message may interpolate. `count` is consumed by the plural rules. */
export type MessageParams = Readonly<Record<string, string | number>>

type Catalog = typeof zhCN

/**
 * Every dotted path through the catalog that ends at a message.
 *
 * The recursion stops at a plural form rather than descending into it, so
 * `format.seconds` is a key and `format.seconds.other` is not — the plural
 * category is chosen at runtime by the count, never by the caller.
 */
type Path<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : T[K] extends PluralForms
      ? K
      : T[K] extends object
        ? `${K}.${Path<T[K]>}`
        : never
}[keyof T & string]

/**
 * A key that resolves in every shipped catalog.
 *
 * Derived from the Chinese catalog, which is the source of truth: a key is
 * added by writing it there first. The parity test in `locales.test.ts` holds
 * the other catalogs to the same shape, so a missing translation fails the
 * suite rather than silently rendering a raw key.
 */
export type MessageKey = Path<Catalog>

const CATALOGS: Readonly<Record<Locale, Catalog>> = { 'zh-CN': zhCN, 'en-US': enUS }

/** Is this one of the locales this build ships? */
export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale === value)
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    // Storage can be blocked outright (private windows, hardened settings).
    return null
  }
}

/** Read the stored locale, falling back to Chinese for anything unrecognised. */
export function readLocale(storage: Storage | null = defaultStorage()): Locale {
  if (storage === null) return DEFAULT_LOCALE
  try {
    const raw = storage.getItem(LOCALE_KEY)
    return isLocale(raw) ? raw : DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

/** Persist the choice. A blocked store must not break the page. */
export function writeLocale(locale: Locale, storage: Storage | null = defaultStorage()): void {
  if (storage === null) return
  try {
    storage.setItem(LOCALE_KEY, locale)
  } catch {
    // Ignored on purpose: the page is already in the chosen language; failing
    // to remember it only costs the next reload.
  }
}

/** Walk a dotted key through a catalog, or `undefined` where it runs out. */
function lookup(catalog: unknown, key: string): unknown {
  let node: unknown = catalog
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

/** A message that inflects is an object whose `other` form is always present. */
function isPluralForms(value: unknown): value is PluralForms {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { other?: unknown }).other === 'string'
  )
}

/**
 * One rules object per locale.
 *
 * Constructing `Intl.PluralRules` compiles the locale's plural tables, and
 * these are read on every row of a table — worth keeping rather than rebuilding.
 */
const PLURAL_RULES = new Map<Locale, Intl.PluralRules>()

function pluralRules(locale: Locale): Intl.PluralRules {
  const cached = PLURAL_RULES.get(locale)
  if (cached !== undefined) return cached
  const created = new Intl.PluralRules(locale)
  PLURAL_RULES.set(locale, created)
  return created
}

/**
 * Replace `{name}` with the parameter of that name.
 *
 * A placeholder with no matching parameter is left verbatim rather than
 * replaced with "undefined": a stray `{status}` reads as a bug, whereas
 * "undefined" reads as a value.
 */
function interpolate(template: string, params?: MessageParams): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params[name]
    return value === undefined ? placeholder : String(value)
  })
}

/**
 * The message for `key` in `locale`, with its placeholders filled.
 *
 * A key that resolves to nothing returns itself. That keeps the failure visible
 * on screen — `job.titl` obviously wants translating, an empty string does not
 * — and it keeps this function total, so no render path can throw on a typo.
 */
export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const found = lookup(CATALOGS[locale], key)
  if (typeof found === 'string') return interpolate(found, params)
  if (!isPluralForms(found)) return key

  const count = params?.['count']
  // No count means the caller wants the bare name — the editor's unit picker.
  const form = typeof count === 'number' ? pluralRules(locale).select(count) : 'other'
  const chosen = (form === 'one' ? found.one : undefined) ?? found.other
  return interpolate(chosen, params)
}

let active: Locale = readLocale()

const listeners = new Set<() => void>()

/** The locale every plain module formats for. */
export function getLocale(): Locale {
  return active
}

/** Watch for a language change. Returns the unsubscribe function. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Put the language on `<html>` and the title on the document.
 *
 * Both live outside the React tree, so neither can be rendered by a component.
 * The title is translated here rather than kept as a second literal, because a
 * tab that says one language while the page says another is the kind of detail
 * that reads as broken.
 */
export function applyLocale(locale: Locale): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale
  document.title = translate(locale, 'app.documentTitle')
}

/** Switch the language everywhere at once. */
export function setLocale(locale: Locale): void {
  active = locale
  applyLocale(locale)
  writeLocale(locale)
  for (const listener of listeners) listener()
}

/** Test seam: drop the in-memory copy and re-read storage. */
export function resetLocale(): void {
  const next = readLocale()
  active = next
  applyLocale(next)
  for (const listener of listeners) listener()
}
