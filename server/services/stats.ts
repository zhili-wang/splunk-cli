/**
 * Stats 服务。
 *
 * 对应未来的 `splunk_stats` 工具。生成的 SPL 只插值**已校验**的标识符，
 * 因此用户输入无法注入 SPL 命令。
 */

import { StatRow, StatsResult } from '../models/result'
import { buildStatsSpl, validateByFields, validateStatsFunction } from '../safety/validator'
import { BaseService } from './base'

/** Splunk 在 stats 结果行里给聚合值用的列名。 */
const METRIC_KEYS = ['count', 'dc(*)', 'sum(*)', 'avg(*)', 'min(*)', 'max(*)'] as const

/** 用 `| stats` 聚合事件。 */
export class StatsService extends BaseService {
  /** 按一个或多个字段聚合查询。 */
  async stats(
    query: string,
    options: {
      by?: string | null
      function?: string
      earliest?: string | null
      latest?: string | null
      limit?: number | null
    } = {},
  ): Promise<StatsResult> {
    const timeRange = this.resolveTimeRange(options.earliest, options.latest)
    const effectiveLimit = this.policy.check_limit(options.limit ?? null)
    const checkedQuery = this.policy.check_query_length(query)
    const fields = validateByFields(options.by ?? null)
    const aggregate = validateStatsFunction(options.function ?? 'count')

    const spl = buildStatsSpl(checkedQuery, { fn: aggregate, by: fields, limit: effectiveLimit })
    const outcome = await this.runSearch(spl, { timeRange, limit: effectiveLimit })

    const rows = outcome.rows.map(
      (row) => new StatRow({ key: rowKey(row, fields), count: rowMetric(row) }),
    )

    return new StatsResult({
      query: checkedQuery,
      spl,
      function: aggregate,
      by: fields,
      time_range: timeRange,
      rows,
      truncated: outcome.truncated,
    })
  }
}

/**
 * 从结果行里取出分组键。
 *
 * @returns 单字段分组返回该值字符串；多字段返回取值数组；未分组返回 `"*"`。
 */
export function rowKey(row: Record<string, unknown>, fields: string[]): string | string[] {
  if (fields.length === 0) return '*'
  const values = fields.map((field) => String(row[field] ?? ''))
  return values.length === 1 ? (values[0] ?? '') : values
}

/**
 * 从结果行里取出聚合值。
 *
 * Splunk 用函数名命名指标列（`count`、`dc(*)` …）。无法解析时降级为 0 而不是让查询失败。
 */
export function rowMetric(row: Record<string, unknown>): number {
  for (const key of METRIC_KEYS) {
    if (key in row) {
      const parsed = toFloat(row[key], 0)
      return parsed ?? 0
    }
  }
  // 兜底：第一个看起来是数字、且不属于分组字段的值。
  for (const value of Object.values(row)) {
    const parsed = toFloat(value, null)
    if (parsed !== null) return parsed
  }
  return 0
}

/** 把 Splunk 的指标值转成浮点；失败时返回 `fallback`。 */
function toFloat(value: unknown, fallback: number | null): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}
