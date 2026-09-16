/**
 * Field and highlight helpers for the event list.
 *
 * Everything here is **presentation only**. The API hands over rows exactly as
 * the service layer shaped them; this module decides which of them are worth a
 * column and in what order — the same split Splunk makes between the fields an
 * operator reads and the bookkeeping fields it carries for its own use.
 *
 * Nothing here builds SPL, and nothing here is sent anywhere: the query the
 * operator typed reaches the backend untouched.
 */

/** Splunk's own bookkeeping fields. `_time` and `_raw` are the readable exceptions. */
const READABLE_INTERNAL = new Set(['_time', '_raw'])

/** The order an operator reads fields in, when the event carries them. */
const PREFERRED = ['_time', '_raw', 'host', 'service', 'app', 'level', 'severity', 'message']

/** Values that mean "this field is absent from this event". */
function hasValue(row: Record<string, unknown>, field: string): boolean {
  const value = row[field]
  return value !== undefined && value !== null && value !== ''
}

/** A field Splunk adds for its own bookkeeping rather than for the reader. */
export function isInternalField(name: string): boolean {
  return name.startsWith('_') && !READABLE_INTERNAL.has(name)
}

/**
 * Every field present across the rows, in reading order: the well-known ones
 * first, then the rest alphabetically, then Splunk's bookkeeping fields last —
 * so the table and the field list are stable between rows and the readable
 * fields never get pushed below the internal ones.
 */
export function fieldNames(rows: readonly Record<string, unknown>[]): string[] {
  const present = new Set<string>()
  for (const row of rows) for (const key of Object.keys(row)) present.add(key)

  const head = PREFERRED.filter((key) => present.has(key))
  const rest = [...present].filter((key) => !head.includes(key))
  const readable = rest.filter((name) => !isInternalField(name)).sort()
  const internal = rest.filter(isInternalField).sort()
  return [...head, ...readable, ...internal]
}

/**
 * The columns to draw.
 *
 * `_time` leads and `_raw` (the event text) comes next; the internal fields are
 * kept out unless asked for, because `_bkt`/`_cd`/`_serial` and friends are
 * noise that pushes the readable columns off the screen.
 */
export function orderedFields(
  rows: readonly Record<string, unknown>[],
  options: { includeInternal?: boolean } = {},
): string[] {
  const all = fieldNames(rows)
  if (options.includeInternal === true) return all
  return all.filter((name) => !isInternalField(name))
}

/** How many events actually carry a value for each field. */
export function fieldCounts(
  rows: readonly Record<string, unknown>[],
): Array<{ name: string; count: number }> {
  return fieldNames(rows).map((name) => ({
    name,
    count: rows.reduce((total, row) => total + (hasValue(row, name) ? 1 : 0), 0),
  }))
}

/** Words the highlighter ignores: SPL operators, not search terms. */
const STOP_WORDS = new Set(['and', 'or', 'not', 'search'])

/**
 * Pull the terms worth highlighting out of an SPL string.
 *
 * Deliberately naive — this is a highlighter, not a parser. It ignores anything
 * after the first pipe (those are commands, not search terms), keeps quoted
 * phrases whole, and reduces `field=value` to `value`, because that is what the
 * operator is looking for in the event text. Wildcards are dropped to their
 * literal prefix and one-character terms are ignored, so the whole event does
 * not light up.
 */
export function queryTerms(query: string): string[] {
  const head = query.split('|')[0] ?? ''
  const terms: string[] = []

  const push = (raw: string): void => {
    const value = raw.replace(/^[*]+/, '').replace(/[*]+$/, '').trim()
    if (value.length < 2) return
    if (STOP_WORDS.has(value.toLowerCase())) return
    if (!terms.some((existing) => existing.toLowerCase() === value.toLowerCase())) terms.push(value)
  }

  // One pass, in source order: a quoted phrase is one term, anything else is a
  // whitespace-delimited token.
  const token = /"([^"]+)"|'([^']+)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = token.exec(head)) !== null) {
    const quoted = match[1] ?? match[2]
    if (quoted !== undefined) {
      push(quoted)
      continue
    }
    const bare = match[3] ?? ''
    const equals = bare.indexOf('=')
    // `field=value` → the value; a bare token is used as-is.
    push(equals === -1 ? bare : bare.slice(equals + 1))
  }

  return terms
}

/** A run of text, marked as a search hit or not. */
export interface Highlight {
  text: string
  hit: boolean
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Case-insensitive literal alternation, longest term first so overlaps prefer the longer one. */
function termPattern(terms: readonly string[]): RegExp | null {
  const usable = terms
    .filter((term) => term !== '')
    .sort((left, right) => right.length - left.length)
  if (usable.length === 0) return null
  return new RegExp(usable.map(escapeRegExp).join('|'), 'gi')
}

/** Split `text` into the runs that matched `terms` and the runs that did not. */
export function highlight(text: string, terms: readonly string[]): Highlight[] {
  const pattern = termPattern(terms)
  if (pattern === null) return [{ text, hit: false }]

  const parts: Highlight[] = []
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > last) parts.push({ text: text.slice(last, start), hit: false })
    parts.push({ text: match[0], hit: true })
    last = start + match[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false })
  return parts
}
