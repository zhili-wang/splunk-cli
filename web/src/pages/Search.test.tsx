// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { fetchSearch, fetchTimeline } from '../api/endpoints'
import { ApiError } from '../api/client'
import { endOfSpan } from '../lib/timeRange'
import type { SearchResult, TimelineResult } from '../types/api'
import { Search } from './Search'

vi.mock('../api/endpoints', () => ({ fetchSearch: vi.fn(), fetchTimeline: vi.fn() }))

const fetchSearchMock = vi.mocked(fetchSearch)
const fetchTimelineMock = vi.mocked(fetchTimeline)

const BUCKETS: TimelineResult = {
  success: true,
  query: 'index=app',
  spl: 'index=app | timechart span=5m count | head 500',
  span: '5m',
  count: 2,
  total: 30,
  timeline: [
    { time: '2024-01-02T03:00:00.000+08:00', count: 10 },
    { time: '2024-01-02T03:05:00.000+08:00', count: 20 },
  ],
}

beforeEach(() => {
  // Every search also loads a timeline; without a default the mocked call would
  // resolve `undefined` and the hook would throw.
  fetchTimelineMock.mockResolvedValue(BUCKETS)
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    success: true,
    query: 'index=app',
    count: 1,
    truncated: false,
    results: [{ _time: '2024-01-02T03:04:05', host: 'api-01', message: 'boom' }],
    ...overrides,
  }
}

async function submit(query: string): Promise<void> {
  fireEvent.change(screen.getByLabelText('查询语句（SPL）'), { target: { value: query } })
  // useAsync starts in `loading` and the no-op initial load resolves a tick
  // later, so the submit button is briefly disabled before the first query.
  await waitFor(() => {
    expect((screen.getByRole('button', { name: '查询' }) as HTMLButtonElement).disabled).toBe(false)
  })
  fireEvent.click(screen.getByRole('button', { name: '查询' }))
}

