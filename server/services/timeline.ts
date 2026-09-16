/**
 * Timeline 服务。
 *
 * 对应未来的 `splunk_timeline` 工具。
 */

import { TimelinePoint, TimelineResult } from '../models/result'
import { buildTimelineSpl } from '../safety/validator'
import { BaseService } from './base'

/** 默认分桶大小。 */
export const DEFAULT_SPAN = '5m'

/** 返回桶数的硬上限：细 span 配宽时间窗会淹掉 agent 的上下文。 */
export const MAX_BUCKETS = 500

/** 把事件量按时间分桶。 */
export class TimelineService extends BaseService {
  /** 返回某个查询的事件量时间线。 */
  async timeline(
    query: string,
    options: {
      span?: string
      earliest?: string | null
      latest?: string | null
      limit?: number | null
    } = {},
  ): Promise<TimelineResult> {
    const timeRange = this.resolveTimeRange(options.earliest, options.latest)
    const effectiveLimit = this.policy.check_limit(options.limit ?? null)
    const bucketLimit = effectiveLimit > 0 ? Math.min(effectiveLimit, MAX_BUCKETS) : MAX_BUCKETS
    const checkedQuery = this.policy.check_query_length(query)
    const checkedSpan = this.policy.check_span(options.span ?? DEFAULT_SPAN)

    const spl = buildTimelineSpl(checkedQuery, { span: checkedSpan, limit: bucketLimit })
    const outcome = await this.runSearch(spl, { timeRange, limit: bucketLimit })

    const points = outcome.rows.map((row) => toPoint(row))
    const total = points.reduce((sum, point) => sum + point.count, 0)

    return new TimelineResult({
      query: checkedQuery,
      spl,
      span: checkedSpan,
      time_range: timeRange,
      timeline: points,
      total,
    })
  }
}

/**
 * 把一个 `timechart` 行转成时间线点。
 *
 * 取 `_time` 之外的第一个数值列作为计数；未知列降级为 0。
 */
export function toPoint(row: Record<string, unknown>): TimelinePoint {
  const rawTime = row['_time']
  const timeValue = rawTime === null || rawTime === undefined ? '' : String(rawTime)

  for (const [key, value] of Object.entries(row)) {
    if (key === '_time') continue
    const parsed = coerceFloat(value)
    if (parsed !== null) return new TimelinePoint({ time: timeValue, count: parsed })
  }
  return new TimelinePoint({ time: timeValue, count: 0 })
}

/** 桶计数转浮点；不可解析返回 `null`。 */
function coerceFloat(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
