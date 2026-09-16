import type { ApiError } from '../api/client'
import type { ErrorDetail } from '../types/api'

interface Props {
  error: ApiError | ErrorDetail
  compact?: boolean
}

export function ErrorNote({ error, compact = false }: Props): JSX.Element {
  const type = error.type
  return (
    <div
      role="alert"
      className="rounded-md border border-signal-bad/40 bg-signal-bad/5 px-3 py-2 text-sm"
    >
      <span className="font-mono text-xs uppercase tracking-wider text-signal-bad">{type}</span>
      <p className="mt-1 text-[color:var(--text-primary)]">{error.message}</p>
      {!compact && error.details !== undefined ? (
        <pre className="mt-2 overflow-x-auto rounded bg-ink-950/60 p-2 text-xs text-signal-muted">
          {JSON.stringify(error.details, null, 2)}
        </pre>
      ) : null}
    </div>
  )
}
