/**
 * The query box plus its history.
 *
 * Both tabs use this so the history is one list rather than two: a query run on
 * the overview is offered again on the search tab. `SearchBar` stays a plain
 * input — everything that touches stored state lives here.
 */

import { useState } from 'react'

import { useQueryHistory } from '../hooks/useQueryHistory'
import { SearchBar } from './SearchBar'

interface Props {
  query: string
  onQuery: (query: string) => void
  /** Called with the query to run, so the caller never has to read stale state. */
  onSubmit: (query: string) => void
  loading: boolean
}

export function QueryBar({ query, onQuery, onSubmit, loading }: Props): JSX.Element {
  const { history, remember, forget, clear } = useQueryHistory()
  const [open, setOpen] = useState(false)

  const run = (value: string): void => {
    const trimmed = value.trim()
    if (trimmed === '') return
    onQuery(trimmed)
    onSubmit(trimmed)
    remember(trimmed)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <SearchBar query={query} onQuery={onQuery} onSubmit={() => run(query)} loading={loading} />

      <div className="flex flex-wrap items-center gap-2 text-xs text-signal-muted">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="rounded-md border border-ink-700 px-2 py-0.5 transition-colors hover:border-ink-600 hover:text-[color:var(--text-primary)]"
        >
          历史查询{history.length > 0 ? ` (${history.length})` : ''}
        </button>

        {open && history.length > 0 ? (
          <button
            type="button"
            onClick={clear}
            className="rounded-md border border-ink-700 px-2 py-0.5 transition-colors hover:border-signal-bad hover:text-signal-bad"
          >
            清空
          </button>
        ) : null}

        {!open ? <span>运行过的查询会记在这里</span> : null}
      </div>

      {open ? (
        history.length === 0 ? (
          <p className="text-xs text-signal-muted">还没有查询记录。</p>
        ) : (
          <ul aria-label="查询历史" className="divide-y divide-ink-800 rounded-md border border-ink-700 bg-ink-900">
            {history.map((item) => (
              <li key={item} className="flex items-center gap-2 px-2 py-1">
                <button
                  type="button"
                  onClick={() => run(item)}
                  title={item}
                  className="flex-1 truncate text-left font-mono text-xs text-signal-muted transition-colors hover:text-[color:var(--text-primary)]"
                >
                  {item}
                </button>
                <button
                  type="button"
                  aria-label={`删除记录 ${item}`}
                  onClick={() => forget(item)}
                  className="rounded px-1.5 text-sm leading-none text-signal-muted transition-colors hover:text-signal-bad"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  )
}
