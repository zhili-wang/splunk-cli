/**
 * Event timeline with a brush, in the shape the operator prefers.
 *
 * The histogram Splunk puts above its events: one column per time bucket, and
 * dragging across the columns narrows the search to that window. Selecting is
 * the point of it — reading counts off it is a bonus — so every format keeps the
 * same per-bucket hit targets and the same drag semantics.
 *
 * Bars, line and area are not three charts: they are three drawings of the same
 * binned series. The line and area are drawn as a **step** rather than a
 * polyline through the points, because a value covers a whole bucket rather than
 * the instant at its start — and because a step is what keeps the drawing
 * aligned with the hit targets the brush uses.
 *
 * The tooltip is ours rather than the browser's `title`: `title` waits about a
 * second and cannot be styled, and "which bucket, how many events" is the one
 * question this chart exists to answer.
 */

import { useCallback, useMemo, useRef, useState } from 'react'

import { useTimelineFormat } from '../hooks/useTimelineFormat'
import { formatBucketTime, formatCount } from '../lib/format'
import { MAX_TIMELINE_BUCKETS, endOfSpan, type ResolvedRange } from '../lib/timeRange'
import { TIMELINE_FORMATS } from '../lib/timelineFormat'
import type { TimelinePoint } from '../types/api'

interface Props {
  points: TimelinePoint[]
  span: string
  /** Whether the window in effect came from this timeline (shows the clear action). */
  brushed: boolean
  onSelect: (range: ResolvedRange) => void
  onClear: () => void
}

/** SVG user units. The element itself is stretched to the container. */
const CHART_WIDTH = 1000
const CHART_HEIGHT = 100

/** Where the pointer is, for the tooltip. */
interface Hover {
  index: number
  /** Offset inside the chart area, in CSS pixels. */
  x: number
  /** Width of the chart area, so the tooltip knows which way to open. */
  width: number
}

