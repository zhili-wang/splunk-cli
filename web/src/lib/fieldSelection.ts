/**
 * Which columns the operator chose to see, remembered across reloads.
 *
 * Only the **deviations** from the default rule are stored. A query's field list
 * differs per query, so remembering "the columns of the last query" would be
 * wrong the moment another query returned different fields; storing the
 * exceptions instead means a stored choice applies to the fields it names and
 * everything else keeps following the rule: readable fields shown, Splunk's
 * bookkeeping fields (`_bkt`, `_cd`, `_serial`, …) hidden.
 */

import { isInternalField } from './fields'

/** Namespaced so it cannot collide with anything else on the origin. */
export const FIELD_SELECTION_KEY = 'splunk-cli:field-selection'

/** Explicit show/hide choices, keyed by field name. Absent means "use the rule". */
export type FieldOverrides = Readonly<Record<string, boolean>>

/** Is this field on, honouring an explicit choice first and the rule second. */
export function isFieldVisible(overrides: FieldOverrides, name: string): boolean {
  return overrides[name] ?? !isInternalField(name)
}

/** Flip one field, recording the result explicitly so it survives a reload. */
export function toggleField(overrides: FieldOverrides, name: string): FieldOverrides {
  return { ...overrides, [name]: !isFieldVisible(overrides, name) }
}

/** Turn every named field on — what "全部字段" means for the fields in hand. */
export function withAllVisible(
  overrides: FieldOverrides,
  names: readonly string[],
): FieldOverrides {
  const next: Record<string, boolean> = { ...overrides }
  for (const name of names) next[name] = true
  return next
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    // Storage can be blocked outright (private windows, hardened settings).
    return null
  }
}

/** Read the stored choices, tolerating missing, malformed or foreign data. */
export function readFieldSelection(storage: Storage | null = defaultStorage()): FieldOverrides {
  if (storage === null) return {}
  try {
    const raw = storage.getItem(FIELD_SELECTION_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}

    const overrides: Record<string, boolean> = {}
    for (const [name, value] of Object.entries(parsed)) {
      if (name !== '' && typeof value === 'boolean') overrides[name] = value
    }
    return overrides
  } catch {
    return {}
  }
}

/** Persist the choices. A blocked store must not break the table. */
export function writeFieldSelection(
  overrides: FieldOverrides,
  storage: Storage | null = defaultStorage(),
): void {
  if (storage === null) return
  try {
    storage.setItem(FIELD_SELECTION_KEY, JSON.stringify(overrides))
  } catch {
    // Ignored on purpose: the columns are already on screen; failing to remember
    // the choice is a minor loss, not an error worth surfacing.
  }
}
