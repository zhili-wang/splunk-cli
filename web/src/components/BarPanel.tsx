import { useLocale } from '../hooks/useLocale'
import { counted, formatCount, formatStatKey } from '../lib/format'
import type { StatRow } from '../types/api'

interface Props {
  title: string
  rows: StatRow[]
  emptyLabel: string
}

/** A ranked bar list. Read from a table, not a chart: the names matter more
 * than the bars, and a table is what makes them selectable and copyable. */
export function BarPanel({ title, rows, emptyLabel }: Props): JSX.Element {
  const { t } = useLocale()
  const top = rows.slice(0, 12)
  const peak = top.reduce((max, row) => Math.max(max, row.count), 0)

  return (
    <section className="panel">
      <header className="panel-header">
        <h2 className="panel-title">{title}</h2>
        <span className="tnum text-xs text-signal-muted">
          {t('bar.groups', counted(rows.length))}
        </span>
      </header>

      {top.length === 0 ? (
        <p className="px-4 py-6 text-sm text-signal-muted">{emptyLabel}</p>
      ) : (
        <ul className="divide-y divide-ink-800">
          {top.map((row) => {
            const key = formatStatKey(row.key)
            const share = peak === 0 ? 0 : (row.count / peak) * 100
            return (
              <li key={key} className="group relative px-4 py-2">
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 bg-accent/10 transition-[width] duration-300"
                  style={{ width: `${share}%` }}
                />
                <div className="relative flex items-baseline justify-between gap-3">
                  <span className="truncate font-mono text-sm" title={key}>
                    {key}
                  </span>
                  <span className="tnum shrink-0 text-sm text-signal-muted">
                    {formatCount(row.count)}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
