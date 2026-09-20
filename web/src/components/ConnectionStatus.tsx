import { useEffect, useState } from 'react'

import { fetchHealth } from '../api/endpoints'
import { useLocale } from '../hooks/useLocale'
import { useServiceState } from '../hooks/useServiceState'
import type { MessageKey } from '../lib/i18n'
import type { HealthReport } from '../types/api'

type State = 'checking' | 'ok' | 'failed'

/**
 * What the badge can show.
 *
 * `stopping` and `stopped` are not richer versions of `failed`: a failed probe
 * means Splunk is unreachable, while these two mean the dashboard itself was
 * switched off on purpose. Painting the second as the first would blame Splunk
 * for something the user just did deliberately.
 */
type DisplayState = State | 'stopping' | 'stopped'

const STYLES: Record<DisplayState, string> = {
  checking: 'bg-signal-muted',
  ok: 'bg-signal-ok',
  failed: 'bg-signal-bad',
  stopping: 'bg-signal-muted',
  stopped: 'bg-signal-muted',
}

/** States where something is still in flight, so the dot breathes. */
const PULSING = new Set<DisplayState>(['checking', 'stopping'])

/** The text lives in `src/locales`; the key is checked against the catalog. */
const LABELS: Record<DisplayState, MessageKey> = {
  checking: 'connection.checking',
  ok: 'connection.ok',
  failed: 'connection.failed',
  stopping: 'connection.stopping',
  stopped: 'connection.stopped',
}

export function ConnectionStatus(): JSX.Element {
  const { t } = useLocale()
  const service = useServiceState()
  const [report, setReport] = useState<HealthReport | null>(null)
  const [state, setState] = useState<State>('checking')

  const leaving = service !== 'running'

  useEffect(() => {
    // Once the service is on its way out every probe can only fail, and a red
    // "not connected" is the wrong answer to a deliberate stop. Stop asking.
    // Coming back is possible (a stop that failed), which is why this is a
    // dependency rather than a one-shot check.
    if (leaving) return
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
  }, [leaving])

  const display: DisplayState = leaving ? service : state
  // Nothing the probe found is worth showing once the service is leaving; the
  // last report describes a server that is no longer there.
  const detail = leaving
    ? ''
    : state === 'ok'
      ? `Splunk ${report?.splunk?.version ?? ''}`.trim()
      : (report?.error?.message ?? '')

  return (
    <div className="flex items-center gap-2 text-xs" title={detail}>
      <span
        aria-hidden
        className={`h-2 w-2 rounded-full ${STYLES[display]} ${
          PULSING.has(display) ? 'animate-pulse' : ''
        }`}
      />
      <span className="text-signal-muted">{t(LABELS[display])}</span>
      {display === 'ok' && report?.latency_ms !== undefined ? (
        <span className="tnum text-signal-muted/70">{report.latency_ms.toFixed(0)}ms</span>
      ) : null}
    </div>
  )
}
