/**
 * 人类可读的表格渲染。
 *
 * 不引第三方依赖（如 cli-table3），换取对输出字节的**完全可控**
 * （ADR R7）。CJK 宽字符按两列计，保证中文日志消息的表格依然对齐。
 *
 * `displayWidth` 是终端东亚字符宽度（east asian width）的近似实现：
 * 覆盖常见 Wide/Fullwidth 区段 + 组合字符。当前 fixture 与用例都是 ASCII，
 * 若将来出现 CJK 值导致对拍差异，以实测为准再补区段。
 */

// 数字格式只有一套语义（AGENTS.md §3：数字契约收敛在 server/format.ts）。
import { formatG } from '../format'

/** 单个单元格渲染前的默认最大宽度。 */
export const DEFAULT_MAX_CELL_WIDTH = 60

/** 组合字符（不占列宽）。 */
const COMBINING_RE = /\p{M}/u

/** Wide / Fullwidth 区段（东亚宽度类别 ∈ {W, F}）。 */
const WIDE_RE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}]/u

/**
 * 返回字符串在终端里占用的列宽。
 *
 * @param text 任意字符串。
 */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    if (COMBINING_RE.test(char)) continue
    width += WIDE_RE.test(char) ? 2 : 1
  }
  return width
}

/**
 * 按显示宽度截断，被截断时以 `…` 结尾。
 *
 * @param text 原文本。
 * @param maxWidth 最大显示宽度。
 */
export function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (displayWidth(text) <= maxWidth) return text

  const target = maxWidth - 1 // 留一列给省略号
  const out: string[] = []
  let used = 0
  for (const char of text) {
    const charWidth = WIDE_RE.test(char) ? 2 : 1
    if (used + charWidth > target) break
    out.push(char)
    used += charWidth
  }
  return `${out.join('')}…`
}

/**
 * 在给定显示宽度内左对齐填充。
 *
 * @param text 单元格内容。
 * @param width 目标显示宽度。
 */
export function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

/** 折叠空白，避免多行值破坏表格对齐。 */
function flatten(text: string): string {
  return text
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(' ')
}

/**
 * 把单个结果值渲染成单元格文本。
 *
 * `cell` 的规则：`null` → 空、布尔 → 小写、数组/对象展开、
 * 整数值的浮点去掉 `.0`。
 */
