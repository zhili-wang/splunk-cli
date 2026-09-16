/**
 * 结果集模型（`ResultSet`）。
 *
 * `toPublicDict()` 是**公开契约**（README §7）：键名、键顺序与"条件出现"的规则
 * 都参与对拍逐字段比较：
 *   - `time_range` 仅在存在时出现；
 *   - `sid` 仅在非空时出现；
 *   - `total_available` 仅在**真值**（非 0）时出现；
 *   - `job` 仅在执行元数据存在时出现（其内部的 `search_earliest_time` /
 *     `search_latest_time` / `sample_ratio` 同样按"有值才出现"处理）；
 *   - `fields` 仅在非空时出现。
 */

import type { SearchJob, TimeRange } from './search'

/** 搜索结果的公开载荷。 */
export class ResultSet {
  readonly sid: string | null
  readonly query: string
  readonly time_range: TimeRange | null
  readonly count: number
  readonly total_available: number
  readonly results: Array<Record<string, unknown>>
  readonly fields: string[]
  readonly truncated: boolean
  readonly job: SearchJob | null

  constructor(fields: {
    sid?: string | null
    query: string
    time_range?: TimeRange | null
    count?: number
    total_available?: number
    results?: Array<Record<string, unknown>>
    fields?: string[]
    truncated?: boolean
    job?: SearchJob | null
  }) {
    this.sid = fields.sid ?? null
    this.query = fields.query
    this.time_range = fields.time_range ?? null
    this.count = fields.count ?? 0
    this.total_available = fields.total_available ?? 0
    this.results = fields.results ?? []
    this.fields = fields.fields ?? []
    this.truncated = fields.truncated ?? false
    this.job = fields.job ?? null
  }

  /** README §7 记录的稳定成功载荷。 */
  toPublicDict(): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      success: true,
      query: this.query,
    }
    if (this.time_range !== null) {
      payload['time_range'] = this.time_range.toPublicDict()
    }
    if (this.sid !== null && this.sid !== '') {
      payload['sid'] = this.sid
    }
    payload['count'] = this.count
    payload['truncated'] = this.truncated
    if (this.total_available !== 0) {
      payload['total_available'] = this.total_available
    }
    // The job's own facts: the absolute window it actually ran over, how long it
    // took, how much it scanned, whether sampling was on. All of it is read-only
    // metadata from the job the search already had to fetch, and without it a
    // caller cannot answer "what window did the expression `@mon` really mean".
    if (this.job !== null) {
      payload['job'] = this.job.toPublicDict()
    }
    if (this.fields.length > 0) {
      payload['fields'] = this.fields
    }
    payload['results'] = this.results
    return payload
  }
}

/** 可选整数：`null`/空串/无法解析都为 `null`。 */
function optInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

/** 可选布尔：接受 bool 与 `"1"`/`"true"`/`"yes"`。 */
function optBool(value: unknown): boolean | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return ['1', 'true', 'yes'].includes(value.trim().toLowerCase())
  if (typeof value === 'number') return value !== 0
  return null
}

