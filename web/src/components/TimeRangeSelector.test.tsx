// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TIME_PRESETS, type PresetId } from '../lib/timeRange'
import { TimeRangeSelector } from './TimeRangeSelector'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

interface Options {
  preset?: PresetId
  range?: { earliest: string; latest: string }
}

function setup({ preset = '1h', range = { earliest: '-1h', latest: 'now' } }: Options = {}): {
  onPreset: ReturnType<typeof vi.fn>
  onCustom: ReturnType<typeof vi.fn>
} {
  const onPreset = vi.fn()
  const onCustom = vi.fn()
  render(
    <TimeRangeSelector preset={preset} custom={range} onPreset={onPreset} onCustom={onCustom} />,
  )
  return { onPreset, onCustom }
}

/** An absolute window, so the editor opens in absolute mode. */
const ABSOLUTE = {
  earliest: '2024-01-02T03:00:00.000Z',
  latest: '2024-01-02T04:00:00.000Z',
}

describe('TimeRangeSelector presets', () => {
  it('offers every preset plus the custom editor', () => {
    setup()

    const group = screen.getByRole('group', { name: '时间范围' })
    expect(group.querySelectorAll('button')).toHaveLength(TIME_PRESETS.length + 1)
    expect(screen.getByRole('button', { name: '7 天' })).toBeDefined()
    expect(screen.getByRole('button', { name: '上月' })).toBeDefined()
    expect(screen.getByRole('button', { name: '自定义' })).toBeDefined()
  })

  it('labels the two preset groups', () => {
    setup()

    const group = screen.getByRole('group', { name: '时间范围' })
    expect(group.textContent).toContain('最近')
    expect(group.textContent).toContain('日历')
  })

  it('marks exactly the active preset as pressed', () => {
    setup({ preset: '5m' })

    expect(screen.getByRole('button', { name: '5 分钟' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '1 小时' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('reports the chosen preset to the caller', () => {
    const { onPreset } = setup({ preset: '1h' })

    fireEvent.click(screen.getByRole('button', { name: '24 小时' }))

    expect(onPreset).toHaveBeenCalledWith('24h')
  })

  it('hides the editor until the custom preset is chosen', () => {
    setup({ preset: '1h' })

    expect(screen.queryByRole('group', { name: '自定义时间模式' })).toBeNull()
    expect(screen.queryByLabelText('起始时间')).toBeNull()
  })
})

describe('TimeRangeSelector window width', () => {
  it('summarizes how wide the window is', () => {
    setup({ preset: 'custom', range: { earliest: '-2h', latest: '-30m' } })

    // Worth stating: the width is the thing a typo gets wrong.
    expect(screen.getByText('窗口 1.5 小时')).toBeDefined()
  })

  it('says so when only Splunk can measure it', () => {
    // A snap-to-day expression has no locally computable width.
    setup({ preset: 'custom', range: { earliest: '-1d@d', latest: 'now' } })

    expect(screen.getByText('窗口宽度由 Splunk 端求值')).toBeDefined()
  })

  it('describes the active preset, not the editor it is not using', () => {
    // The editor keeps its own range while a preset is active; showing that
    // range would claim a width the query does not have.
    setup({ preset: '1h', range: { earliest: '-2h', latest: 'now' } })

    expect(screen.getByText('窗口 1 小时')).toBeDefined()
    expect(screen.queryByText('窗口 2 小时')).toBeNull()
  })

  it('defers to Splunk for a calendar preset', () => {
    setup({ preset: 'last-month', range: { earliest: '-1h', latest: 'now' } })

    expect(screen.getByText('窗口宽度由 Splunk 端求值')).toBeDefined()
  })
})

describe('TimeRangeSelector relative mode', () => {
  it('opens in relative mode for a "last N units" window', () => {
    setup({ preset: 'custom', range: { earliest: '-15m', latest: 'now' } })

    expect(screen.getByRole('button', { name: '相对' }).getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByLabelText('相对时间数值') as HTMLInputElement).value).toBe('15')
    expect((screen.getByLabelText('相对时间单位') as HTMLSelectElement).value).toBe('m')
    // No raw ISO literal to hand-edit.
    expect(screen.queryByLabelText('起始时间')).toBeNull()
  })

  it('reports an edited amount once the field is left', () => {
    const { onCustom } = setup({ preset: 'custom', range: { earliest: '-15m', latest: 'now' } })

    const input = screen.getByLabelText('相对时间数值')
    fireEvent.change(input, { target: { value: '30' } })
    // Typing alone must not fire a search per digit.
    expect(onCustom).not.toHaveBeenCalled()

    fireEvent.blur(input)

    expect(onCustom).toHaveBeenCalledWith({ earliest: '-30m', latest: 'now' })
  })

  it('commits on Enter as well as on blur', () => {
    const { onCustom } = setup({ preset: 'custom', range: { earliest: '-15m', latest: 'now' } })

    const input = screen.getByLabelText('相对时间数值')
    fireEvent.change(input, { target: { value: '5' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onCustom).toHaveBeenCalledWith({ earliest: '-5m', latest: 'now' })
  })

  it('keeps the amount when the unit changes', () => {
    const { onCustom } = setup({ preset: 'custom', range: { earliest: '-15m', latest: 'now' } })

    fireEvent.change(screen.getByLabelText('相对时间单位'), { target: { value: 'h' } })

    expect(onCustom).toHaveBeenCalledWith({ earliest: '-15h', latest: 'now' })
  })

  it('does not emit a window for an empty amount', () => {
    const { onCustom } = setup({ preset: 'custom', range: { earliest: '-15m', latest: 'now' } })

    const input = screen.getByLabelText('相对时间数值')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    // Nothing to search; the window already in force stays in force.
    expect(onCustom).not.toHaveBeenCalled()
  })

  it('snaps back to the committed amount on blur', () => {
    setup({ preset: 'custom', range: { earliest: '-15m', latest: 'now' } })

    const input = screen.getByLabelText('相对时间数值')
    fireEvent.change(input, { target: { value: '7' } })
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    // The box never keeps a number that is not in force.
    expect((screen.getByLabelText('相对时间数值') as HTMLInputElement).value).toBe('15')
  })
})

describe('TimeRangeSelector absolute mode', () => {
  it('opens in absolute mode for a fixed window', () => {
    setup({ preset: 'custom', range: ABSOLUTE })

    expect(screen.getByRole('button', { name: '绝对' }).getAttribute('aria-pressed')).toBe('true')
    // A real picker, not a text box that wants an ISO string typed into it.
    expect((screen.getByLabelText('起始时间') as HTMLInputElement).type).toBe('datetime-local')
    expect((screen.getByLabelText('结束时间') as HTMLInputElement).type).toBe('datetime-local')
  })

  it('reports an edited bound as an instant, without dropping the other', () => {
    const { onCustom } = setup({ preset: 'custom', range: ABSOLUTE })

    const picked = '2024-01-02T05:30'
    fireEvent.change(screen.getByLabelText('起始时间'), { target: { value: picked } })

    expect(onCustom).toHaveBeenCalledWith({
      earliest: new Date(picked).toISOString(),
      latest: ABSOLUTE.latest,
    })
  })

  it('sets the end to now on request', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-02T06:00:00.000Z'))
    const { onCustom } = setup({ preset: 'custom', range: ABSOLUTE })

    fireEvent.click(screen.getByRole('button', { name: '将结束时间设为此刻' }))

    expect(onCustom).toHaveBeenCalledWith({
      earliest: ABSOLUTE.earliest,
      latest: '2024-01-02T06:00:00.000Z',
    })
  })
})

describe('TimeRangeSelector mode switching', () => {
  it('freezes "now" into an instant when switching to absolute', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-02T06:00:00.000Z'))
    const { onCustom } = setup({ preset: 'custom', range: { earliest: '-1h', latest: 'now' } })

    fireEvent.click(screen.getByRole('button', { name: '绝对' }))

    expect(onCustom).toHaveBeenCalledWith({
      earliest: '2024-01-02T05:00:00.000Z',
      latest: '2024-01-02T06:00:00.000Z',
    })
  })

  it('keeps the window width when switching back to relative', () => {
    const { onCustom } = setup({ preset: 'custom', range: ABSOLUTE })

    fireEvent.click(screen.getByRole('button', { name: '相对' }))

    // One hour stays one hour, expressed the way the relative editor reads it.
    expect(onCustom).toHaveBeenCalledWith({ earliest: '-1h', latest: 'now' })
  })

  it('falls back to whole seconds when the width is not a whole larger unit', () => {
    const { onCustom } = setup({
      preset: 'custom',
      range: { earliest: '2024-01-02T03:00:00.000Z', latest: '2024-01-02T03:45:30.000Z' },
    })

    fireEvent.click(screen.getByRole('button', { name: '相对' }))

    // 45m30s is not a literal this API accepts — it takes one unit — so the
    // window is expressed in seconds rather than silently rounded.
    expect(onCustom).toHaveBeenCalledWith({ earliest: '-2730s', latest: 'now' })
  })
})
