/**
 * The event timeline.
 *
 * ECharts paints to a canvas, so it cannot read the CSS variables the rest of
 * the dashboard is built on — the two palettes below are the one place a colour
 * is repeated, and they exist to keep the chart from glowing dark on a light
 * panel (the tooltip and the split lines are the obvious offenders).
 */

import { useEffect, useRef } from 'react'

import { useTheme } from '../hooks/useTheme'
import { echarts } from '../lib/echarts'
import { formatBucketTime, formatCount } from '../lib/format'
import type { Theme } from '../lib/theme'
import type { TimelinePoint } from '../types/api'

interface Palette {
  tooltipBg: string
  tooltipBorder: string
  text: string
  axis: string
  label: string
  split: string
  line: string
  areaTop: string
  areaBottom: string
}

const PALETTES: Readonly<Record<Theme, Palette>> = {
  dark: {
    tooltipBg: '#12161c',
    tooltipBorder: '#323b49',
    text: '#e8ecf3',
    axis: '#323b49',
    label: '#6b7688',
    split: '#181d25',
    line: '#7c5cff',
    areaTop: 'rgba(124, 92, 255, 0.35)',
    areaBottom: 'rgba(124, 92, 255, 0.02)',
  },
  light: {
    tooltipBg: '#ffffff',
    tooltipBorder: '#d1d7e0',
    text: '#10151d',
    axis: '#d1d7e0',
    label: '#5c6776',
    split: '#e4e8ee',
    line: '#6842f5',
    areaTop: 'rgba(104, 66, 245, 0.28)',
    areaBottom: 'rgba(104, 66, 245, 0.02)',
  },
}

interface Props {
  points: TimelinePoint[]
  span: string
}

export function TimelineChart({ points, span }: Props): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const { theme } = useTheme()

  useEffect(() => {
    if (host.current === null) return
    const palette = PALETTES[theme]
    const chart = echarts.init(host.current, undefined, { renderer: 'canvas' })

    chart.setOption({
      backgroundColor: 'transparent',
      grid: { left: 8, right: 12, top: 16, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'axis',
        backgroundColor: palette.tooltipBg,
        borderColor: palette.tooltipBorder,
        textStyle: { color: palette.text, fontSize: 12 },
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: points.map((point) => formatBucketTime(point.time)),
        axisLine: { lineStyle: { color: palette.axis } },
        axisLabel: { color: palette.label, fontSize: 11 },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: palette.split } },
        axisLabel: { color: palette.label, fontSize: 11 },
      },
      series: [
        {
          type: 'line',
          smooth: false,
          showSymbol: false,
          data: points.map((point) => point.count),
          lineStyle: { color: palette.line, width: 2 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: palette.areaTop },
                { offset: 1, color: palette.areaBottom },
              ],
            },
          },
        },
      ],
    })

    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(host.current)
    return () => {
      observer.disconnect()
      chart.dispose()
    }
    // Re-painting on a theme change is the point: the canvas cannot restyle itself.
  }, [points, theme])

  return (
    <section className="panel">
      <header className="panel-header">
        <h2 className="panel-title">事件时间线</h2>
        <span className="tnum text-xs text-signal-muted">
          跨度 {span} · {formatCount(points.length)} 个时间桶
        </span>
      </header>
      <div ref={host} className="h-72 w-full px-2 pb-2" role="img" aria-label="事件时间线" />
    </section>
  )
}
