// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { JobInfo } from '../types/api'
import { JobStatus } from './JobStatus'

afterEach(cleanup)

const JOB: JobInfo = {
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

function setup(overrides: Partial<Parameters<typeof JobStatus>[0]> = {}): void {
  render(<JobStatus job={JOB} {...overrides} />)
}

/** Just the summary line, not the job details behind the disclosure. */
function bar(): HTMLElement {
  return screen.getByTestId('job-status-summary')
}

describe('JobStatus', () => {
  it('reports the state, the count and the window Splunk actually ran', () => {
    setup()

    const text = bar().textContent ?? ''
    expect(text).toContain('完成')
    expect(text).toContain('1,125 个事件')
    // The parenthetical is the point: the request said `@mon`, this is the month.
    expect(text).toContain('至')
    expect(text).toContain('2026')
  })

  it('prefers Splunk’s own total when the payload carried one', () => {
    setup({ totalAvailable: 9000 })

    expect(bar().textContent).toContain('9,000 个事件')
  })

  it('says the window is unknown rather than echoing the expression back', () => {
    // Without a resolved window we cannot claim which instants `@mon` meant.
    const { search_earliest_time: _earliest, search_latest_time: _latest, ...rest } = JOB
    setup({ job: rest })

    expect(bar().textContent).toContain('实际时间窗未知')
  })

  it('shows the run duration and the scanned count when Splunk reports them', () => {
    setup()

    const text = bar().textContent ?? ''
    expect(text).toContain('耗时 0.049 秒')
    expect(text).toContain('扫描 42,000 条')
  })

  it('flags sampling, because sampled counts are estimates', () => {
    setup({ job: { ...JOB, sample_ratio: '100' } })

    expect(bar().textContent).toContain('采样 1:100')
  })

  it('says nothing about sampling when there is none', () => {
    setup()

    expect(bar().textContent).not.toContain('采样')
  })

  it('reports a failed job as failed', () => {
    setup({ job: { ...JOB, is_done: false, is_failed: true, dispatch_state: 'FAILED' } })

    expect(bar().textContent).toContain('失败')
  })

  it('reports progress while a job is still running', () => {
    setup({
      job: { ...JOB, is_done: false, is_finalized: false, done_progress: 0.42 },
    })

    expect(bar().textContent).toContain('进行中 42%')
  })

  it('keeps the job’s internals behind a disclosure', () => {
    setup()

    const details = screen.getByText('任务详情').closest('details')
    expect(details?.open).toBe(false)

    fireEvent.click(screen.getByText('任务详情'))

    const text = details?.textContent ?? ''
    expect(details?.open).toBe(true)
    expect(text).toContain('1789538945.12345')
    expect(text).toContain('DONE')
    expect(text).toContain('无采样')
  })

  it('shows the requested window next to the resolved one', () => {
    // Side by side is what lets an operator see that `@mon` was not their month.
    setup({ requested: { earliest: '-1mon@mon', latest: '@mon' } })

    fireEvent.click(screen.getByText('任务详情'))

    const text = screen.getByLabelText('任务状态').textContent ?? ''
    expect(text).toContain('-1mon@mon → @mon')
  })

  it('marks the fields Splunk did not report as unknown, not as zero', () => {
    const { run_duration: _duration, ...rest } = JOB
    setup({ job: { ...rest, run_duration: null, scan_count: 0 } })

    expect(bar().textContent).not.toContain('耗时')
    fireEvent.click(screen.getByText('任务详情'))
    expect(screen.getByLabelText('任务状态').textContent).toContain('—')
  })
})
