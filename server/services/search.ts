/**
 * 搜索服务。
 *
 * 这是面向 agent 的主要查询能力，对应未来的 `splunk_search` 工具：
 *
 * ```text
 * SearchService.search(query, { earliest, latest, limit }) -> ResultSet
 * ```
 *
 * 签名稳定是契约的一部分（AGENTS.md §8）：MCP 层只包装本层，绝不直接碰 client。
 */

import { ResultSet } from '../models/result'
import { BaseService } from './base'

/** 执行有界、只读的 SPL 搜索。 */
export class SearchService extends BaseService {
  /**
   * 执行搜索并返回结构化结果集。
   *
   * @param query SPL 查询，可带或不带前导 `search`。
   * @param options.earliest 下界，如 `-1h`；默认 `-1h`。
   * @param options.latest 上界，如 `now`；默认 `now`。
   * @param options.limit 最大行数；默认取 `max_results`，超过即拒绝。
   */
  async search(
    query: string,
    options: {
      earliest?: string | null
      latest?: string | null
      limit?: number | null
    } = {},
  ): Promise<ResultSet> {
    const timeRange = this.resolveTimeRange(options.earliest, options.latest)
    const effectiveLimit = this.policy.check_limit(options.limit ?? null)
    const checkedQuery = this.policy.check_query_length(query)

    const outcome = await this.runSearch(checkedQuery, {
      timeRange,
      limit: effectiveLimit,
    })

    return new ResultSet({
      sid: outcome.job.sid,
      query: checkedQuery,
      time_range: timeRange,
      count: outcome.rows.length,
      total_available: outcome.total_available,
      results: outcome.rows,
      fields: outcome.fields,
      truncated: outcome.truncated,
      job: outcome.job,
    })
  }
}