export function cell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return value.map((item) => cell(item)).join(', ')
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}=${cell(item)}`)
      .join(', ')
  }
  if (typeof value === 'number' && Number.isInteger(value)) return String(value)
  return String(value)
}

/**
 * 决定结果行的稳定列顺序。
 *
 * @param rows 结果行。
 * @param preferred 优先放置的字段名（存在时）。
 */
export function fieldOrder(
  rows: Array<Record<string, unknown>>,
  preferred: string[] | null = null,
): string[] {
  const seen: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.includes(key)) seen.push(key)
    }
  }
  const ordered: string[] = []
  for (const name of preferred ?? []) {
    if (seen.includes(name)) ordered.push(name)
  }
  for (const name of seen) {
    if (!ordered.includes(name)) ordered.push(name)
  }
  return ordered
}

/**
 * 渲染对齐的纯文本表格。
 *
 * @param headers 列头。
 * @param rows 行单元格；过短的行以空串补齐。
 * @param maxCellWidth 单元格截断宽度。
 */
export function renderTable(
  headers: string[],
  rows: unknown[][],
  options: { maxCellWidth?: number } = {},
): string {
  const maxCellWidth = options.maxCellWidth ?? DEFAULT_MAX_CELL_WIDTH
  if (headers.length === 0) return '(no columns)'
  if (rows.length === 0) return '(no results)'

  const cellRows: string[][] = rows.map((row) =>
    headers.map((_header, index) => {
      const value = row[index]
      return value === null || value === undefined
        ? ''
        : truncate(flatten(String(value)), maxCellWidth)
    }),
  )

  const widths = headers.map((header) => displayWidth(header))
  for (const row of cellRows) {
    row.forEach((value, index) => {
      widths[index] = Math.max(widths[index] ?? 0, displayWidth(value))
    })
  }

  const headerLine = headers
    .map((header, index) => pad(header, widths[index] ?? 0))
    .join('  ')
  const lines = [headerLine.replace(/\s+$/, '')]
  for (const row of cellRows) {
    lines.push(
      row
        .map((value, index) => pad(value, widths[index] ?? 0))
        .join('  ')
        .replace(/\s+$/, ''),
    )
  }
  return lines.join('\n')
}

/**
 * 渲染结果行为表格。
 *
 * @param rows 结果行。
 * @param options.fields 显式列顺序；默认按首次出现顺序。
 * @param options.maxCellWidth 单元格截断宽度。
 */
export function rowsToTable(
  rows: Array<Record<string, unknown>>,
  options: { fields?: string[] | null; maxCellWidth?: number } = {},
): string {
  if (rows.length === 0) return '(no results)'
  const columns = options.fields ?? fieldOrder(rows)
  return renderTable(
    columns,
    rows.map((row) => columns.map((column) => cell(row[column]))),
    options.maxCellWidth !== undefined ? { maxCellWidth: options.maxCellWidth } : {},
  )
}

/**
 * 渲染两列 `key: value` 版式（左侧标签对齐）。
 *
 * ⚠ 值用 **`str()` 语义**渲染，不是 JS 的 `String()`：
 *   - 布尔渲染成 `True` / `False`，**不是** `true`/`false`；
 *   - `null`/`undefined` 渲染成 `-`。
 *
 * 这一条是被对拍逼出来的：`limits` 的文本输出里 `read_only` 是 `True`。
 * 浮点的类型差异（`str(604800.0)` = `"604800.0"`）无法在 JS 数字上自动区分，
 * 由调用方用 {@link floatString} 显式标注。
 *
 * @param pairs 标签/值对，按顺序渲染。
 */
export function keyValueTable(pairs: Array<[string, unknown]>): string {
  if (pairs.length === 0) return '(no data)'
  const labels = pairs.map(([label]) => String(label))
  const width = Math.max(...labels.map((label) => displayWidth(label)))
  return pairs
    .map(([label, value]) => {
      const rendered = value === null || value === undefined ? '-' : strSemantics(value)
      return `${pad(label, width)}  ${rendered}`
    })
    .join('\n')
}

/** 单个值的 `str()` 语义渲染。 */
function strSemantics(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  return String(value)
}

/**
 * 把一个 JS 数字按 **float** 语义渲染：整数值补 `.0`。
 *
 * 用于类型为 `float` 的字段（如 `max_time_range_seconds`、`timeout`）——
 * 文本输出需要逐字节稳定。
 *
 * @param value 数值。
 */
export function floatString(value: number): string {
  return Number.isInteger(value) ? `${value.toFixed(1)}` : String(value)
}

/**
 * 数值显示格式化。
 *
 * `null` → `-`；整数值去掉小数；否则保留 3 位并去掉尾随零。
 */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-'
  const number = Number(value)
  if (!Number.isFinite(number)) return '-'
  if (Number.isInteger(number)) return String(number)
  return number.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

/** 结果集渲染时优先靠前的列。 */
export const PREFERRED_COLUMNS = [
  '_time',
  'host',
  'source',
  'sourcetype',
  'service',
  'level',
  'message',
]

/** sparkline 使用的方块字符（从低到高）。 */
const SPARK_CHARS = '▁▂▃▄▅▆▇█'

/** sparkline 最多渲染的桶数。 */
const SPARKLINE_BUCKETS = 80

/**
 * 渲染紧凑的 unicode sparkline。
 *
 * 只取最后 80 个值；全相等时用最低字符铺满（避免除零）。
 *
 * @param values 数值序列。
 */
export function sparkline(values: number[]): string {
  if (values.length === 0) return ''
  const series = values.slice(-SPARKLINE_BUCKETS)
  const low = Math.min(...series)
  const high = Math.max(...series)
  if (high === low) return SPARK_CHARS[0]?.repeat(series.length) ?? ''
  const span = high - low
  const lastIndex = SPARK_CHARS.length - 1
  return series
    .map((value) => {
      const index = Math.min(lastIndex, Math.trunc(((value - low) / span) * lastIndex))
      return SPARK_CHARS[index] ?? ''
    })
    .join('')
}

/**
 * 渲染 stats 的分组键。
 *
 * @param key 单值，或多字段分组的取值数组。
 */
export function statKey(key: string | string[]): string {
  return Array.isArray(key) ? key.join(' | ') : key
}

/**
 * 渲染搜索结果集（表格 + 摘要行）。
 *
 * 摘要里带上 Job 的执行事实，因为时间范围是以**表达式**给出的：`--range last-month`
 * 或 `--earliest=@mon` 究竟落到了哪两个瞬间，只有服务端知道，而"我到底查了哪一段"
 * 是读结果之前必须先确认的事。JSON 输出里这些事实是 epoch 秒，给人看的文本在这里
 * 补上带时区的 ISO-8601。
 *
 * @param result 结果集（只依赖这几个字段，避免与模型循环依赖）。
 */
export function renderResultSet(result: {
  results: Array<Record<string, unknown>>
  count: number
  truncated: boolean
  total_available: number
  /** Job 的执行元数据；缺省或为 `null` 时摘要里不提这一块。 */
  job?: {
    search_earliest_time: number | null
    search_latest_time: number | null
    run_duration: number | null
    sample_ratio: string
  } | null
}): string {
  const notes = executionNotes(result.job ?? null)
  const suffix = notes.length === 0 ? '' : ` · ${notes.join(' · ')}`
  if (result.results.length === 0) {
    // 没有命中时窗口信息更重要：先确认查的是不是那一段，再判断"真的没有"。
    return `(no results)${suffix}`
  }
  const columns = fieldOrder(result.results, PREFERRED_COLUMNS)
  const table = rowsToTable(result.results, { fields: columns })
  let summary = `${result.count} result(s)`
  if (result.truncated) {
    summary += ` (truncated at limit; ${result.total_available} available)`
  }
  return `${table}\n\n${summary}${suffix}`
}

/** 执行事实，按"最该先看到的"排序。 */
function executionNotes(job: {
  search_earliest_time: number | null
  search_latest_time: number | null
  run_duration: number | null
  sample_ratio: string
} | null): string[] {
  if (job === null) return []
  const notes: string[] = []
  if (job.search_earliest_time !== null && job.search_latest_time !== null) {
    notes.push(
      `实际时间窗 ${formatInstant(job.search_earliest_time)} → ` +
        formatInstant(job.search_latest_time),
    )
  }
  if (job.run_duration !== null) notes.push(`耗时 ${formatG(job.run_duration)}s`)
  if (job.sample_ratio !== '' && job.sample_ratio !== '1') {
    // 采样把计数变成近似值，摘要里必须说，否则这些数字会被当成精确值引用。
    notes.push(`采样 1:${job.sample_ratio}（近似值）`)
  }
  return notes
}

/**
 * epoch 秒 → 带本地时区偏移的 ISO-8601。
 *
 * 带偏移而不是 UTC：`--earliest` 这类表达式是**按 Splunk 的时区**求值的，给人看的窗口
 * 必须和 Splunk 界面上的那一行对得上，否则每次排查都要在脑子里做一次时区换算。
 */
export function formatInstant(seconds: number): string {
  const date = new Date(seconds * 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes < 0 ? '-' : '+'
  const offset = Math.abs(offsetMinutes)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`
  )
}
