// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { resetTimelineFormat } from '../hooks/useTimelineFormat'
import { TIMELINE_FORMAT_KEY } from '../lib/timelineFormat'
import { MAX_TIMELINE_BUCKETS, endOfSpan } from '../lib/timeRange'
import type { TimelinePoint } from '../types/api'
import { EventTimeline } from './EventTimeline'

beforeEach(() => {
  window.localStorage.clear()
  resetTimelineFormat()
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  resetTimelineFormat()
})

const POINTS: TimelinePoint[] = [
  { time: '2024-01-02T03:00:00.000+08:00', count: 5 },
  { time: '2024-01-02T03:05:00.000+08:00', count: 20 },
  { time: '2024-01-02T03:10:00.000+08:00', count: 10 },
  { time: '2024-01-02T03:15:00.000+08:00', count: 2 },
]

function setup(overrides: Partial<Parameters<typeof EventTimeline>[0]> = {}): {
  onSelect: ReturnType<typeof vi.fn>
  onClear: ReturnType<typeof vi.fn>
} {
  const onSelect = vi.fn()
  const onClear = vi.fn()
  render(
    <EventTimeline
      points={POINTS}
      span="5m"
      brushed={false}
      onSelect={onSelect}
      onClear={onClear}
      {...overrides}
    />,
  )
  return { onSelect, onClear }
}

