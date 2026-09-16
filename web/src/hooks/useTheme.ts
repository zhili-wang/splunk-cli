/**
 * The active theme.
 *
 * A module-level store read through `useSyncExternalStore`, like the query
 * history and the field selection: the tabs stay mounted side by side, and two
 * copies of "which theme is on" would eventually disagree.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'

import { DEFAULT_THEME, readTheme, writeTheme, type Theme } from '../lib/theme'

let snapshot: Theme = readTheme()
const listeners = new Set<() => void>()

/**
 * Put the theme on `<html>`, where the stylesheet looks for it.
 *
 * `index.html` does the same thing inline before the first paint; this is what
 * keeps the attribute right afterwards.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset['theme'] = theme
}

function emit(next: Theme): void {
  snapshot = next
  applyTheme(next)
  writeTheme(next)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): Theme {
  return snapshot
}

/** Test seam: drop the in-memory copy and re-read storage. */
export function resetTheme(): void {
  snapshot = readTheme()
  for (const listener of listeners) listener()
}

export interface ThemeState {
  theme: Theme
  /** The theme a click would switch to. */
  next: Theme
  setTheme: (theme: Theme) => void
  toggle: () => void
}

export function useTheme(): ThemeState {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // The attribute must also be right on first mount, not only on change.
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const setTheme = useCallback((value: Theme) => emit(value), [])
  const toggle = useCallback(() => emit(snapshot === 'dark' ? 'light' : 'dark'), [])

  return { theme, next: theme === DEFAULT_THEME ? 'light' : 'dark', setTheme, toggle }
}
