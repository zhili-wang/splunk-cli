/**
 * 告警服务。
 *
 * 只读：启用、禁用、修改、删除告警全部不在范围内，并被只读白名单挡住。
 *
 * `fired_alerts` 端点在 Splunk 9.2 已被移除，各 8.x 补丁版本行为也不一致。
 * 端点不可用时**降级为空列表 + note**，而不是让命令失败——给 agent 一个诚实的结构化
 * 答案（退出码仍为 0），而不是不明所以的错误。见 README §12。
 */

import { SplunkQueryError } from '../errors'
import { AlertList, FiredAlert, SavedSearch } from '../models/alert'
import { BaseService } from './base'

/** 告警返回条数的安全上限。 */
export const MAX_ALERTS = 500

/** 已保存搜索返回条数的安全上限。 */
export const MAX_SAVED_SEARCHES = 500

/** 列出已触发告警，可选同时列出已保存搜索。 */
export class AlertsService extends BaseService {
  /** 取已触发告警（可选已保存搜索）。 */
  async alerts(
    options: {
      count?: number | null
      includeSaved?: boolean
      savedCount?: number | null
    } = {},
  ): Promise<AlertList> {
    const includeSaved = options.includeSaved ?? false
    const limit = Math.min(this.policy.check_limit(options.count ?? null), MAX_ALERTS)

    let note: string | null = null
    let fired: FiredAlert[] = []
    let truncated = false
    try {
      const entries = await this.client.firedAlerts({ count: limit })
      fired = entries.map((entry) => FiredAlert.fromEntry(entry))
      truncated = entries.length >= limit
    } catch (error) {
      if (!(error instanceof SplunkQueryError)) throw error
      const status = error.details['status'] ?? 'error'
      note =
        'the fired-alerts endpoint is unavailable on this Splunk instance ' +
        `(HTTP ${String(status)}); no triggered alerts are reported`
    }

    let saved: SavedSearch[] = []
    if (includeSaved) {
      const savedLimit = Math.min(
        options.savedCount !== null && options.savedCount !== undefined
          ? this.policy.check_limit(options.savedCount)
          : limit,
        MAX_SAVED_SEARCHES,
      )
      const savedEntries = await this.client.savedSearches({ count: savedLimit })
      saved = savedEntries.map((entry) => SavedSearch.fromEntry(entry))
    }

    let source = includeSaved ? 'both' : 'fired_alerts'
    if (note !== null && !includeSaved) {
      source = 'unavailable'
    }

    return new AlertList({ fired, saved, source, truncated, note })
  }
}
