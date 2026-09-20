/**
 * Whether this page's server is still supposed to be serving it.
 *
 * A module-level store read through `useSyncExternalStore`, like the theme and
 * the locale. It has to be shared rather than local state: the button that
 * stops the service sits in the footer while the connection badge sits in the
 * header, and the badge must stop claiming "not connected" the instant the
 * service is deliberately switched off. Those are two answers to the same
 * question and they must not drift.
 *
 * Three states, not a boolean, because "we asked it to stop" is genuinely
 * different from "it has stopped": the request can still fail, and until it
 * settles the honest thing to show is neither.
 */

import { useSyncExternalStore } from 'react'

export type ServiceState = 'running' | 'stopping' | 'stopped'

let snapshot: ServiceState = 'running'
const listeners = new Set<() => void>()

function emit(next: ServiceState): void {
  // A repeated `markStopping()` while already stopping is not a transition, and
  // re-notifying would re-render every subscriber for nothing.
  if (next === snapshot) return
  snapshot = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): ServiceState {
  return snapshot
}

/** A stop was requested; whether it took is not known yet. */
export function markStopping(): void {
  emit('stopping')
}

/** The service is going away. Nothing short of a restart brings it back. */
export function markStopped(): void {
  emit('stopped')
}

/** The stop did not take, and the dashboard is still answering. */
export function markRunning(): void {
  emit('running')
}

/** Test seam: back to the state a fresh page load starts in. */
export function resetServiceState(): void {
  snapshot = 'running'
  for (const listener of listeners) listener()
}

export function useServiceState(): ServiceState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
