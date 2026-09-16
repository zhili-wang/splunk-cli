/**
 * The theme, remembered across reloads.
 *
 * Dark is the default and is what `:root` declares; a stored preference only
 * ever has to override it. Nothing here touches the DOM — `useTheme` applies it,
 * and `index.html` applies it once before the first paint so a light-mode reload
 * does not flash dark.
 */

/** The two themes the stylesheet defines. */
export type Theme = 'dark' | 'light'

/** Namespaced so it cannot collide with anything else on the origin. */
export const THEME_KEY = 'splunk-cli:theme'

/** What a visitor with no stored preference gets. */
export const DEFAULT_THEME: Theme = 'dark'

export function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light'
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    // Storage can be blocked outright (private windows, hardened settings).
    return null
  }
}

/** Read the stored theme, falling back to dark for anything unrecognised. */
export function readTheme(storage: Storage | null = defaultStorage()): Theme {
  if (storage === null) return DEFAULT_THEME
  try {
    const raw = storage.getItem(THEME_KEY)
    return isTheme(raw) ? raw : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

/** Persist the theme. A blocked store must not break the page. */
export function writeTheme(theme: Theme, storage: Storage | null = defaultStorage()): void {
  if (storage === null) return
  try {
    storage.setItem(THEME_KEY, theme)
  } catch {
    // Ignored on purpose: the theme is already applied; failing to remember it
    // only costs the next reload.
  }
}
