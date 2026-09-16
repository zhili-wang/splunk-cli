import { describe, expect, it, vi } from 'vitest'

/**
 * `src/lib/echarts.ts` is the module that first pulls ECharts into the bundle.
 * Every heavy submodule it registers is mocked here: the assertions are about
 * *what the dashboard registers*, and running the real renderer in Node would
 * prove nothing about that (and cannot, since there is no canvas).
 *
 * The registration happens at module-import time, but Vitest clears mock call
 * history before each test — so the arguments are recorded in a plain array
 * (unaffected by that reset) rather than read back from `vi.fn().mock.calls`.
 */
const registration = vi.hoisted(() => {
  const calls: unknown[][] = []
  return {
    calls,
    core: {
      use: vi.fn((...args: unknown[]) => {
        calls.push(args)
      }),
    },
  }
})

vi.mock('echarts/core', () => registration.core)
vi.mock('echarts/charts', () => ({
  BarChart: { component: 'BarChart' },
  LineChart: { component: 'LineChart' },
}))
vi.mock('echarts/components', () => ({
  GridComponent: { component: 'GridComponent' },
  LegendComponent: { component: 'LegendComponent' },
  TooltipComponent: { component: 'TooltipComponent' },
}))
vi.mock('echarts/renderers', () => ({ CanvasRenderer: { component: 'CanvasRenderer' } }))

import { echarts } from './echarts'

describe('echarts module', () => {
  it('re-exports the echarts core it configured', () => {
    // TimelineChart imports `echarts` from this module and calls `init` on it,
    // so the re-export must be the configured core and not a copy.
    expect(echarts.use).toBe(registration.core.use)
  })

  it('registers exactly the components the dashboard draws', () => {
    // Only the line chart (timeline), the bar chart (registered for the ranked
    // panels), the canvas renderer and the grid/tooltip/legend components are
    // needed. Registering more would grow the bundle; registering fewer would
    // make the timeline silently fail to draw.
    expect(registration.calls).toHaveLength(1)

    const registered = registration.calls[0]?.[0] as { component: string }[]
    expect(registered.map((item) => item.component)).toEqual([
      'LineChart',
      'BarChart',
      'GridComponent',
      'TooltipComponent',
      'LegendComponent',
      'CanvasRenderer',
    ])
  })
})
