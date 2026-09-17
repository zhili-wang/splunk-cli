import { useCallback, useState } from 'react'

import { fetchOverview } from '../api/endpoints'
import { BarPanel } from '../components/BarPanel'
import { ErrorNote } from '../components/ErrorNote'
import { MetricCard } from '../components/MetricCard'
import { QueryBar } from '../components/QueryBar'
import { TimeRangeSelector } from '../components/TimeRangeSelector'
import { TimelineChart } from '../components/TimelineChart'
import { useAsync } from '../hooks/useAsync'
import { useLocale } from '../hooks/useLocale'
import { counted } from '../lib/format'
import {
  DEFAULT_CUSTOM,
  editableRange,
  presetToRange,
  type PresetId,
  type ResolvedRange,
} from '../lib/timeRange'

export function Dashboard(): JSX.Element {
  const { t } = useLocale()
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
            {loading ? t('dashboard.refreshing') : t('dashboard.refresh')}
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
        <p className="text-sm text-signal-muted">{t('dashboard.empty')}</p>
      ) : null}

      {error !== null ? <ErrorNote error={error} /> : null}

      {data?.errors.timeline !== undefined ? (
        <ErrorNote error={data.errors.timeline} />
      ) : null}

      {submitted === '' ? null : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard
              label={t('dashboard.metrics.events')}
              value={data?.metrics.events ?? null}
              hint={t('dashboard.metrics.eventsHint')}
            />
            <MetricCard
              label={t('dashboard.metrics.services')}
              value={data?.metrics.services ?? null}
              hint={t('dashboard.metrics.servicesHint')}
            />
            <MetricCard
              label={t('dashboard.metrics.hosts')}
              value={data?.metrics.hosts ?? null}
              hint={t('dashboard.metrics.hostsHint')}
            />
            <MetricCard
              label={t('dashboard.metrics.buckets')}
              value={data?.metrics.buckets ?? null}
              hint={t('dashboard.metrics.bucketsHint')}
            />
          </div>

          {data !== null && data.partial && data.errors.timeline === undefined ? (
            <p className="rounded-md border border-signal-warn/40 bg-signal-warn/5 px-3 py-2 text-xs text-signal-warn">
              {t('dashboard.partial')}
            </p>
          ) : null}

          {data?.timeline != null ? (
            <TimelineChart points={data.timeline.timeline} span={data.timeline.span} />
          ) : null}

          <div className="grid gap-3 lg:grid-cols-2">
            {data?.by_service != null ? (
              <BarPanel
                title={t('dashboard.byService')}
                rows={data.by_service.rows}
                emptyLabel={t('dashboard.byServiceEmpty')}
              />
            ) : null}
            {data?.by_host != null ? (
              <BarPanel
                title={t('dashboard.byHost')}
                rows={data.by_host.rows}
                emptyLabel={t('dashboard.byHostEmpty')}
              />
            ) : null}
          </div>

          {data?.errors.by_service !== undefined ? (
            <ErrorNote error={data.errors.by_service} />
          ) : null}
          {data?.errors.by_host !== undefined ? <ErrorNote error={data.errors.by_host} /> : null}

          {loading && data === null ? (
            <p className="text-sm text-signal-muted">{t('dashboard.loading')}</p>
          ) : null}

          {data !== null && data.metrics.events === 0 ? (
            <p className="text-sm text-signal-muted">
              {t('dashboard.noEvents', counted(0))}
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}