export function EventTimeline({ points, span, brushed, onSelect, onClear }: Props): JSX.Element {
  const { format, setFormat } = useTimelineFormat()
  const [anchor, setAnchor] = useState<number | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  const [hover, setHover] = useState<Hover | null>(null)
  const dragging = useRef(false)
  const area = useRef<HTMLDivElement | null>(null)

  const peak = useMemo(() => Math.max(1, ...points.map((point) => point.count)), [points])
  const total = useMemo(() => points.reduce((sum, point) => sum + point.count, 0), [points])

  const from = anchor === null || cursor === null ? null : Math.min(anchor, cursor)
  const to = anchor === null || cursor === null ? null : Math.max(anchor, cursor)

  // One step per bucket: flat across the bucket, vertical at its edge.
  const { stepPath, areaPath } = useMemo(() => {
    if (points.length === 0) return { stepPath: '', areaPath: '' }
    const width = CHART_WIDTH / points.length
    const y = (count: number): number => CHART_HEIGHT - (count / peak) * CHART_HEIGHT
    let path = `M 0 ${y(points[0]?.count ?? 0)}`
    points.forEach((point, index) => {
      const right = (index + 1) * width
      path += ` L ${right} ${y(point.count)}`
      const next = points[index + 1]
      if (next !== undefined) path += ` L ${right} ${y(next.count)}`
    })
    return {
      stepPath: path,
      areaPath: `${path} L ${CHART_WIDTH} ${CHART_HEIGHT} L 0 ${CHART_HEIGHT} Z`,
    }
  }, [points, peak])

  const commit = (): void => {
    const first = from === null ? undefined : points[from]
    const last = to === null ? undefined : points[to]
    if (first === undefined || last === undefined) return
    onSelect({ earliest: first.time, latest: endOfSpan(last.time, span) })
    setAnchor(null)
    setCursor(null)
  }

  const selected = (index: number): boolean =>
    from !== null && to !== null && index >= from && index <= to

  const selectedCount = from === null || to === null ? null : to - from + 1

  /** Move the tooltip to the bucket under the pointer. */
  const track = useCallback((index: number, clientX: number): void => {
    const rect = area.current?.getBoundingClientRect()
    if (rect === undefined) return
    setHover({ index, x: clientX - rect.left, width: rect.width })
  }, [])

  /**
   * The columns, memoized on purpose: only the tooltip depends on the pointer's
   * horizontal position, and with 500 buckets re-rendering every column on each
   * mouse move would be felt.
   */
  const columns = useMemo(
    () => (
      <div className={`absolute inset-0 flex ${format === 'bar' ? 'items-end gap-px' : ''}`}>
        {points.map((item, index) => (
          <div
            key={item.time}
            data-testid={`bucket-${index}`}
            aria-label={`${formatBucketTime(item.time)}，${formatCount(item.count)} 个事件`}
            onMouseDown={() => {
              dragging.current = true
              setAnchor(index)
              setCursor(index)
            }}
            onMouseEnter={(event) => {
              if (dragging.current) setCursor(index)
              track(index, event.clientX)
            }}
            onMouseMove={(event) => track(index, event.clientX)}
            style={
              format === 'bar'
                ? { height: `${Math.max(2, Math.round((item.count / peak) * 100))}%` }
                : undefined
            }
            className={[
              'min-w-px flex-1 transition-colors',
              format === 'bar'
                ? selected(index)
                  ? 'rounded-sm bg-accent'
                  : 'rounded-sm bg-accent/40 hover:bg-accent/70'
                : selected(index)
                  ? 'bg-accent/25'
                  : 'hover:bg-accent/10',
            ].join(' ')}
          />
        ))}
      </div>
    ),
    [points, peak, format, from, to, track],
  )

  const hovered = hover === null ? undefined : points[hover.index]

  return (
    <section className="panel">
      <header className="panel-header">
        <h2 className="panel-title">时间线</h2>
        <div className="flex items-baseline gap-3">
          <div
            role="group"
            aria-label="时间线格式"
            className="flex items-center gap-0.5 rounded border border-ink-700 p-0.5"
          >
            {TIMELINE_FORMATS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={format === item.id}
                onClick={() => setFormat(item.id)}
                className={[
                  'rounded px-2 py-0.5 text-xs transition-colors',
                  format === item.id
                    ? 'bg-accent text-white'
                    : 'text-signal-muted hover:text-[color:var(--text-primary)]',
                ].join(' ')}
              >
                {item.label}
              </button>
            ))}
          </div>

          <span className="tnum text-xs text-signal-muted">
            每列 {span} · {formatCount(points.length)} 桶 · 共 {formatCount(total)} 个事件
          </span>

          {points.length >= MAX_TIMELINE_BUCKETS ? (
            // A full result is not a covered window: the backend trims buckets
            // with `head`, so the tail of the range may be missing.
            <span className="text-xs text-signal-warn">桶数已达上限，可能未覆盖整个窗口</span>
          ) : null}

          {brushed ? (
            <button
              type="button"
              onClick={onClear}
              className="rounded-md border border-ink-700 px-2 py-0.5 text-[0.7rem] text-signal-muted transition-colors hover:border-ink-600 hover:text-[color:var(--text-primary)]"
            >
              清除选择
            </button>
          ) : null}
        </div>
      </header>

      {points.length === 0 ? (
        <p className="px-4 py-4 text-sm text-signal-muted">
          该查询在这个时间范围内没有可绘制的时间桶。
        </p>
      ) : (
        <>
          <div
            role="group"
            aria-label="事件时间线，拖动可选择时间范围"
            data-testid="timeline-bars"
            className="relative h-24 select-none px-2 pt-2"
            onMouseUp={() => {
              if (!dragging.current) return
              dragging.current = false
              commit()
            }}
            onMouseLeave={() => {
              setHover(null)
              if (!dragging.current) return
              dragging.current = false
              commit()
            }}
          >
            <div ref={area} className="relative h-full w-full">
              {format !== 'bar' ? (
                <svg
                  viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                  className="absolute inset-0 h-full w-full"
                >
                  {format === 'area' ? <path d={areaPath} className="fill-accent/25" /> : null}
                  <path
                    d={stepPath}
                    fill="none"
                    // Non-scaling: the viewBox is stretched to the panel width,
                    // which would otherwise stretch the stroke with it.
                    vectorEffect="non-scaling-stroke"
                    strokeWidth={1.5}
                    className="stroke-accent"
                  />
                </svg>
              ) : null}

              {columns}

              {hover !== null && hovered !== undefined ? (
                <div
                  role="tooltip"
                  data-testid="timeline-tooltip"
                  style={{
                    left: hover.x,
                    // Opens towards the side that has room, so it never leaves
                    // the panel near either edge.
                    transform: hover.x > hover.width / 2 ? 'translateX(-100%)' : 'none',
                    marginLeft: hover.x > hover.width / 2 ? -6 : 6,
                  }}
                  className="tnum pointer-events-none absolute top-1 z-10 whitespace-nowrap rounded border border-ink-700 bg-ink-950/95 px-2 py-1 text-[0.7rem] text-[color:var(--text-primary)] shadow-panel"
                >
                  {formatBucketTime(hovered.time)} · {formatCount(hovered.count)} 个事件
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex items-baseline justify-between px-3 pb-2 text-[0.7rem] text-signal-muted">
            <span className="tnum">
              {from !== null && to !== null
                ? `${formatBucketTime(points[from]?.time ?? '')} – ${formatBucketTime(points[to]?.time ?? '')}` +
                  (selectedCount === null ? '' : ` · ${formatCount(selectedCount)} 桶`)
                : '拖动柱子选择时间范围'}
            </span>
            <span className="tnum">
              {formatBucketTime(points[0]?.time ?? '')} –{' '}
              {formatBucketTime(points[points.length - 1]?.time ?? '')}
            </span>
          </div>
        </>
      )}
    </section>
  )
}
