/**
 * Client-side CSV of the rows already on screen.
 *
 * Deliberately not Splunk's export endpoint: `search/jobs/export` is on the
 * forbidden list because it streams an unbounded result set without going
 * through the result cap. This writes the page the operator is looking at — the
 * same rows the table rendered, already bounded by `SPLUNK_MAX_RESULTS` — and
 * asks Splunk for nothing at all. The toolbar says so, so the file cannot be
 * mistaken for a full export.
 */

/** Quote a value the way RFC 4180 expects. */
function cell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value)

  // Quote when the text contains a delimiter, a quote or a line break; a quoted
  // field escapes its own quotes by doubling them.
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

/**
 * Render rows as CSV, one column per name in `columns`.
 *
 * Column order comes from the caller so the file matches the table: the operator
 * chose those columns, and a CSV that reorders them is a different document.
 */
export function toCsv(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: readonly string[],
): string {
  const lines = [columns.map(cell).join(',')]
  for (const row of rows) lines.push(columns.map((name) => cell(row[name])).join(','))
  return lines.join('\r\n')
}

/** A name that says which query and when, without guessing at the content. */
export function csvFileName(now: Date = new Date()): string {
  const pad = (part: number): string => String(part).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `splunk-cli-${stamp}.csv`
}

/**
 * Hand the text to the browser as a download.
 *
 * Returns whether a download was actually started, so a caller in an
 * environment without blob URLs (the test runner, an old browser) can say so
 * rather than appear to have done something.
 */
export function downloadCsv(filename: string, text: string): boolean {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return false
  // The BOM is what makes Excel read the file as UTF-8; without it the CJK
  // columns arrive as mojibake.
  const blob = new Blob([`\uFEFF${text}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
  return true
}
