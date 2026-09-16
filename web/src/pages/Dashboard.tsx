import { useCallback, useState } from 'react'

import { fetchOverview } from '../api/endpoints'
import { BarPanel } from '../components/BarPanel'
import { ErrorNote } from '../components/ErrorNote'
import { MetricCard } from '../components/MetricCard'
import { QueryBar } from '../components/QueryBar'
import { TimeRangeSelector } from '../components/TimeRangeSelector'
import { TimelineChart } from '../components/TimelineChart'
import { useAsync } from '../hooks/useAsync'
import { formatCount } from '../lib/format'
import {
  DEFAULT_CUSTOM,
  editableRange,
  presetToRange,
  type PresetId,
  type ResolvedRange,
} from '../lib/timeRange'

export function Dashboard(): JSX.Element {
  // Empty on purpose: guessing a query for the operator means showing numbers
  // for something they never asked about. The history remembers what they run.
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [preset, setPreset] = useState<PresetId>('1h')
  const [custom, setCustom] = useState<ResolvedRange>(DEFAULT_CUSTOM)

  const range = presetToRange(preset, custom)

  const choosePreset = (next: PresetId): void => {
    // Opening the editor should start from the window you were just looking at —
    // as long as the editor is able to display it.
    if (next === 'custom') setCustom(editableRange(range))
    setPreset(next)
  }
  const load = useCallback(
    () =>
      submitted === ''
        ? Promise.resolve(null)
        : fetchOverview({ query: submitted, ...range }),
    [submitted, range.earliest, range.latest],
  )
  const { data, error, loading, reload } = useAsync(load, [submitted, range.earliest, range.latest])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TimeRangeSelector
            preset={preset}
            custom={custom}
            onPreset={choosePreset}
            onCustom={setCustom}
          />
          <button
            type="button"
            onClick={reload}
            disabled={loading || submitted === ''}
            className="rounded-md border border-ink-700 px-3 py-1.5 text-xs text-signal-muted transition-colors hover:border-ink-600 hover:text-[color:var(--text-primary)] disabled:opacity-40"
          >
            {loading ? '加载中…' : '刷新'}
          </button>
        </div>
        <QueryBar
          query={query}
          onQuery={setQuery}
          onSubmit={setSubmitted}
          loading={loading}
        />
      </div>

      {submitted === '' ? (
        <p className="text-sm text-signal-muted">
          输入查询条件后开始。运行过的查询会记在上面的「历史查询」里。
        </p>
      ) : null}

      {error !== null ? <ErrorNote error={error} /> : null}

      {data?.errors.timeline !== undefined ? (
        <ErrorNote error={data.errors.timeline} />
      ) : null}

      {submitted === '' ? null : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label="事件" value={data?.metrics.events ?? null} hint="选定范围内" />
            <MetricCard label="服务" value={data?.metrics.services ?? null} hint="去重计数" />
            <MetricCard label="主机" value={data?.metrics.hosts ?? null} hint="去重计数" />
            <MetricCard label="时间桶" value={data?.metrics.buckets ?? null} hint="时间片" />
          </div>

          {data !== null && data.partial && data.errors.timeline === undefined ? (
            <p className="rounded-md border border-signal-warn/40 bg-signal-warn/5 px-3 py-2 text-xs text-signal-warn">
              部分视图不可用 —— 下方面板只展示 Splunk 实际返回的内容。
            </p>
          ) : null}

          {data?.timeline != null ? (
            <TimelineChart points={data.timeline.timeline} span={data.timeline.span} />
          ) : null}

          <div className="grid gap-3 lg:grid-cols-2">
            {data?.by_service != null ? (
              <BarPanel
                title="服务排行"
                rows={data.by_service.rows}
                emptyLabel="暂无服务维度拆解数据。"
              />
            ) : null}
            {data?.by_host != null ? (
              <BarPanel
                title="主机排行"
                rows={data.by_host.rows}
                emptyLabel="暂无主机维度拆解数据。"
              />
            ) : null}
          </div>

          {data?.errors.by_service !== undefined ? (
            <ErrorNote error={data.errors.by_service} />
          ) : null}
          {data?.errors.by_host !== undefined ? <ErrorNote error={data.errors.by_host} /> : null}

          {loading && data === null ? (
            <p className="text-sm text-signal-muted">
              正在向 Splunk 查询时间线与两个维度拆解…
            </p>
          ) : null}

          {data !== null && data.metrics.events === 0 ? (
            <p className="text-sm text-signal-muted">
              该时间范围内有 {formatCount(0)} 个事件。请扩大时间范围或更换查询条件。
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}