describe('EventTimeline', () => {
  it('draws one bar per bucket and reports the totals', () => {
    setup()

    expect(screen.getAllByTestId(/^bucket-/)).toHaveLength(4)
    expect(screen.getByText(/每列 5m · 4 桶 · 共 37 个事件/)).toBeDefined()
  })

  it('warns when the bucket list is full, because a full list is not a covered window', () => {
    const full: TimelinePoint[] = Array.from({ length: MAX_TIMELINE_BUCKETS }, (_, index) => ({
      time: new Date(Date.UTC(2024, 0, 2, 0, index)).toISOString(),
      count: 1,
    }))

    setup({ points: full })

    expect(screen.getByText('桶数已达上限，可能未覆盖整个窗口')).toBeDefined()
  })

  it('stays quiet while every bucket fits', () => {
    setup()

    expect(screen.queryByText('桶数已达上限，可能未覆盖整个窗口')).toBeNull()
  })

  it('scales the bars against the busiest bucket', () => {
    setup()

    // 20 is the peak, so it fills the height and 10 sits at half of it.
    expect(screen.getByTestId('bucket-1').style.height).toBe('100%')
    expect(screen.getByTestId('bucket-2').style.height).toBe('50%')
  })

  it('names every bucket for assistive tech', () => {
    setup()

    expect(screen.getByTestId('bucket-0').getAttribute('aria-label')).toContain('5 个事件')
  })

  it('selects the window covered by a drag', () => {
    const { onSelect } = setup()

    fireEvent.mouseDown(screen.getByTestId('bucket-1'))
    fireEvent.mouseEnter(screen.getByTestId('bucket-3'))
    fireEvent.mouseUp(screen.getByTestId('timeline-bars'))

    expect(onSelect).toHaveBeenCalledWith({
      earliest: POINTS[1]?.time,
      latest: endOfSpan(POINTS[3]?.time ?? '', '5m'),
    })
  })

  it('selects a single bucket on a plain click', () => {
    const { onSelect } = setup()

    fireEvent.mouseDown(screen.getByTestId('bucket-2'))
    fireEvent.mouseUp(screen.getByTestId('timeline-bars'))

    // The window is half-open: the end is the start of the next bucket.
    expect(onSelect).toHaveBeenCalledWith({
      earliest: POINTS[2]?.time,
      latest: endOfSpan(POINTS[2]?.time ?? '', '5m'),
    })
  })

  it('reads a drag backwards the same way as forwards', () => {
    const { onSelect } = setup()

    fireEvent.mouseDown(screen.getByTestId('bucket-3'))
    fireEvent.mouseEnter(screen.getByTestId('bucket-0'))
    fireEvent.mouseUp(screen.getByTestId('timeline-bars'))

    expect(onSelect).toHaveBeenCalledWith({
      earliest: POINTS[0]?.time,
      latest: endOfSpan(POINTS[3]?.time ?? '', '5m'),
    })
  })

  it('does not select when the pointer was never pressed', () => {
    const { onSelect } = setup()

    fireEvent.mouseUp(screen.getByTestId('timeline-bars'))

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('commits the drag when the pointer leaves the chart', () => {
    const { onSelect } = setup()

    fireEvent.mouseDown(screen.getByTestId('bucket-0'))
    fireEvent.mouseLeave(screen.getByTestId('timeline-bars'))

    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('keeps the clear action out of the way until it is useful', () => {
    setup()

    expect(screen.queryByRole('button', { name: '清除选择' })).toBeNull()
  })

  it('clears a brushed window', () => {
    const { onClear } = setup({ brushed: true })

    fireEvent.click(screen.getByRole('button', { name: '清除选择' }))

    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('says so when there is nothing to draw', () => {
    setup({ points: [] })

    expect(screen.getByText(/没有可绘制的时间桶/)).toBeDefined()
    expect(screen.queryByTestId('timeline-bars')).toBeNull()
  })
})

describe('EventTimeline tooltip', () => {
  it('shows the bucket and its count as soon as the pointer is on it', () => {
    // The browser's own `title` waits about a second; reading the count off a
    // bucket should not need a pause.
    setup()

    // Nothing is rendered before the pointer arrives.
    expect(screen.queryByTestId('timeline-tooltip')).toBeNull()

    fireEvent.mouseEnter(screen.getByTestId('bucket-2'))

    const tooltip = screen.getByTestId('timeline-tooltip')
    expect(tooltip.textContent).toContain('10 个事件')
  })

  it('follows the pointer to whichever bucket it is over', () => {
    setup()

    fireEvent.mouseEnter(screen.getByTestId('bucket-1'))
    expect(screen.getByTestId('timeline-tooltip').textContent).toContain('20 个事件')

    fireEvent.mouseEnter(screen.getByTestId('bucket-3'))
    expect(screen.getByTestId('timeline-tooltip').textContent).toContain('2 个事件')
  })

  it('opens towards the side of the panel that has room', () => {
    setup()

    // jsdom reports a zero-width chart, so drive the pointer from the right edge
    // to exercise the flipped branch as well as the default one.
    const far = screen.getByTestId('bucket-3')
    fireEvent.mouseEnter(far, { clientX: 900 })
    const flipped = screen.getByTestId('timeline-tooltip')
    expect(flipped.style.transform).toBe('translateX(-100%)')
  })

  it('goes away when the pointer leaves the chart', () => {
    setup()

    fireEvent.mouseEnter(screen.getByTestId('bucket-1'))
    fireEvent.mouseLeave(screen.getByTestId('timeline-bars'))

    expect(screen.queryByTestId('timeline-tooltip')).toBeNull()
  })
})

describe('EventTimeline format', () => {
  it('offers the formats Splunk offers, with bars selected', () => {
    setup()

    const group = screen.getByRole('group', { name: '时间线格式' })
    expect([...group.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      '柱状',
      '折线',
      '面积',
    ])
    expect(screen.getByRole('button', { name: '柱状' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '折线' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('draws a step line instead of bars when asked for a line', () => {
    setup()

    fireEvent.click(screen.getByRole('button', { name: '折线' }))

    const path = document.querySelector('svg path')
    expect(path?.getAttribute('d')).toMatch(/^M 0 /)
    // A step, not a straight run through the points: one x per bucket edge.
    expect(path?.getAttribute('d')?.match(/L /g)).toHaveLength(7)
    // The bars are still there as hit targets, but no longer carry the height.
    expect(screen.getByTestId('bucket-1').style.height).toBe('')
  })

  it('fills the area under the line in area format', () => {
    setup()

    fireEvent.click(screen.getByRole('button', { name: '面积' }))

    const paths = [...document.querySelectorAll('svg path')]
    expect(paths).toHaveLength(2)
    // The fill is drawn first so the stroke stays visible on top of it.
    expect(paths[0]?.getAttribute('class')).toContain('fill-accent')
    expect(paths[0]?.getAttribute('d')?.endsWith('Z')).toBe(true)
    expect(paths[1]?.getAttribute('class')).toContain('stroke-accent')
  })

  it('remembers the choice across a reload', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: '面积' }))

    expect(window.localStorage.getItem(TIMELINE_FORMAT_KEY)).toBe('area')

    // A fresh mount reads it back — the store is what survives the reload.
    cleanup()
    resetTimelineFormat()
    setup()

    expect(screen.getByRole('button', { name: '面积' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('falls back to bars when the stored value is not a format this build draws', () => {
    window.localStorage.setItem(TIMELINE_FORMAT_KEY, 'donut')
    resetTimelineFormat()

    setup()

    expect(screen.getByRole('button', { name: '柱状' }).getAttribute('aria-pressed')).toBe('true')
  })
})
