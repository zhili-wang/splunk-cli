// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { fetchOverview } from '../api/endpoints'
import { ApiError } from '../api/client'
import type { OverviewResponse, StatsResult, TimelineResult } from '../types/api'
import { Dashboard } from './Dashboard'

const echartsMock = vi.hoisted(() => {
  const chart = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() }
  return { chart, init: vi.fn(() => chart) }
})

// ECharts needs a canvas and a layout engine; the timeline panel is covered by
// its own test. The dashboard test only cares that the panel is wired in.
vi.mock('../lib/echarts', () => ({ echarts: { init: echartsMock.init } }))
vi.mock('../api/endpoints', () => ({ fetchOverview: vi.fn() }))

const fetchOverviewMock = vi.mocked(fetchOverview)

beforeEach(() => {
  // `resetAllMocks` in afterEach clears the module mock's implementation too.
  echartsMock.init.mockReturnValue(echartsMock.chart)
  localStorage.clear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

const TIMELINE: TimelineResult = {
  success: true,
  query: 'index=app level=ERROR',
  spl: 'index=app level=ERROR | timechart span=5m count',
  span: '5m',
  count: 3,
  total: 23521,
  timeline: [
    { time: '2024-01-02T03:04:05', count: 3 },
    { time: '2024-01-02T03:09:05', count: 7 },
    { time: '2024-01-02T03:14:05', count: 1 },
  ],
}

function stats(rows: StatsResult['rows']): StatsResult {
  return {
    success: true,
    query: 'index=app level=ERROR',
    spl: 'index=app level=ERROR | stats count by service',
    function: 'count',
    by: ['service'],
    count: rows.length,
    rows,
    truncated: false,
  }
}

function overview(overrides: Partial<OverviewResponse> = {}): OverviewResponse {
  return {
    success: true,
    partial: false,
    query: 'index=app level=ERROR',
    time_range: { earliest: '-1h', latest: 'now' },
    metrics: { events: 23521, hosts: 12, services: 4, buckets: 48 },
    timeline: TIMELINE,
    by_service: stats([{ key: 'payment', count: 120 }]),
    by_host: stats([{ key: 'api-01', count: 80 }]),
    errors: {},
    ...overrides,
  }
}

const SUBMITTED = 'index=app level=ERROR'

/** The overview only runs once a query is submitted; the box starts empty. */
async function submit(query: string = SUBMITTED): Promise<void> {
  fireEvent.change(screen.getByLabelText('查询语句（SPL）'), { target: { value: query } })
  await waitFor(() => {
    expect((screen.getByRole('button', { name: '查询' }) as HTMLButtonElement).disabled).toBe(false)
  })
  fireEvent.click(screen.getByRole('button', { name: '查询' }))
}

describe('Dashboard', () => {
  it('starts with an empty query box and asks Splunk nothing', () => {
    render(<Dashboard />)

    expect((screen.getByLabelText('查询语句（SPL）') as HTMLInputElement).value).toBe('')
    expect(fetchOverviewMock).not.toHaveBeenCalled()
    expect(screen.getByText(/输入查询条件后开始/)).toBeDefined()
    // No metric cards built out of nothing.
    expect(screen.queryByText('事件')).toBeNull()
  })

  it('says what it is waiting for before the first overview arrives', async () => {
    fetchOverviewMock.mockReturnValue(new Promise(() => {}))

    render(<Dashboard />)
    await submit()

    expect(screen.getByText('正在向 Splunk 查询时间线与两个维度拆解…')).toBeDefined()
    // Unknown metrics are rendered as em dashes, never as fabricated zeros.
    expect(screen.getAllByText('—')).toHaveLength(4)
    expect(screen.getAllByText('不可用')).toHaveLength(4)
    expect(screen.getByRole('button', { name: '加载中…' })).toBeDefined()
  })

  it('renders metrics, timeline and both ranked panels from a full response', async () => {
    fetchOverviewMock.mockResolvedValue(overview())

    render(<Dashboard />)
    await submit()

    await screen.findByText('23,521')
    expect(screen.getByText('事件')).toBeDefined()
    expect(screen.getByText('4')).toBeDefined()
    expect(screen.getByText('12')).toBeDefined()
    expect(screen.getByText('48')).toBeDefined()

    expect(screen.getByText('事件时间线')).toBeDefined()
    expect(screen.getByText('跨度 5m · 3 个时间桶')).toBeDefined()

    expect(screen.getByText('服务排行')).toBeDefined()
    expect(screen.getByText('payment')).toBeDefined()
    expect(screen.getByText('120')).toBeDefined()
    expect(screen.getByText('主机排行')).toBeDefined()
    expect(screen.getByText('api-01')).toBeDefined()

    // Complete answer: no partial-view banner and no error notes.
    expect(screen.queryByText(/部分视图不可用/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('warns that only part of the overview is available', async () => {
    fetchOverviewMock.mockResolvedValue(overview({ partial: true }))

    render(<Dashboard />)
    await submit()

    await screen.findByText(/部分视图不可用/)
    expect(screen.getByText('事件时间线')).toBeDefined()
  })

  it('shows the timeline failure itself when the timeline is what went missing', async () => {
    // The banner exists to explain a *quiet* gap. When the timeline panel has
    // its own error note, repeating it as a banner would be noise.
    fetchOverviewMock.mockResolvedValue(
      overview({
        partial: true,
        timeline: null,
        errors: { timeline: { type: 'SplunkQueryError', message: 'timechart failed' } },
      }),
    )

    render(<Dashboard />)
    await submit()

    await screen.findByText('timechart failed')
    expect(screen.getByText('SplunkQueryError')).toBeDefined()
    expect(screen.queryByText(/部分视图不可用/)).toBeNull()
    expect(screen.queryByText('事件时间线')).toBeNull()
  })

  it('keeps an unknown metric distinct from a real zero', async () => {
    fetchOverviewMock.mockResolvedValue(
      overview({
        metrics: { events: 0, hosts: null, services: 0, buckets: null },
      }),
    )

    render(<Dashboard />)
    await submit()

    await screen.findByText(/该时间范围内有 0 个事件/)

    // hosts + buckets failed (unknown), events + services are genuinely zero.
    expect(screen.getAllByText('—')).toHaveLength(2)
    expect(screen.getAllByText('不可用')).toHaveLength(2)
    expect(screen.getAllByText('0')).toHaveLength(2)
  })

  it('does not claim there were zero events when the count is unknown', async () => {
    fetchOverviewMock.mockReturnValue(new Promise(() => {}))

    render(<Dashboard />)
    await submit()

    expect(screen.queryByText(/该时间范围内有/)).toBeNull()
  })

  it('reports a total failure of the overview request', async () => {
    fetchOverviewMock.mockRejectedValue(new ApiError('SplunkConnectionError', 'connect failed', 502))

    render(<Dashboard />)
    await submit()

    await screen.findByText('connect failed')
    expect(screen.getByText('SplunkConnectionError')).toBeDefined()
  })

  it('omits the panels the backend could not produce and names each one', async () => {
    fetchOverviewMock.mockResolvedValue(
      overview({
        partial: true,
        by_service: null,
        by_host: null,
        errors: {
          by_service: { type: 'SplunkQueryError', message: 'stats by service failed' },
          by_host: { type: 'SplunkTimeoutError', message: 'stats by host timed out' },
        },
      }),
    )

    render(<Dashboard />)
    await submit()

    await screen.findByText('stats by service failed')
    expect(screen.getByText('stats by host timed out')).toBeDefined()
    expect(screen.queryByText('服务排行')).toBeNull()
    expect(screen.queryByText('主机排行')).toBeNull()
    expect(screen.getByText('事件时间线')).toBeDefined()
  })

  it('surfaces an empty breakdown through the panel empty state', async () => {
    fetchOverviewMock.mockResolvedValue(
      overview({ by_service: stats([]), by_host: stats([]) }),
    )

    render(<Dashboard />)
    await submit()

    await screen.findByText('暂无服务维度拆解数据。')
    expect(screen.getByText('暂无主机维度拆解数据。')).toBeDefined()
  })

  it('re-queries with the submitted query', async () => {
    fetchOverviewMock.mockResolvedValue(overview())

    render(<Dashboard />)
    await submit()
    await screen.findByText('23,521')

    fireEvent.change(screen.getByLabelText('查询语句（SPL）'), {
      target: { value: 'index=web' },
    })
    fireEvent.click(screen.getByRole('button', { name: '查询' }))

    await waitFor(() => {
      expect(fetchOverviewMock).toHaveBeenCalledTimes(2)
    })
    expect(fetchOverviewMock).toHaveBeenLastCalledWith({
      query: 'index=web',
      earliest: '-1h',
      latest: 'now',
    })
  })

  it('re-queries when the preset changes', async () => {
    fetchOverviewMock.mockResolvedValue(overview())

    render(<Dashboard />)
    await submit()
    await screen.findByText('23,521')

    fireEvent.click(screen.getByRole('button', { name: '4 小时' }))

    await waitFor(() => {
      expect(fetchOverviewMock).toHaveBeenLastCalledWith({
        query: SUBMITTED,
        earliest: '-4h',
        latest: 'now',
      })
    })
  })

  it('re-queries when the custom window is edited', async () => {
    fetchOverviewMock.mockResolvedValue(overview())

    render(<Dashboard />)
    await submit()
    await screen.findByText('23,521')

    fireEvent.click(screen.getByRole('button', { name: '自定义' }))

    // The editor opens on the window that was in force, not a stale default.
    expect((screen.getByLabelText('相对时间数值') as HTMLInputElement).value).toBe('1')
    expect((screen.getByLabelText('相对时间单位') as HTMLSelectElement).value).toBe('h')

    fireEvent.change(screen.getByLabelText('相对时间单位'), { target: { value: 'm' } })
    const amount = screen.getByLabelText('相对时间数值')
    fireEvent.change(amount, { target: { value: '30' } })
    fireEvent.blur(amount)

    await waitFor(() => {
      expect(fetchOverviewMock).toHaveBeenLastCalledWith({
        query: SUBMITTED,
        earliest: '-30m',
        latest: 'now',
      })
    })
  })

  it('re-queries on refresh', async () => {
    fetchOverviewMock.mockResolvedValue(overview())

    render(<Dashboard />)
    await submit()
    await screen.findByText('23,521')

    fireEvent.click(screen.getByRole('button', { name: '刷新' }))

    await waitFor(() => {
      expect(fetchOverviewMock).toHaveBeenCalledTimes(2)
    })
  })

  it('disables refresh while a request is in flight', async () => {
    fetchOverviewMock.mockReturnValue(new Promise(() => {}))

    render(<Dashboard />)
    await submit()

    expect((screen.getByRole('button', { name: '加载中…' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('enables refresh once the overview has arrived', async () => {
    fetchOverviewMock.mockResolvedValue(overview())

    render(<Dashboard />)
    await submit()
    await screen.findByText('23,521')

    expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
