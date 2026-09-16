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

import { formatCount, formatInstant, formatSeconds, UNKNOWN } from '../lib/format'
import type { JobInfo, TimeRange } from '../types/api'

interface Props {
  job: JobInfo
  /** Splunk's own total, when the payload carried one. */
  totalAvailable?: number | undefined
  /** The window as requested, expressions and all. */
  requested?: TimeRange | undefined
}

/** The state Splunk reports, said in one word. */
function state(job: JobInfo): { label: string; icon: string; className: string } {
  if (job.is_failed) return { label: '失败', icon: '✕', className: 'text-signal-bad' }
  if (job.is_done) return { label: '完成', icon: '✓', className: 'text-signal-ok' }
  const percent = Math.round(job.done_progress * 100)
  return {
    label: percent > 0 ? `进行中 ${percent}%` : '进行中',
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
  const current = state(job)
  const events = totalAvailable ?? job.result_count
  const hasWindow = job.search_earliest_time !== undefined && job.search_latest_time !== undefined
  const sampled = job.sample_ratio !== undefined && job.sample_ratio !== '' && job.sample_ratio !== '1'

  return (
    <section className="panel px-4 py-2.5" aria-label="任务状态">
      <div
        data-testid="job-status-summary"
        className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs"
      >
        <span className={`flex items-center gap-1 ${current.className}`}>
          <span aria-hidden="true">{current.icon}</span>
          {current.label}
        </span>

        <span className="tnum">{formatCount(events)} 个事件</span>

        {hasWindow ? (
          <span className="tnum text-signal-muted">
            （{formatInstant(job.search_earliest_time)} 至 {formatInstant(job.search_latest_time)}）
          </span>
        ) : (
          // Honest about the gap: without a resolved window we cannot claim which
          // instants the expression meant, so we say nothing rather than echo it.
          <span className="text-signal-muted">实际时间窗未知</span>
        )}

        {job.run_duration !== null ? (
          <span className="tnum text-signal-muted">耗时 {formatSeconds(job.run_duration)}</span>
        ) : null}

        {job.scan_count > 0 ? (
          <span className="tnum text-signal-muted">扫描 {formatCount(job.scan_count)} 条</span>
        ) : null}

        {sampled ? (
          // Sampling makes every count an estimate. It has to be visible, or the
          // numbers below would read as exact.
          <span className="text-signal-warn">采样 1:{job.sample_ratio}（结果为近似值）</span>
        ) : null}
      </div>

      <details className="mt-2 text-xs">
        <summary className="w-fit cursor-pointer select-none text-signal-muted transition-colors hover:text-[color:var(--text-primary)]">
          任务详情
        </summary>
        <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
          <Detail label="搜索 ID" value={job.sid === '' ? UNKNOWN : job.sid} />
          <Detail label="调度状态" value={job.dispatch_state} />
          <Detail
            label="请求时间窗"
            value={
              requested === undefined ? UNKNOWN : `${requested.earliest} → ${requested.latest}`
            }
          />
          <Detail
            label="实际时间窗"
            value={
              hasWindow
                ? `${formatInstant(job.search_earliest_time)} → ${formatInstant(job.search_latest_time)}`
                : UNKNOWN
            }
          />
          <Detail label="结果条数" value={formatCount(job.result_count)} />
          <Detail label="事件数" value={formatCount(job.event_count)} />
          <Detail label="扫描条数" value={formatCount(job.scan_count)} />
          <Detail label="运行时长" value={formatSeconds(job.run_duration)} />
          <Detail
            label="事件采样"
            value={sampled ? `1:${job.sample_ratio}` : '无采样'}
          />
        </dl>
      </details>
    </section>
  )
}
