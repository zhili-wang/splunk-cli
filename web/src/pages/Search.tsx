import { useCallback, useMemo, useRef, useState } from 'react'

import { fetchSearch, fetchTimeline } from '../api/endpoints'
import { ErrorNote } from '../components/ErrorNote'
import { EventTimeline } from '../components/EventTimeline'
import { JobStatus } from '../components/JobStatus'
import { LogTable } from '../components/LogTable'
import { QueryBar } from '../components/QueryBar'
import { TimeRangeSelector } from '../components/TimeRangeSelector'
import { useAsync } from '../hooks/useAsync'
import { useFieldSelection } from '../hooks/useFieldSelection'
import { csvFileName, downloadCsv, toCsv } from '../lib/csv'
import { orderedFields } from '../lib/fields'
import { isFieldVisible } from '../lib/fieldSelection'
import { formatCount } from '../lib/format'
import {
  DEFAULT_CUSTOM,
  editableRange,
  pickSpan,
  presetToRange,
  type PresetId,
  type ResolvedRange,
} from '../lib/timeRange'

export function Search(): JSX.Element {
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [preset, setPreset] = useState<PresetId>('1h')
  const [custom, setCustom] = useState<ResolvedRange>(DEFAULT_CUSTOM)
  // Where "clear selection" returns to: the last preset the operator picked
  // themselves, not the one the timeline replaced.
  const lastPreset = useRef<PresetId>('1h')

  const range = presetToRange(preset, custom)
  // A span fine enough to be useful but coarse enough that the backend does not
  // truncate the buckets and silently cover only part of the window.
  const span = pickSpan(range.earliest, range.latest)

  const load = useCallback(
    () =>
      submitted === ''
        ? Promise.resolve(null)
        : fetchSearch({ query: submitted, ...range }),
    [submitted, range.earliest, range.latest],
  )
  const { data, error, loading } = useAsync(load, [submitted, range.earliest, range.latest])

  const loadTimeline = useCallback(
    () =>
      submitted === ''
        ? Promise.resolve(null)
        : fetchTimeline({ query: submitted, span, ...range }),
    [submitted, span, range.earliest, range.latest],
  )
  const timeline = useAsync(loadTimeline, [submitted, span, range.earliest, range.latest])

  const { overrides } = useFieldSelection()
  const rows = data?.results ?? []
  // The same columns the table is showing: the operator picked them, and a file
  // that silently reorders or adds columns is a different document.
  const exportColumns = useMemo(
    () =>
      orderedFields(rows, { includeInternal: true }).filter((name) =>
        isFieldVisible(overrides, name),
      ),
    [rows, overrides],
  )

  const choosePreset = (next: PresetId): void => {
    if (next !== 'custom') lastPreset.current = next
    // Opening the editor should start from the window you were just looking at,
    // not from a stale default nobody chose — as long as the editor can show it.
    if (next === 'custom') setCustom(editableRange(range))
    setPreset(next)
  }

  return (
    <div className="flex flex-col gap-4">
      <TimeRangeSelector
        preset={preset}
        custom={custom}
        onPreset={choosePreset}
        onCustom={setCustom}
      />
      <QueryBar query={query} onQuery={setQuery} onSubmit={setSubmitted} loading={loading} />

      {error !== null ? <ErrorNote error={error} /> : null}

      {submitted === '' ? (
        <p className="text-sm text-signal-muted">执行查询以查看原始事件。</p>
      ) : null}

      {data !== null && data.success && data.job !== undefined ? (
        <JobStatus job={data.job} totalAvailable={data.total_available} requested={data.time_range} />
      ) : null}

      {timeline.error !== null ? <ErrorNote error={timeline.error} /> : null}

      {timeline.data !== null && timeline.data.success ? (
        <EventTimeline
          points={timeline.data.timeline}
          span={timeline.data.span}
          brushed={preset === 'custom'}
          onSelect={(next) => {
            // Selecting on the timeline *is* choosing a custom window, so the
            // preset selector and the brush stay one piece of state.
            setPreset('custom')
            setCustom(next)
          }}
          onClear={() => {
            setCustom(DEFAULT_CUSTOM)
            setPreset(lastPreset.current)
          }}
        />
      ) : null}

      {data !== null && data.success ? (
        <section className="panel">
          <header className="panel-header">
            <h2 className="panel-title">事件</h2>
            <div className="flex items-baseline gap-3">
              <span className="tnum text-xs text-signal-muted">
                {formatCount(data.count)} 行
                {data.truncated ? ' · 已截断，请缩小范围' : ''}
              </span>
              <button
                type="button"
                disabled={rows.length === 0}
                // Not Splunk's export endpoint — that one is forbidden. This
                // writes the rows already on screen, and the title says so.
                title="下载当前页的可见列（不向 Splunk 发起导出请求）"
                onClick={() => downloadCsv(csvFileName(), toCsv(rows, exportColumns))}
                className="rounded-md border border-ink-700 px-2 py-0.5 text-[0.7rem] text-signal-muted transition-colors hover:border-ink-600 hover:text-[color:var(--text-primary)] disabled:opacity-40"
              >
                导出 CSV
              </button>
            </div>
          </header>
          <LogTable rows={rows} query={submitted} />
        </section>
      ) : null}
    </div>
  )
}
