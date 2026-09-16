/**
 * The timeline format, shared by every timeline in the session.
 *
 * A module-level store read through `useSyncExternalStore`, for the same reason
 * the theme is one: the tabs stay mounted next to each other, and a shape chosen
 * on one timeline should not be a different shape on the next. localStorage is
 * what makes it survive a reload.
 */

import { useSyncExternalStore } from 'react'

import {
  readTimelineFormat,
  writeTimelineFormat,
  type TimelineFormat,
} from '../lib/timelineFormat'

let snapshot: TimelineFormat = readTimelineFormat()
const listeners = new Set<() => void>()

function emit(next: TimelineFormat): void {
  snapshot = next
  writeTimelineFormat(snapshot)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): TimelineFormat {
  return snapshot
}

/** Test seam: drop the in-memory copy and re-read storage. */
export function resetTimelineFormat(): void {
  snapshot = readTimelineFormat()
  for (const listener of listeners) listener()
}

export interface TimelineFormatState {
  format: TimelineFormat
  setFormat: (format: TimelineFormat) => void
}

export function useTimelineFormat(): TimelineFormatState {
  const format = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return { format, setFormat: (next) => emit(next) }
}
