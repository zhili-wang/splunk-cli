/**
 * The time-range picker.
 *
 * Two ways to describe a window, because there are two things an operator means:
 * "the last 15 minutes" and "between 09:12 and 09:40". The old pair of bare text
 * boxes could express both only as raw literals — you had to know that `-1h` is
 * valid and that an absolute bound wants an ISO timestamp *with* an offset, and
 * a typo came back as a server-side safety error.
 *
 * The mode is not stored: it is read back off the range itself, so a window
 * brushed on the timeline opens the editor already showing the right thing.
 */

import { Fragment, useState } from 'react'

import { useLocale } from '../hooks/useLocale'
import type { MessageKey } from '../lib/i18n'
import {
  TIME_PRESET_GROUPS,
  formatDuration,
  fromDatetimeLocal,
  parseRelative,
  presetToRange,
  rangeWidthSeconds,
  resolveToIso,
  toDatetimeLocal,
  toRelativeLiteral,
  type PresetId,
  type ResolvedRange,
  type TimeUnit,
} from '../lib/timeRange'

interface Props {
  preset: PresetId
  custom: ResolvedRange
  onPreset: (preset: PresetId) => void
  onCustom: (range: ResolvedRange) => void
}

type CustomMode = 'relative' | 'absolute'

/** The text lives in `src/locales`; the key is checked against the catalog. */
const UNITS: ReadonlyArray<{ id: TimeUnit; labelKey: MessageKey }> = [
  // Seconds are not decoration: swapping back from an absolute window can land
  // on a width with no larger exact unit (30m 2.7s -> `-1802s`), and a unit the
  // select does not offer would display as the wrong one.
  { id: 's', labelKey: 'timeRange.units.s' },
  { id: 'm', labelKey: 'timeRange.units.m' },
  { id: 'h', labelKey: 'timeRange.units.h' },
  { id: 'd', labelKey: 'timeRange.units.d' },
]

const FIELD_CLASS =
  'tnum rounded border border-ink-700 bg-ink-950 px-2 py-1 text-xs outline-none transition-colors focus:border-accent'

function presetClass(active: boolean): string {
  return [
    'rounded px-2.5 py-1 text-xs transition-colors',
    active
      ? 'bg-accent text-white'
      : 'text-signal-muted hover:bg-ink-800 hover:text-[color:var(--text-primary)]',
  ].join(' ')
}

