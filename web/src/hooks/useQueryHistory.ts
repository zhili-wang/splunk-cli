/**
 * One query history, shared by every tab.
 *
 * The tabs stay mounted (see `KeepAliveRoutes`), so a history owned by a page
 * would drift from the one beside it: run a query on the overview and the search
 * tab would still show the old list. A module-level store read through
 * `useSyncExternalStore` keeps every reader on the same snapshot, and
 * localStorage keeps it across reloads.
 */

import { useSyncExternalStore } from 'react'

import { addQuery, readHistory, removeQuery, writeHistory } from '../lib/queryHistory'

let snapshot: string[] = readHistory()
const listeners = new Set<() => void>()

function emit(next: string[]): void {
  snapshot = next
  writeHistory(snapshot)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): string[] {
  return snapshot
}

/** Test seam: drop the in-memory copy and re-read storage. */
export function resetQueryHistory(): void {
  snapshot = readHistory()
  for (const listener of listeners) listener()
}

export interface QueryHistory {
  history: string[]
  remember: (query: string) => void
  forget: (query: string) => void
  clear: () => void
}

export function useQueryHistory(): QueryHistory {
  const history = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return {
    history,
    remember: (query) => emit(addQuery(snapshot, query)),
    forget: (query) => emit(removeQuery(snapshot, query)),
    clear: () => emit([]),
  }
}
