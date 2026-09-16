/**
 * ECharts, registered module by module.
 *
 * Importing `echarts/core` and registering only the components the dashboard
 * draws avoids pulling in the full library. What the dashboard actually draws
 * is a single chart — the event timeline, a line with an area fill. The two
 * breakdown panels are ranked tables, not charts (`BarPanel` renders a `<ul>`).
 * Registering explicitly is what keeps ECharts from arriving whole.
 *
 * Measured with `npm run build` for the task that wired the dashboard up:
 * importing this module is what first puts ECharts into the bundle, and the
 * emitted `dist/assets/*.js` — the whole application, React and React Router
 * included — grows from 167.26 kB (about 54.5 kB gzipped) to 683.43 kB (about
 * 226.9 kB gzipped). That growth is bounded by the explicit registration below
 * rather than by the whole library.
 */

import { BarChart, LineChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
])

export { echarts }