export function TimeRangeSelector({ preset, custom, onPreset, onCustom }: Props): JSX.Element {
  const { t } = useLocale()
  // Only the amount box needs a draft: it has to be clearable while typing, and
  // an empty amount is not a window anyone can search.
  const [draft, setDraft] = useState<string | null>(null)

  const relative = parseRelative(custom.earliest)
  const endsNow = custom.latest.trim().toLowerCase() === 'now'
  const mode: CustomMode = relative !== null && endsNow ? 'relative' : 'absolute'
  // The window that will actually be searched — not the editor's stored range,
  // which is only meaningful once "自定义" is the active choice.
  const active = presetToRange(preset, custom)
  const width = rangeWidthSeconds(active.earliest, active.latest)

  const amountText = draft ?? (relative === null ? '' : String(relative.amount))
  const unit: TimeUnit = relative?.unit ?? 'h'

  const commitRelative = (amount: string, nextUnit: TimeUnit): void => {
    const parsed = Number(amount)
    if (!Number.isInteger(parsed) || parsed <= 0) return
    onCustom({ earliest: `-${parsed}${nextUnit}`, latest: 'now' })
  }

  /** Swap to the relative editor, keeping the width when it can be known. */
  const toRelative = (): void => {
    setDraft(null)
    const kept = width === null ? null : toRelativeLiteral(width)
    onCustom({ earliest: kept ?? '-1h', latest: 'now' })
  }

  /** Swap to the absolute editor, freezing "now" into a real instant. */
  const toAbsolute = (): void => {
    setDraft(null)
    const earliest = resolveToIso(custom.earliest)
    const latest = resolveToIso(custom.latest)
    if (earliest === null || latest === null) return
    onCustom({ earliest, latest })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label={t('timeRange.label')}
          className="flex flex-wrap items-center gap-x-1 gap-y-1 rounded-md border border-ink-700 bg-ink-900 p-1"
        >
          {TIME_PRESET_GROUPS.map((group, index) => (
            <Fragment key={group.titleKey}>
              {index > 0 ? (
                <span aria-hidden="true" className="mx-1 h-4 w-px bg-ink-700" />
              ) : null}
              <span className="px-1 text-[0.7rem] text-signal-muted">{t(group.titleKey)}</span>
              {group.presets.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={preset === item.id}
                  onClick={() => onPreset(item.id)}
                  className={presetClass(preset === item.id)}
                >
                  {t(item.labelKey)}
                </button>
              ))}
            </Fragment>
          ))}

          <span aria-hidden="true" className="mx-1 h-4 w-px bg-ink-700" />
          <button
            type="button"
            aria-pressed={preset === 'custom'}
            onClick={() => onPreset('custom')}
            className={presetClass(preset === 'custom')}
          >
            {t('timeRange.custom')}
          </button>
        </div>

        {width !== null ? (
          <span className="tnum text-xs text-signal-muted">
            {t('timeRange.window', { width: formatDuration(width) })}
          </span>
        ) : (
          // Honest about the one case the browser cannot measure: a literal only
          // Splunk can evaluate, such as a snap-to-day expression.
          <span className="text-xs text-signal-warn">{t('timeRange.windowUnknown')}</span>
        )}
      </div>

      {preset === 'custom' ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5">
          <div
            role="group"
            aria-label={t('timeRange.mode.label')}
            className="flex items-center gap-0.5 rounded border border-ink-700 p-0.5"
          >
            <button
              type="button"
              aria-pressed={mode === 'relative'}
              onClick={toRelative}
              className={[
                'rounded px-2 py-0.5 text-xs transition-colors',
                mode === 'relative'
                  ? 'bg-accent text-white'
                  : 'text-signal-muted hover:text-[color:var(--text-primary)]',
              ].join(' ')}
            >
              {t('timeRange.mode.relative')}
            </button>
            <button
              type="button"
              aria-pressed={mode === 'absolute'}
              onClick={toAbsolute}
              className={[
                'rounded px-2 py-0.5 text-xs transition-colors',
                mode === 'absolute'
                  ? 'bg-accent text-white'
                  : 'text-signal-muted hover:text-[color:var(--text-primary)]',
              ].join(' ')}
            >
              {t('timeRange.mode.absolute')}
            </button>
          </div>

          {mode === 'relative' ? (
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-signal-muted">{t('timeRange.relative.last')}</span>
              <input
                type="number"
                min={1}
                aria-label={t('timeRange.relative.amount')}
                value={amountText}
                // Committed on blur or Enter rather than on every keystroke:
                // typing "30" would otherwise fire a search for "-3m" first.
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => {
                  commitRelative(amountText, unit)
                  setDraft(null)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  commitRelative(amountText, unit)
                  setDraft(null)
                }}
                className={`${FIELD_CLASS} w-16`}
              />
              <select
                aria-label={t('timeRange.relative.unit')}
                value={unit}
                onChange={(event) => {
                  setDraft(null)
                  commitRelative(
                    amountText === '' ? '1' : amountText,
                    event.target.value as TimeUnit,
                  )
                }}
                className={FIELD_CLASS}
              >
                {UNITS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {t(item.labelKey)}
                  </option>
                ))}
              </select>
              <span className="text-signal-muted">{t('timeRange.relative.before')}</span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <input
                type="datetime-local"
                step={1}
                aria-label={t('timeRange.absolute.start')}
                value={toDatetimeLocal(custom.earliest)}
                onChange={(event) => {
                  const iso = fromDatetimeLocal(event.target.value)
                  if (iso !== null) onCustom({ ...custom, earliest: iso })
                }}
                className={FIELD_CLASS}
              />
              <span className="text-signal-muted">{t('timeRange.absolute.to')}</span>
              <input
                type="datetime-local"
                step={1}
                aria-label={t('timeRange.absolute.end')}
                value={toDatetimeLocal(custom.latest)}
                onChange={(event) => {
                  const iso = fromDatetimeLocal(event.target.value)
                  if (iso !== null) onCustom({ ...custom, latest: iso })
                }}
                className={FIELD_CLASS}
              />
              <button
                type="button"
                aria-label={t('timeRange.absolute.setNow')}
                onClick={() => onCustom({ ...custom, latest: new Date().toISOString() })}
                className="rounded border border-ink-700 px-2 py-1 text-xs text-signal-muted transition-colors hover:border-ink-600 hover:text-[color:var(--text-primary)]"
              >
                {t('timeRange.absolute.now')}
              </button>
              <span className="text-signal-muted">{t('timeRange.absolute.zone')}</span>
            </div>
          )}

          {/* The literal that will be sent, spelled out: the inputs above are
              friendly but not the contract. Kept in the flow rather than pushed
              to the far edge, which would strand it across the row. */}
          <span className="tnum ml-1 border-l border-ink-700 pl-2 text-[0.7rem] text-signal-muted">
            {custom.earliest} → {custom.latest}
          </span>
        </div>
      ) : null}
    </div>
  )
}
