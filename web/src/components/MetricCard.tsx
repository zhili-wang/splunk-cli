import { useLocale } from '../hooks/useLocale'
import { formatCount } from '../lib/format'

interface Props {
  label: string
  value: number | null
  hint?: string
}

export function MetricCard({ label, value, hint }: Props): JSX.Element {
  const { t } = useLocale()
  const unknown = value === null

  return (
    <div className="panel px-4 py-3">
      <div className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-signal-muted">
        {label}
      </div>
      <div
        className={`tnum mt-1 text-3xl font-semibold leading-none ${
          unknown ? 'text-signal-muted' : 'text-[color:var(--text-primary)]'
        }`}
      >
        {formatCount(value)}
      </div>
      {hint !== undefined ? (
        <div className="mt-1 text-xs text-signal-muted">
          {unknown ? t('common.unavailable') : hint}
        </div>
      ) : null}
    </div>
  )
}