describe('Search', () => {
  it('does not query until the user asks, and says so', () => {
    render(<Search />)

    expect(screen.getByText('执行查询以查看原始事件。')).toBeDefined()
    expect(fetchSearchMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('renders the raw events for the submitted query', async () => {
    fetchSearchMock.mockResolvedValue(result())

    render(<Search />)
    await submit('index=app')

    expect(fetchSearchMock).toHaveBeenCalledWith({
      query: 'index=app',
      earliest: '-1h',
      latest: 'now',
    })

    await screen.findByRole('table')
    expect(screen.getByText('事件')).toBeDefined()
    expect(screen.getByText('1 行')).toBeDefined()
    expect(screen.getByText('api-01')).toBeDefined()
    expect(screen.getByText('boom')).toBeDefined()
  })

  it('tells the operator when the result set was cut short', async () => {
    fetchSearchMock.mockResolvedValue(result({ count: 5000, truncated: true }))

    render(<Search />)
    await submit('index=app')

    await screen.findByText(/已截断，请缩小范围/)
    expect(screen.getByText('5,000 行 · 已截断，请缩小范围')).toBeDefined()
  })

  it('renders the empty-result state rather than an empty table', async () => {
    fetchSearchMock.mockResolvedValue(result({ count: 0, results: [] }))

    render(<Search />)
    await submit('index=app')

    await screen.findByText('没有匹配到事件。')
    expect(screen.getByText('0 行')).toBeDefined()
  })

  it('reports a failed search', async () => {
    fetchSearchMock.mockRejectedValue(new ApiError('SafetyLimitError', '时间跨度超过上限', 422))

    render(<Search />)
    await submit('index=app')

    await screen.findByText('时间跨度超过上限')
    expect(screen.getByText('SafetyLimitError')).toBeDefined()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('renders nothing for a non-success payload', async () => {
    // Defensive: a 200 with `success: false` must not be treated as data.
    fetchSearchMock.mockResolvedValue({
      success: false,
      query: 'index=app',
      count: 0,
      truncated: false,
      results: [],
    } as unknown as SearchResult)

    render(<Search />)
    await submit('index=app')

    await waitFor(() => {
      expect(fetchSearchMock).toHaveBeenCalled()
    })
    expect(screen.queryByText('事件')).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('shows progress on the submit button while a query runs', async () => {
    fetchSearchMock.mockReturnValue(new Promise(() => {}))

    render(<Search />)
    await submit('index=app')

    const button = screen.getByRole('button', { name: '查询中…' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('re-runs the search when the time range changes', async () => {
    fetchSearchMock.mockResolvedValue(result())

    render(<Search />)
    await submit('index=app')
    await screen.findByRole('table')

    fireEvent.click(screen.getByRole('button', { name: '24 小时' }))

    await waitFor(() => {
      expect(fetchSearchMock).toHaveBeenLastCalledWith({
        query: 'index=app',
        earliest: '-24h',
        latest: 'now',
      })
    })
  })

  it('asks for daily buckets when only Splunk can measure the window', async () => {
    // A calendar window has no local width; a fine span would leave the
    // histogram covering only the start of it.
    fetchSearchMock.mockResolvedValue(result())

    render(<Search />)
    await submit('index=app')
    await screen.findByRole('table')

    fireEvent.click(screen.getByRole('button', { name: '上月' }))

    await waitFor(() => {
      expect(fetchSearchMock).toHaveBeenLastCalledWith({
        query: 'index=app',
        earliest: '-1mon@mon',
        latest: '@mon',
      })
    })
    expect(fetchTimelineMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ span: '1d', earliest: '-1mon@mon', latest: '@mon' }),
    )
  })

  it('opens the editor on a window it can actually display', async () => {
    // The editor carried the calendar window over at first, so the absolute
    // fields rendered empty and the summary line contradicted them.
    fetchSearchMock.mockResolvedValue(result())

    render(<Search />)
    await submit('index=app')
    await screen.findByRole('table')

    fireEvent.click(screen.getByRole('button', { name: '上月' }))
    fireEvent.click(screen.getByRole('button', { name: '自定义' }))

    expect((screen.getByLabelText('相对时间数值') as HTMLInputElement).value).toBe('1')
    expect(screen.getByText('-1h → now')).toBeDefined()

    await waitFor(() => {
      expect(fetchSearchMock).toHaveBeenLastCalledWith({
        query: 'index=app',
        earliest: '-1h',
        latest: 'now',
      })
    })
  })

  it('re-runs the search for an edited custom window', async () => {
    fetchSearchMock.mockResolvedValue(result())

    render(<Search />)
    await submit('index=app')
    await screen.findByRole('table')

    fireEvent.click(screen.getByRole('button', { name: '自定义' }))
    fireEvent.change(screen.getByLabelText('相对时间单位'), { target: { value: 'm' } })
    const amount = screen.getByLabelText('相对时间数值')
    fireEvent.change(amount, { target: { value: '45' } })
    fireEvent.blur(amount)

    await waitFor(() => {
      expect(fetchSearchMock).toHaveBeenLastCalledWith({
        query: 'index=app',
        earliest: '-45m',
        latest: 'now',
      })
    })
  })
})

describe('Search timeline', () => {
  it('loads a timeline for the same query and window', async () => {
    fetchSearchMock.mockResolvedValue(result())

    render(<Search />)
    await submit('index=app')

    await screen.findByTestId('timeline-bars')
    expect(fetchTimelineMock).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'index=app', earliest: '-1h', latest: 'now' }),
    )
    expect(screen.getAllByTestId(/^bucket-/)).toHaveLength(2)
  })

  it('does not ask for a timeline before a query is run', () => {
    render(<Search />)

    expect(fetchTimelineMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('timeline-bars')).toBeNull()
  })

  it('narrows the search to the bucket selected on the timeline', async () => {
    fetchSearchMock.mockResolvedValue(result())

    render(<Search />)
    await submit('index=app')
    await screen.findByTestId('timeline-bars')

    fireEvent.mouseDown(screen.getByTestId('bucket-1'))
    fireEvent.mouseUp(screen.getByTestId('timeline-bars'))

    const start = '2024-01-02T03:05:00.000+08:00'
    await waitFor(() => {
      expect(fetchSearchMock).toHaveBeenLastCalledWith({
        query: 'index=app',
        earliest: start,
        // Half-open: the window ends where the next bucket begins.
        latest: endOfSpan(start, '5m'),
      })
    })
    // The editor now holds the brushed window as the absolute instants it is.
    expect(screen.getByText(`${start} → ${endOfSpan(start, '5m')}`)).toBeDefined()
  })

  it('zooms the timeline into the selected window', async () => {
    fetchSearchMock.mockResolvedValue(result())

    render(<Search />)
    await submit('index=app')
    await screen.findByTestId('timeline-bars')

    fireEvent.mouseDown(screen.getByTestId('bucket-0'))
    fireEvent.mouseEnter(screen.getByTestId('bucket-1'))
    fireEvent.mouseUp(screen.getByTestId('timeline-bars'))

    // Re-asking for the narrower window is what lets the operator keep zooming.
    await waitFor(() => {
      expect(fetchTimelineMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          earliest: '2024-01-02T03:00:00.000+08:00',
          latest: endOfSpan('2024-01-02T03:05:00.000+08:00', '5m'),
        }),
      )
    })
  })

  it('clears a selection back to the preset that was in effect', async () => {
    fetchSearchMock.mockResolvedValue(result())

    render(<Search />)
    fireEvent.click(screen.getByRole('button', { name: '24 小时' }))
    await submit('index=app')
    await screen.findByTestId('timeline-bars')

    fireEvent.mouseDown(screen.getByTestId('bucket-1'))
    fireEvent.mouseUp(screen.getByTestId('timeline-bars'))

    fireEvent.click(await screen.findByRole('button', { name: '清除选择' }))

    await waitFor(() => {
      expect(fetchSearchMock).toHaveBeenLastCalledWith({
        query: 'index=app',
        earliest: '-24h',
        latest: 'now',
      })
    })
  })

  it('reports a failed timeline without hiding the events', async () => {
    fetchSearchMock.mockResolvedValue(result())
    fetchTimelineMock.mockRejectedValue(new ApiError('SafetyLimitError', '时间跨度超过上限', 422))

    render(<Search />)
    await submit('index=app')

    expect(await screen.findByText('时间跨度超过上限')).toBeDefined()
    expect(screen.getByRole('table')).toBeDefined()
  })
})

describe('Search job status', () => {
  const JOB = {
    sid: '1789538945.12345',
    dispatch_state: 'DONE',
    is_done: true,
    is_failed: false,
    is_finalized: true,
    done_progress: 1,
    result_count: 1125,
    event_count: 1125,
    scan_count: 42_000,
    run_duration: 0.049,
    search_earliest_time: 1785513600,
    search_latest_time: 1788192000,
    sample_ratio: '1',
  }

  it('reports the window Splunk actually resolved the preset to', async () => {
    // `上月` is an expression; the status bar is where it becomes two instants.
    fetchSearchMock.mockResolvedValue(result({ job: JOB, total_available: 1125 }))

    render(<Search />)
    await submit('index=app')
    await screen.findByRole('table')

    fireEvent.click(screen.getByRole('button', { name: '上月' }))

    const summary = await screen.findByTestId('job-status-summary')
    expect(summary.textContent).toContain('1,125 个事件')
    expect(summary.textContent).toContain('完成')
    expect(summary.textContent).toContain('2026')
  })

  it('leaves the status bar out when the payload carries no job', async () => {
    fetchSearchMock.mockResolvedValue(result())

    render(<Search />)
    await submit('index=app')
    await screen.findByRole('table')

    expect(screen.queryByTestId('job-status-summary')).toBeNull()
  })
})

describe('Search CSV export', () => {
  const globals = URL as unknown as Record<string, unknown>
  let created: ReturnType<typeof vi.fn>

  beforeEach(() => {
    created = vi.fn(() => 'blob:test')
    globals['createObjectURL'] = created
    globals['revokeObjectURL'] = vi.fn()
  })

  afterEach(() => {
    delete globals['createObjectURL']
    delete globals['revokeObjectURL']
  })

  it('writes the rows already on screen, and asks Splunk for nothing', async () => {
    // Not `/search/jobs/export`: that endpoint is forbidden because it streams
    // past the result cap. This is the page the operator is looking at.
    fetchSearchMock.mockResolvedValue(result())
    const downloaded: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloaded.push(this.download)
    })

    render(<Search />)
    await submit('index=app')
    await screen.findByRole('table')

    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }))

    expect(created).toHaveBeenCalledTimes(1)
    expect(downloaded[0]).toMatch(/^splunk-cli-\d{8}-\d{6}\.csv$/)
    expect(fetchSearchMock).toHaveBeenCalledTimes(1)
  })

  it('is disabled while there is nothing to export', async () => {
    fetchSearchMock.mockResolvedValue(result({ results: [], count: 0 }))

    render(<Search />)
    await submit('index=app')
    await screen.findByText(/0 行/)

    expect((screen.getByRole('button', { name: '导出 CSV' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})
