/**
 * Recent queries, kept in the browser.
 *
 * Nothing here reaches Splunk or the backend: the history is an operator
 * convenience, stored locally, and it never becomes part of a request. It is
 * also the only piece of state the dashboard persists — everything else would
 * be stale the moment it was written.
 */

/** How many queries are worth remembering before the list stops being scannable. */
export const HISTORY_LIMIT = 10

/** Storage key. Namespaced so it cannot collide with anything else on the origin. */
export const HISTORY_KEY = 'splunk-cli:query-history'

/**
 * Newest first, de-duplicated case-insensitively, oldest dropped past the cap.
 *
 * Re-running a query moves it to the top instead of adding a second copy, which
 * is what an operator means by "recent".
 */
export function addQuery(history: readonly string[], query: string): string[] {
  const trimmed = query.trim()
  if (trimmed === '') return [...history]
  const without = history.filter((item) => item.toLowerCase() !== trimmed.toLowerCase())
  return [trimmed, ...without].slice(0, HISTORY_LIMIT)
}

/** Drop one entry. Matching is exact: the UI always passes back what it showed. */
export function removeQuery(history: readonly string[], query: string): string[] {
  return history.filter((item) => item !== query)
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    // Storage can be blocked outright (private windows, hardened settings).
    return null
  }
}

/** Read the stored history, tolerating missing, malformed or foreign data. */
export function readHistory(storage: Storage | null = defaultStorage()): string[] {
  if (storage === null) return []
  try {
    const raw = storage.getItem(HISTORY_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .slice(0, HISTORY_LIMIT)
  } catch {
    return []
  }
}

/** Persist the history. A blocked store must not break the query that was run. */
export function writeHistory(
  history: readonly string[],
  storage: Storage | null = defaultStorage(),
): void {
  if (storage === null) return
  try {
    storage.setItem(HISTORY_KEY, JSON.stringify(history))
  } catch {
    // Ignored on purpose: the query already ran; failing to remember it is minor.
  }
}
