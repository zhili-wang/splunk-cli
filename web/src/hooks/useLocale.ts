/**
 * The active language.
 *
 * A module-level store read through `useSyncExternalStore`, like the theme, the
 * query history and the field selection: the tabs stay mounted side by side, and
 * two copies of "which language is on" would eventually disagree.
 *
 * The store itself lives in `lib/i18n.ts` rather than here. It has to: the plain
 * modules that format numbers and dates for the active locale — `format.ts`,
 * `timeRange.ts`, `api/client.ts` — are not components and may not depend on
 * React. This hook is the React binding over that store, and nothing else.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'

import {
  DEFAULT_LOCALE,
  LOCALES,
  applyLocale,
  getLocale,
  setLocale as writeLocaleChoice,
  subscribe,
  translate,
  type Locale,
  type MessageKey,
  type MessageParams,
} from '../lib/i18n'

/**
 * The language a switch would give you.
 *
 * Cycled rather than flipped, so adding a third catalog needs no change here.
 */
function nextLocale(current: Locale): Locale {
  const following = LOCALES[(LOCALES.indexOf(current) + 1) % LOCALES.length]
  return following ?? DEFAULT_LOCALE
}

export interface LocaleState {
  locale: Locale
  /** The language a switch would give you. */
  next: Locale
  setLocale: (locale: Locale) => void
  toggle: () => void
  /** The active catalog, already bound to the current locale. */
  t: (key: MessageKey, params?: MessageParams) => string
}

export function useLocale(): LocaleState {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale)

  // The attribute has to be right on first mount too, not only on change: a
  // reload has to come back in the stored language, and nothing "changed".
  useEffect(() => {
    applyLocale(locale)
  }, [locale])

  const setLocale = useCallback((value: Locale) => writeLocaleChoice(value), [])
  // Read through the store rather than the closure, so a toggle never acts on a
  // locale the render was too old to see.
  const toggle = useCallback(() => writeLocaleChoice(nextLocale(getLocale())), [])
  const t = useCallback(
    (key: MessageKey, params?: MessageParams) => translate(locale, key, params),
    [locale],
  )

  return { locale, next: nextLocale(locale), setLocale, toggle, t }
}
