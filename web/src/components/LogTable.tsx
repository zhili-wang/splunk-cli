/**
 * The event list.
 *
 * Splunk's list view, reduced to what this API actually returns: a time column,
 * the event text, and the fields an operator reads — with the bookkeeping fields
 * (`_bkt`, `_cd`, `_serial`, …) out of the way until asked for. Clicking a row
 * opens the whole event, which is where the raw text and the internal fields
 * finally earn their space.
 *
 * Highlighting is presentation only: the query is never rewritten, and the terms
 * are pulled out locally just to mark what the operator was looking for.
 *
 * Paging is client-side because the result set is already in hand, and it is not
 * cosmetic: a default search returns up to 5000 events, and mounting 40 000 cells
 * makes every later interaction (opening a row, toggling a field) stutter.
 */

import { Fragment, useEffect, useMemo, useState } from 'react'

import { useFieldSelection } from '../hooks/useFieldSelection'
import { useLocale } from '../hooks/useLocale'
import { fieldCounts, fieldNames, highlight, orderedFields, queryTerms } from '../lib/fields'
import { formatTimestamp } from '../lib/format'
import { pageWindow, parsePageNumber } from '../lib/pagination'

interface Props {
  rows: Record<string, unknown>[]
  /** The submitted query, used only to mark matching terms. */
  query?: string
}

/** Rows per page. Sized so a page is scannable and the DOM stays small. */
const PAGE_SIZES = [50, 100, 500] as const

/** Fields whose value names a severity, in the order we look for them. */
const LEVEL_FIELDS = ['level', 'severity', 'log_level'] as const

const TONE_BAD = /^(fatal|critical|error|err|severe|emerg|alert)$/i
const TONE_WARN = /^(warn|warning)$/i
const TONE_INFO = /^(info|notice|ok)$/i

function levelTone(value: string): string {
  if (TONE_BAD.test(value)) return 'border-signal-bad/50 bg-signal-bad/10 text-signal-bad'
  if (TONE_WARN.test(value)) return 'border-signal-warn/50 bg-signal-warn/10 text-signal-warn'
  if (TONE_INFO.test(value)) return 'border-signal-info/50 bg-signal-info/10 text-signal-info'
  return 'border-ink-600 bg-ink-800 text-signal-muted'
}

