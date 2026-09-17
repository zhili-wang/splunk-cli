import { useEffect, useState } from 'react'

import { fetchHealth } from '../api/endpoints'
import { useLocale } from '../hooks/useLocale'
import type { MessageKey } from '../lib/i18n'
import type { HealthReport } from '../types/api'

type State = 'checking' | 'ok' | 'failed'

const STYLES: Record<State, string> = {
  checking: 'bg-signal-muted',
  ok: 'bg-signal-ok',
  failed: 'bg-signal-bad',
}

/** The text lives in `src/locales`; the key is checked against the catalog. */
const LABELS: Record<State, MessageKey> = {
  checking: 'connection.checking',
  ok: 'connection.ok',
  failed: 'connection.failed',
}

export function ConnectionStatus(): JSX.Element {
  const { t } = useLocale()
  const [report, setReport] = useState<HealthReport | null>(null)
  const [state, setState] = useState<State>('checking')

  useEffect(() => {
    let active = true

    const probe = (): void => {
      fetchHealth()
        .then((value) => {
          if (!active) return
          setReport(value)
          setState(value.connection === 'ok' && value.authentication === 'ok' ? 'ok' : 'failed')
        })
        .catch(() => {
          if (!active) return
          setReport(null)
          setState('failed')
        })
    }

    probe()
    // Splunk state changes on its own; the badge should not go stale.
    const timer = window.setInterval(probe, 30_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  const detail =
    state === 'ok' ? `Splunk ${report?.splunk?.version ?? ''}`.trim() : (report?.error?.message ?? '')

  return (
    <div className="flex items-center gap-2 text-xs" title={detail}>
      <span
        aria-hidden
        className={`h-2 w-2 rounded-full ${STYLES[state]} ${
          state === 'checking' ? 'animate-pulse' : ''
        }`}
      />
      <span className="text-signal-muted">{t(LABELS[state])}</span>
      {state === 'ok' && report?.latency_ms !== undefined ? (
        <span className="tnum text-signal-muted/70">{report.latency_ms.toFixed(0)}ms</span>
      ) : null}
    </div>
  )
}
