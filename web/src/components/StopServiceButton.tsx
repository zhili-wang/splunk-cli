/**
 * The footer control that shuts the dashboard down.
 *
 * Stopping the dashboard loses nothing a restart does not bring back — every
 * query is read-only — but it does end the session, and there is no undo from
 * inside this page. Hence a confirm step rather than a modal: the second click
 * lands exactly where the first one did, so it costs one motion, and an
 * impatient double click cannot skate past it.
 */

import { useEffect, useState } from 'react'

import { fetchHealth, stopService } from '../api/endpoints'
import { useLocale } from '../hooks/useLocale'
import { markRunning, markStopped, markStopping, useServiceState } from '../hooks/useServiceState'

/**
 * How long the confirm step waits before reverting.
 *
 * Long enough to read two words and decide, short enough that a button left
 * armed does not stop the service on some later, unrelated click.
 */
export const CONFIRM_TIMEOUT_MS = 5000

export function StopServiceButton(): JSX.Element | null {
  const { t } = useLocale()
  const state = useServiceState()
  const [arming, setArming] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!arming) return
    // Reverting is the whole point of arming: an armed button must not stay
    // armed. The cleanup covers the click that fires before the timer does.
    const timer = window.setTimeout(() => setArming(false), CONFIRM_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [arming])

  if (state === 'stopping') {
    return (
      <span aria-live="polite" className="text-signal-muted">
        {t('app.service.stopping')}
      </span>
    )
  }

  if (state === 'stopped') {
    return (
      <span aria-live="polite" className="flex items-baseline gap-2 text-signal-muted">
        <span>{t('app.service.stopped')}</span>
        <span className="opacity-70">{t('app.service.stoppedHint')}</span>
      </span>
    )
  }

  const stop = (): void => {
    setArming(false)
    setFailed(false)
    markStopping()

    void stopService().then(
      () => markStopped(),
      () => {
        // A POST that failed and a POST that succeeded but lost its connection on
        // the way back look identical from here — and on loopback, where the
        // server destroys the socket moments after replying, the second one is
        // the common case. So ask the service which it was rather than guess:
        // reporting success for a live server is bad, but reporting failure for
        // a dead one sends the user clicking a button that does nothing.
        void fetchHealth().then(
          () => {
            markRunning()
            setFailed(true)
          },
          () => markStopped(),
        )
      },
    )
  }

  return (
    <>
      {failed ? (
        <span aria-live="polite" className="text-signal-bad">
          {t('app.service.failed')}
        </span>
      ) : null}
      <button
        type="button"
        onClick={arming ? stop : () => setArming(true)}
        title={
          arming
            // The number comes from the constant, not the catalog, so the hint
            // cannot promise a window the timer does not honor.
            ? t('app.service.confirmHint', { seconds: CONFIRM_TIMEOUT_MS / 1000 })
            : t('app.service.stopHint')
        }
        className={`rounded border px-2 py-0.5 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-signal-bad ${
          arming
            ? 'border-signal-bad bg-signal-bad/10 text-signal-bad hover:bg-signal-bad/20'
            : 'border-ink-700 hover:border-signal-bad hover:text-signal-bad'
        }`}
      >
        {arming ? t('app.service.confirm') : t('app.service.stop')}
      </button>
    </>
  )
}