function textOf(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

/** The severity field this event carries, if any. */
function levelField(row: Record<string, unknown>): string | null {
  for (const name of LEVEL_FIELDS) if (textOf(row[name]) !== '') return name
  return null
}

function Marked({ text, terms }: { text: string; terms: readonly string[] }): JSX.Element {
  const parts = highlight(text, terms)
  if (parts.every((part) => !part.hit)) return <>{text}</>
  return (
    <>
      {parts.map((part, index) =>
        part.hit ? (
          <mark
            key={index}
            className="rounded-sm bg-accent/30 px-0.5 text-[color:var(--text-primary)]"
          >
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}

/** One field/value pair in the expanded view, rendered as `name = value`. */
function DetailRow({
  name,
  value,
  terms,
}: {
  name: string
  value: string
  terms: readonly string[]
}): JSX.Element {
  return (
    <div className="border-b border-ink-850 py-1 font-mono text-xs last:border-b-0">
      <span className="text-signal-muted">{name}</span>
      <span className="text-signal-muted"> = </span>
      <span className="whitespace-pre-wrap break-all">
        <Marked text={value} terms={terms} />
      </span>
    </div>
  )
}

export function LogTable({ rows, query = '' }: Props): JSX.Element {
  const { locale, t } = useLocale()
  const fields = useMemo(() => orderedFields(rows, { includeInternal: true }), [rows])
  const counts = useMemo(
    () => new Map(fieldCounts(rows).map((entry) => [entry.name, entry.count])),
    [rows],
  )
  const terms = useMemo(() => queryTerms(query), [query])

  // The field selection is stored rather than local state: an operator who
  // hides `linecount` means it, and losing that on every reload is a small
  // betrayal. Only the deviations from the default rule are remembered.
  const { isVisible, toggle, showAll, reset } = useFieldSelection()
  const [expanded, setExpanded] = useState<number | null>(null)
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0])
  const [page, setPage] = useState(0)
  const [jump, setJump] = useState('')

  // A new result set starts on its own first page, and a typed page number from
  // the previous one has nothing left to point at.
  useEffect(() => {
    setPage(0)
    setJump('')
  }, [rows])

  const visible = fields.filter(isVisible)

  if (rows.length === 0) {
    return <p className="px-4 py-6 text-sm text-signal-muted">{t('table.empty')}</p>
  }

  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
  // Clamped rather than stored, so shrinking the result set cannot strand the
  // view on a page that no longer exists.
  const currentPage = Math.min(page, pageCount - 1)
  const start = currentPage * pageSize
  const pageRows = rows.slice(start, start + pageSize)
  const jumpTarget = parsePageNumber(jump, pageCount)

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-ink-800 px-4 py-2">
        <span className="mr-1 text-[0.7rem] uppercase tracking-[0.14em] text-signal-muted">
          {t('table.fields')}
        </span>
        {fields.map((name) => {
          const on = visible.includes(name)
          const count = counts.get(name) ?? 0
          return (
            <button
              key={name}
              type="button"
              aria-pressed={on}
              aria-label={t('table.fieldAria', { name })}
              onClick={() => toggle(name)}
              title={t('table.fieldTitle', {
                // Ungrouped on purpose: the badge beside this title prints the
                // same number the same way, and the i18n change did not set out
                // to reformat either of them. No count either — the sentence's
                // subject is the fraction, so the numerator must not drive its
                // plural form.
                value: count,
                name,
                total: rows.length,
              })}
              className={[
                'rounded-full border px-2 py-0.5 font-mono text-[0.7rem] transition-colors',
                on
                  ? 'border-accent/60 bg-accent/15 text-[color:var(--text-primary)]'
                  : 'border-ink-700 text-signal-muted hover:border-ink-600 hover:text-[color:var(--text-primary)]',
              ].join(' ')}
            >
              {name}
              <span className="tnum ml-1 text-signal-muted">{count}</span>
            </button>
          )
        })}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => showAll(fields)}
            className="rounded-md border border-ink-700 px-2 py-0.5 text-[0.7rem] text-signal-muted transition-colors hover:border-ink-600 hover:text-[color:var(--text-primary)]"
          >
            {t('table.showAll')}
          </button>
          <button
            type="button"
            onClick={reset}
            className="rounded-md border border-ink-700 px-2 py-0.5 text-[0.7rem] text-signal-muted transition-colors hover:border-ink-600 hover:text-[color:var(--text-primary)]"
          >
            {t('table.reset')}
          </button>
        </div>
      </div>

      {/* Above the list: with 5000 events the pager would otherwise sit below a
          very long scroll, which is exactly where nobody looks for it. */}
      {rows.length > PAGE_SIZES[0] ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-4 py-1.5 text-xs text-signal-muted">
          <span className="tnum">
            {start + 1}–{Math.min(start + pageSize, rows.length)} / {rows.length}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <span>{t('table.pageSize')}</span>
            {PAGE_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                aria-pressed={pageSize === size}
                onClick={() => {
                  setPageSize(size)
                  setPage(0)
                }}
                className={[
                  'tnum rounded-md border px-2 py-0.5 transition-colors',
                  pageSize === size
                    ? 'border-accent/60 bg-accent/15 text-[color:var(--text-primary)]'
                    : 'border-ink-700 hover:border-ink-600 hover:text-[color:var(--text-primary)]',
                ].join(' ')}
              >
                {size}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPage(currentPage - 1)}
              disabled={currentPage === 0}
              className="rounded-md border border-ink-700 px-2 py-0.5 transition-colors hover:border-ink-600 hover:text-[color:var(--text-primary)] disabled:opacity-40"
            >
              {t('table.prev')}
            </button>

            {/* A search can run to 100 pages, so the ends plus the neighbours
                around the current page, with a gap for everything skipped. */}
            {pageWindow(currentPage, pageCount).map((slot, index) =>
              slot === 'gap' ? (
                <span key={`gap-${index}`} className="px-0.5">
                  …
                </span>
              ) : (
                <button
                  key={slot}
                  type="button"
                  aria-label={t('table.pageAria', { page: slot + 1 })}
                  aria-current={slot === currentPage ? 'page' : undefined}
                  onClick={() => setPage(slot)}
                  className={[
                    'tnum rounded-md border px-2 py-0.5 transition-colors',
                    slot === currentPage
                      ? 'border-accent/60 bg-accent/15 text-[color:var(--text-primary)]'
                      : 'border-ink-700 hover:border-ink-600 hover:text-[color:var(--text-primary)]',
                  ].join(' ')}
                >
                  {slot + 1}
                </button>
              ),
            )}

            <button
              type="button"
              onClick={() => setPage(currentPage + 1)}
              disabled={currentPage >= pageCount - 1}
              className="rounded-md border border-ink-700 px-2 py-0.5 transition-colors hover:border-ink-600 hover:text-[color:var(--text-primary)] disabled:opacity-40"
            >
              {t('table.next')}
            </button>

            <label className="ml-1 flex items-center gap-1">
              <span>{t('table.jumpTo')}</span>
              <input
                type="text"
                inputMode="numeric"
                aria-label={t('table.jumpAria')}
                value={jump}
                placeholder={String(currentPage + 1)}
                onChange={(event) => setJump(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || jumpTarget === null) return
                  setPage(jumpTarget)
                }}
                className="tnum w-12 rounded-md border border-ink-700 bg-ink-950 px-1.5 py-0.5 text-center outline-none transition-colors focus:border-accent"
              />
              <span>{t('table.pageUnit')}</span>
            </label>
            <button
              type="button"
              // Disabled rather than clamped: silently landing on a page the
              // operator did not ask for is worse than refusing.
              disabled={jumpTarget === null}
              onClick={() => {
                if (jumpTarget !== null) setPage(jumpTarget)
              }}
              className="rounded-md border border-ink-700 px-2 py-0.5 transition-colors hover:border-ink-600 hover:text-[color:var(--text-primary)] disabled:opacity-40"
            >
              {t('table.go')}
            </button>
          </div>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <p className="px-4 py-6 text-sm text-signal-muted">{t('table.noneSelected')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">
              {t('table.caption', { count: rows.length, value: rows.length })}
            </caption>
            <thead>
              <tr className="border-b border-ink-800">
                <th
                  scope="col"
                  className="sticky top-0 z-[1] w-12 bg-ink-900 px-3 py-2 text-right font-mono text-xs font-medium text-signal-muted"
                >
                  #
                </th>
                {visible.map((name) => (
                  <th
                    key={name}
                    scope="col"
                    className="sticky top-0 z-[1] whitespace-nowrap bg-ink-900 px-3 py-2 font-mono text-xs font-medium uppercase tracking-wider text-signal-muted"
                  >
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row, index) => {
                // Absolute row number, so page 2 continues where page 1 stopped.
                const number = start + index
                const isOpen = expanded === number
                const level = levelField(row)
                return (
                  <Fragment key={number}>
                    <tr
                      onClick={() => setExpanded(isOpen ? null : number)}
                      className={[
                        'cursor-pointer border-b border-ink-850 align-top',
                        isOpen ? 'bg-ink-850/80' : 'hover:bg-ink-850/50',
                      ].join(' ')}
                    >
                      <td className="px-3 py-1.5 text-right">
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          aria-label={t('table.rowAria', {
                            action: isOpen ? t('table.collapse') : t('table.expand'),
                            row: number + 1,
                          })}
                          className="tnum text-xs text-signal-muted transition-colors hover:text-[color:var(--text-primary)]"
                        >
                          {number + 1}
                        </button>
                      </td>
                      {visible.map((name) => {
                        const raw = textOf(row[name])
                        if (name === '_time') {
                          return (
                            <td
                              key={name}
                              className="tnum whitespace-nowrap px-3 py-1.5 text-signal-muted"
                            >
                              {formatTimestamp(row[name], locale)}
                            </td>
                          )
                        }
                        if (name === '_raw') {
                          return (
                            <td key={name} className="px-3 py-1.5">
                              {/* Shown whole: an event truncated with an ellipsis is
                                  an event the operator cannot read. */}
                              <div className="whitespace-pre-wrap break-all font-mono text-xs">
                                <Marked text={raw} terms={terms} />
                              </div>
                            </td>
                          )
                        }
                        if (name === level) {
                          return (
                            <td key={name} className="whitespace-nowrap px-3 py-1.5">
                              <span
                                className={`rounded border px-1.5 py-0.5 font-mono text-[0.7rem] ${levelTone(raw)}`}
                              >
                                {raw}
                              </span>
                            </td>
                          )
                        }
                        return (
                          <td key={name} className="px-3 py-1.5">
                            {/* Wrapped, never clipped. */}
                            <div className="whitespace-pre-wrap break-words font-mono">{raw}</div>
                          </td>
                        )
                      })}
                    </tr>
                    {isOpen ? (
                      <tr className="border-b border-ink-800 bg-ink-900">
                        <td />
                        <td colSpan={visible.length} className="px-3 pb-3 pt-1">
                          {textOf(row['_raw']) !== '' ? (
                            <pre className="mb-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md border border-ink-800 bg-ink-950 p-3 font-mono text-xs">
                              <Marked text={textOf(row['_raw'])} terms={terms} />
                            </pre>
                          ) : null}
                          <div className="rounded-md border border-ink-800 bg-ink-950 px-3 py-2">
                            {fieldNames([row])
                              .filter((name) => name !== '_raw')
                              .map((name) => (
                                <DetailRow
                                  key={name}
                                  name={name}
                                  value={textOf(row[name])}
                                  terms={terms}
                                />
                              ))}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
