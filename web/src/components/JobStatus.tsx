/**
 * What Splunk reports after a search, in the same place Splunk puts it.
 *
 * The quoted line in Splunk's UI is "✓ 1,125 个事件 (26/09/16 0:00:00.000 至
 * 26/09/16 13:48:03.000)", and the parenthetical is the part worth copying: the
 * request carried an *expression* (`@mon`, `now`), and only Splunk knows which
 * two instants it meant. Reading the resolved window is how an operator notices
 * that "上月" was not the month they thought, or that `now` was five minutes ago.
 *
 * Everything here is read-only: it is metadata about a job the search already
 * had to fetch. Nothing on this panel starts, stops, edits or deletes a job — the
 * CLI is read-only, and job control is not a read.
 */

import { useLocale } from '../hooks/useLocale'
import { counted, formatCount, formatInstant, formatSeconds, UNKNOWN } from '../lib/format'
import type { MessageKey, MessageParams } from '../lib/i18n'
import type { JobInfo, TimeRange } from '../types/api'

interface Props {
  job: JobInfo
  /** Splunk's own total, when the payload carried one. */
  totalAvailable?: number | undefined
  /** The window as requested, expressions and all. */
  requested?: TimeRange | undefined
}

/** The state Splunk reports, said in one word. */
function state(job: JobInfo): {
  labelKey: MessageKey
  labelParams?: MessageParams
  icon: string
  className: string
} {
  if (job.is_failed) {
    return { labelKey: 'job.state.failed', icon: '✕', className: 'text-signal-bad' }
  }
  if (job.is_done) {
    return { labelKey: 'job.state.done', icon: '✓', className: 'text-signal-ok' }
  }
  const percent = Math.round(job.done_progress * 100)
  return {
    labelKey: percent > 0 ? 'job.state.runningPercent' : 'job.state.running',
    labelParams: { percent },
    icon: '●',
    className: 'text-signal-info',
  }
}

function Detail({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="shrink-0 text-signal-muted">{label}</dt>
      <dd className="tnum break-all">{value}</dd>
    </div>
  )
}

export function JobStatus({ job, totalAvailable, requested }: Props): JSX.Element {
  const { t } = useLocale()
  const current = state(job)
  const events = totalAvailable ?? job.result_count
  const hasWindow = job.search_earliest_time !== undefined && job.search_latest_time !== undefined
  // The ratio when Splunk really sampled, `null` when every event was counted —
  // which is what both `1` and an absent value mean.
  const sampleRatio =
    job.sample_ratio === undefined || job.sample_ratio === '' || job.sample_ratio === '1'
      ? null
      : job.sample_ratio

  return (
    <section className="panel px-4 py-2.5" aria-label={t('job.label')}>
      <div
        data-testid="job-status-summary"
        className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs"
      >
        <span className={`flex items-center gap-1 ${current.className}`}>
          <span aria-hidden="true">{current.icon}</span>
          {t(current.labelKey, current.labelParams)}
        </span>

        <span className="tnum">{t('job.events', counted(events))}</span>

        {hasWindow ? (
          <span className="tnum text-signal-muted">
            {t('job.window', {
              earliest: formatInstant(job.search_earliest_time),
              latest: formatInstant(job.search_latest_time),
            })}
          </span>
        ) : (
          // Honest about the gap: without a resolved window we cannot claim which
          // instants the expression meant, so we say nothing rather than echo it.
          <span className="text-signal-muted">{t('job.windowUnknown')}</span>
        )}

        {job.run_duration !== null ? (
          <span className="tnum text-signal-muted">
            {t('job.duration', { duration: formatSeconds(job.run_duration) })}
          </span>
        ) : null}

        {job.scan_count > 0 ? (
          <span className="tnum text-signal-muted">{t('job.scanned', counted(job.scan_count))}</span>
        ) : null}

        {sampleRatio !== null ? (
          // Sampling makes every count an estimate. It has to be visible, or the
          // numbers below would read as exact.
          <span className="text-signal-warn">{t('job.sampled', { ratio: sampleRatio })}</span>
        ) : null}
      </div>

      <details className="mt-2 text-xs">
        <summary className="w-fit cursor-pointer select-none text-signal-muted transition-colors hover:text-[color:var(--text-primary)]">
          {t('job.details')}
        </summary>
        <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
          <Detail label={t('job.detail.sid')} value={job.sid === '' ? UNKNOWN : job.sid} />
          <Detail label={t('job.detail.dispatchState')} value={job.dispatch_state} />
          <Detail
            label={t('job.detail.requestedWindow')}
            value={
              requested === undefined ? UNKNOWN : `${requested.earliest} → ${requested.latest}`
            }
          />
          <Detail
            label={t('job.detail.resolvedWindow')}
            value={
              hasWindow
                ? `${formatInstant(job.search_earliest_time)} → ${formatInstant(job.search_latest_time)}`
                : UNKNOWN
            }
          />
          <Detail label={t('job.detail.resultCount')} value={formatCount(job.result_count)} />
          <Detail label={t('job.detail.eventCount')} value={formatCount(job.event_count)} />
          <Detail label={t('job.detail.scanCount')} value={formatCount(job.scan_count)} />
          <Detail label={t('job.detail.runDuration')} value={formatSeconds(job.run_duration)} />
          <Detail
            label={t('job.detail.sampling')}
            value={sampleRatio === null ? t('job.detail.noSampling') : `1:${sampleRatio}`}
          />
        </dl>
      </details>
    </section>
  )
}
