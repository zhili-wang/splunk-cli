// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { resetTheme } from '../hooks/useTheme'
import { ThemeToggle } from './ThemeToggle'
import { TimelineChart } from './TimelineChart'

const chart = vi.hoisted(() => ({
  setOption: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
}))

vi.mock('../lib/echarts', () => ({
  echarts: { init: vi.fn(() => chart) },
}))

interface Observer {
  callback: ResizeObserverCallback
  observe: ReturnType<typeof vi.fn>
  unobserve: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

const observers: Observer[] = []

beforeEach(() => {
  observers.length = 0
  localStorage.clear()
  resetTheme()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      readonly disconnect = vi.fn()
      readonly observe = vi.fn()
      readonly unobserve = vi.fn()

      constructor(callback: ResizeObserverCallback) {
        observers.push({
          callback,
          observe: this.observe,
          unobserve: this.unobserve,
          disconnect: this.disconnect,
        })
      }
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const POINTS = [
  { time: '2024-01-02T03:04:05', count: 3 },
  { time: '2024-01-02T03:09:05', count: 7 },
]

describe('TimelineChart', () => {
  it('summarizes the span and bucket count in the header', () => {
    render(<TimelineChart points={POINTS} span="5m" />)

    expect(screen.getByText('事件时间线')).toBeDefined()
    expect(screen.getByText('跨度 5m · 2 个时间桶')).toBeDefined()
  })

  it('feeds formatted bucket labels and raw counts to echarts', () => {
    render(<TimelineChart points={POINTS} span="5m" />)

    expect(chart.setOption).toHaveBeenCalledWith(
      expect.objectContaining({
        // Bucket timestamps are rendered as local clock times; a raw ISO
        // string would be unreadable on a crowded axis.
        xAxis: expect.objectContaining({ data: ['03:04', '03:09'] }),
        series: [expect.objectContaining({ type: 'line', data: [3, 7] })],
      }),
    )
  })

  it('mounts its own chart instance into the labelled host element', () => {
    const { container } = render(<TimelineChart points={POINTS} span="5m" />)

    const host = container.querySelector('div[role="img"]')
    expect(host?.getAttribute('aria-label')).toBe('事件时间线')
  })

  it('renders an empty bucket set without a chart series', () => {
    render(<TimelineChart points={[]} span="1h" />)

    expect(screen.getByText('跨度 1h · 0 个时间桶')).toBeDefined()
    expect(chart.setOption).toHaveBeenCalledWith(
      expect.objectContaining({
        xAxis: expect.objectContaining({ data: [] }),
        series: [expect.objectContaining({ data: [] })],
      }),
    )
  })

  it('resizes with its container and disposes on unmount', () => {
    const { unmount } = render(<TimelineChart points={POINTS} span="5m" />)

    const observer = observers[0]
    expect(observer?.observe).toHaveBeenCalledTimes(1)

    observer?.callback([], {} as ResizeObserver)
    expect(chart.resize).toHaveBeenCalledTimes(1)

    unmount()
    expect(chart.dispose).toHaveBeenCalledTimes(1)
    expect(observer?.disconnect).toHaveBeenCalledTimes(1)
  })

  it('replaces the chart when the points change', () => {
    // A reload hands the chart a brand new array. The old instance must be
    // disposed rather than left listening to a detached node.
    const { rerender } = render(<TimelineChart points={POINTS} span="5m" />)

    rerender(<TimelineChart points={[{ time: '2024-01-02T04:00:00', count: 1 }]} span="5m" />)

    expect(chart.dispose).toHaveBeenCalledTimes(1)
    expect(chart.setOption).toHaveBeenCalledTimes(2)
    expect(observers).toHaveLength(2)
  })

  it('repaints with the light palette when the theme changes', () => {
    // The canvas cannot read CSS variables, so a theme switch has to reach
    // ECharts explicitly — otherwise the tooltip stays dark on a white panel.
    render(
      <>
        <ThemeToggle />
        <TimelineChart points={POINTS} span="5m" />
      </>,
    )

    expect(chart.setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tooltip: expect.objectContaining({ backgroundColor: '#12161c' }),
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: '切换到日间模式' }))

    expect(chart.setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tooltip: expect.objectContaining({ backgroundColor: '#ffffff' }),
        series: [expect.objectContaining({ lineStyle: expect.objectContaining({ color: '#6842f5' }) })],
      }),
    )
  })
})
