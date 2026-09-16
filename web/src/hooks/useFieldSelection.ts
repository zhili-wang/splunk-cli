/**
 * The field selection, shared by every table in the session.
 *
 * A module-level store read through `useSyncExternalStore`, for the same reason
 * the query history is one: the tabs stay mounted next to each other, and a
 * choice made in one place should not be a different choice in another.
 * localStorage is what makes it survive a reload — the whole point of the store.
 */

import { useSyncExternalStore } from 'react'

import {
  isFieldVisible,
  readFieldSelection,
  toggleField,
  withAllVisible,
  writeFieldSelection,
  type FieldOverrides,
} from '../lib/fieldSelection'

let snapshot: FieldOverrides = readFieldSelection()
const listeners = new Set<() => void>()

function emit(next: FieldOverrides): void {
  snapshot = next
  writeFieldSelection(snapshot)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): FieldOverrides {
  return snapshot
}

/** Test seam: drop the in-memory copy and re-read storage. */
export function resetFieldSelection(): void {
  snapshot = readFieldSelection()
  for (const listener of listeners) listener()
}

export interface FieldSelection {
  overrides: FieldOverrides
  isVisible: (name: string) => boolean
  toggle: (name: string) => void
  showAll: (names: readonly string[]) => void
  reset: () => void
}

export function useFieldSelection(): FieldSelection {
  const overrides = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return {
    overrides,
    isVisible: (name) => isFieldVisible(overrides, name),
    toggle: (name) => emit(toggleField(snapshot, name)),
    showAll: (names) => emit(withAllVisible(snapshot, names)),
    reset: () => emit({}),
  }
}
