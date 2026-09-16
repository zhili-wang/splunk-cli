/**
 * Fields 服务。
 *
 * 对应未来的 `splunk_fields` 工具。agent 用它先摸清索引的 schema，再写后续 SPL。
 */

import { FieldList, FieldSummary } from '../models/result'
import { buildFieldsummarySpl } from '../safety/validator'
import { BaseService } from './base'

/** 返回字段数的安全上限。 */
export const MAX_FIELDS = 200

/** 用 `| fieldsummary` 列出可用字段。 */
export class FieldsService extends BaseService {
  /** 返回某个查询可用的字段名（以及可选的逐字段摘要）。 */
  async fields(
    query: string,
    options: {
      earliest?: string | null
      latest?: string | null
      limit?: number | null
      includeDetails?: boolean
    } = {},
  ): Promise<FieldList> {
    const timeRange = this.resolveTimeRange(options.earliest, options.latest)
    const effectiveLimit = this.policy.check_limit(options.limit ?? null)
    const fieldLimit = Math.min(effectiveLimit, MAX_FIELDS)
    const checkedQuery = this.policy.check_query_length(query)

    const spl = buildFieldsummarySpl(checkedQuery, { limit: fieldLimit })
    const outcome = await this.runSearch(spl, { timeRange, limit: fieldLimit })

    let summaries = outcome.rows.map((row) => FieldSummary.fromRow(row))
    summaries = summaries.filter((summary) => summary.name !== '')
    summaries.sort((a, b) => (b.count ?? 0) - (a.count ?? 0))

    return new FieldList({
      query: checkedQuery,
      time_range: timeRange,
      fields: summaries.map((summary) => summary.name),
      details: options.includeDetails === false ? [] : summaries,
    })
  }
}