/** 可选字符串：`null`/空串归为 `null`。 */
function optStr(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

/** `| fieldsummary` 发现的一个字段。 */
export class FieldSummary {
  readonly name: string
  readonly count: number | null
  readonly distinct_count: number | null
  readonly is_exact: boolean | null
  readonly numeric_count: number | null
  readonly max: string | null
  readonly min: string | null
  readonly mean: string | null
  readonly modes: Array<Record<string, unknown>>

  constructor(fields: {
    name: string
    count: number | null
    distinct_count: number | null
    is_exact: boolean | null
    numeric_count: number | null
    max: string | null
    min: string | null
    mean: string | null
    modes: Array<Record<string, unknown>>
  }) {
    this.name = fields.name
    this.count = fields.count
    this.distinct_count = fields.distinct_count
    this.is_exact = fields.is_exact
    this.numeric_count = fields.numeric_count
    this.max = fields.max
    this.min = fields.min
    this.mean = fields.mean
    this.modes = fields.modes
  }

  /** 从一行 `fieldsummary` 结果构造。值保持字符串——Splunk 对数值字段也回报字符串。 */
  static fromRow(row: Record<string, unknown>): FieldSummary {
    const modes: Array<Record<string, unknown>> = []
    const rawModes = row['modes']
    if (Array.isArray(rawModes)) {
      for (const item of rawModes) {
        if (typeof item === 'object' && item !== null) modes.push(item as Record<string, unknown>)
        else if (typeof item === 'string') modes.push({ value: item })
      }
    }
    return new FieldSummary({
      name: String(row['field'] ?? row['name'] ?? ''),
      count: optInt(row['count']),
      distinct_count: optInt(row['distinct_count']),
      is_exact: optBool(row['is_exact']),
      numeric_count: optInt(row['numeric_count']),
      max: optStr(row['max']),
      min: optStr(row['min']),
      mean: optStr(row['mean']),
      modes,
    })
  }

  toPublicDict(): Record<string, unknown> {
    return {
      name: this.name,
      count: this.count,
      distinct_count: this.distinct_count,
      is_exact: this.is_exact,
      numeric_count: this.numeric_count,
      max: this.max,
      min: this.min,
      mean: this.mean,
      modes: this.modes,
    }
  }
}

/** `splunk-cli fields` 的结果。 */
export class FieldList {
  readonly query: string
  readonly time_range: TimeRange | null
  readonly fields: string[]
  readonly details: FieldSummary[]

  constructor(fields: {
    query: string
    time_range?: TimeRange | null
    fields?: string[]
    details?: FieldSummary[]
  }) {
    this.query = fields.query
    this.time_range = fields.time_range ?? null
    this.fields = fields.fields ?? []
    this.details = fields.details ?? []
  }

  toPublicDict(): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      success: true,
      query: this.query,
      count: this.fields.length,
      fields: this.fields,
    }
    if (this.time_range !== null) {
      payload['time_range'] = this.time_range.toPublicDict()
    }
    if (this.details.length > 0) {
      payload['details'] = this.details.map((detail) => detail.toPublicDict())
    }
    return payload
  }
}

/** 一行 `| stats ... by <field>` 结果。 */
export class StatRow {
  readonly key: string | string[]
  readonly count: number

  constructor(fields: { key: string | string[]; count?: number }) {
    this.key = fields.key
    this.count = fields.count ?? 0
  }

  toPublicDict(): Record<string, unknown> {
    return { key: this.key, count: this.count }
  }
}

/** `splunk-cli stats` 的结果。 */
export class StatsResult {
  readonly query: string
  readonly spl: string
  readonly function: string
  readonly by: string[]
  readonly time_range: TimeRange | null
  readonly rows: StatRow[]
  readonly truncated: boolean

  constructor(fields: {
    query: string
    spl: string
    function?: string
    by?: string[]
    time_range?: TimeRange | null
    rows?: StatRow[]
    truncated?: boolean
  }) {
    this.query = fields.query
    this.spl = fields.spl
    this.function = fields.function ?? 'count'
    this.by = fields.by ?? []
    this.time_range = fields.time_range ?? null
    this.rows = fields.rows ?? []
    this.truncated = fields.truncated ?? false
  }

  toPublicDict(): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      success: true,
      query: this.query,
      spl: this.spl,
      function: this.function,
      by: this.by,
      count: this.rows.length,
      rows: this.rows.map((row) => row.toPublicDict()),
      truncated: this.truncated,
    }
    if (this.time_range !== null) {
      payload['time_range'] = this.time_range.toPublicDict()
    }
    return payload
  }
}

/** 一个 `| timechart span=...` 分桶。 */
export class TimelinePoint {
  readonly time: string
  readonly count: number

  constructor(fields: { time: string; count?: number }) {
    this.time = fields.time
    this.count = fields.count ?? 0
  }

  toPublicDict(): Record<string, unknown> {
    return { time: this.time, count: this.count }
  }
}

/** `splunk-cli timeline` 的结果。 */
export class TimelineResult {
  readonly query: string
  readonly spl: string
  readonly span: string
  readonly time_range: TimeRange | null
  readonly timeline: TimelinePoint[]
  readonly total: number

  constructor(fields: {
    query: string
    spl: string
    span: string
    time_range?: TimeRange | null
    timeline?: TimelinePoint[]
    total?: number
  }) {
    this.query = fields.query
    this.spl = fields.spl
    this.span = fields.span
    this.time_range = fields.time_range ?? null
    this.timeline = fields.timeline ?? []
    this.total = fields.total ?? 0
  }

  toPublicDict(): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      success: true,
      query: this.query,
      spl: this.spl,
      span: this.span,
      count: this.timeline.length,
      total: this.total,
      timeline: this.timeline.map((point) => point.toPublicDict()),
    }
    if (this.time_range !== null) {
      payload['time_range'] = this.time_range.toPublicDict()
    }
    return payload
  }
}
