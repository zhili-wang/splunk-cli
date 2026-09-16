/**
 * 告警与已保存搜索模型。
 *
 * 只读：启用/禁用/修改/删除告警不在范围内，且被 `safety/limits.ts` 的白名单挡住。
 *
 * 注意 `toPublicDict()` 会剔除 `null`：**值为 `null` 的字段整个消失**。
 * 实测 `fired_alerts` fixture 里的条目最终只输出 `{name, severity, app}` 三个键——
 * 其余字段在数据里就是 `null`。这一条直接参与对拍。
 */

import { unixToIso } from './health'

/** 允许的严重级别（其它值会被映射或降级为 unknown）。 */
export const SEVERITY_LEVELS = ['info', 'low', 'medium', 'high', 'critical', 'unknown']

/** 数字严重级别到名称的映射（部分配置下 Splunk 返回 1..5）。 */
const NUMERIC_SEVERITY: Readonly<Record<string, string>> = {
  '1': 'info',
  '2': 'low',
  '3': 'medium',
  '4': 'high',
  '5': 'critical',
}

/** 按顺序取第一个非空值。 */
function first(content: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = content[key]
    if (value !== null && value !== undefined && value !== '') return value
  }
  return null
}

/** 读取 entry 的 `acl` 块字段。 */
function aclField(entry: Record<string, unknown>, key: string): unknown {
  const acl = entry['acl']
  if (typeof acl !== 'object' || acl === null) return null
  return (acl as Record<string, unknown>)[key]
}

function optStr(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

function optInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

/** 递归剔除 `null`。 */
function pruneNulls(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((item) => pruneNulls(item))
  if (typeof node === 'object' && node !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (value === null || value === undefined) continue
      out[key] = pruneNulls(value)
    }
    return out
  }
  return node
}

/** 一条已触发的告警（只读）。 */
export class FiredAlert {
  readonly name: string
  readonly sid: string | null
  readonly trigger_time: string | null
  readonly triggered_alerts: number | null
  readonly severity: string
  readonly app: string | null
  readonly saved_search_name: string | null
  readonly alert_type: string | null
  readonly expiration_time: string | null

  constructor(fields: {
    name: string
    sid: string | null
    trigger_time: string | null
    triggered_alerts: number | null
    severity: string
    app: string | null
    saved_search_name: string | null
    alert_type: string | null
    expiration_time: string | null
  }) {
    this.name = fields.name
    this.sid = fields.sid
    this.trigger_time = fields.trigger_time
    this.triggered_alerts = fields.triggered_alerts
    this.severity = fields.severity
    this.app = fields.app
    this.saved_search_name = fields.saved_search_name
    this.alert_type = fields.alert_type
    this.expiration_time = fields.expiration_time
  }

  /** 从 `fired_alerts` 的一个 entry 构造。 */
  static fromEntry(entry: Record<string, unknown>): FiredAlert {
    const rawContent = entry['content']
    const content: Record<string, unknown> =
      typeof rawContent === 'object' && rawContent !== null
        ? (rawContent as Record<string, unknown>)
        : {}

    const severityRaw = first(content, 'severity', 'alert.severity')
    let severity = severityRaw !== null ? String(severityRaw).toLowerCase() : 'unknown'
    if (!SEVERITY_LEVELS.includes(severity)) {
      // 部分配置下 Splunk 返回数字严重级别（1..5）。
      severity = NUMERIC_SEVERITY[severity] ?? 'unknown'
    }

    return new FiredAlert({
      name: String(entry['name'] ?? '<unnamed>'),
      sid: optStr(first(content, 'sid', 'triggered_alerts_sid')),
      trigger_time: unixToIso(first(content, 'trigger_time', 'trigger_time_rendered')),
      triggered_alerts: optInt(content['triggered_alerts']),
      severity,
      app: optStr(aclField(entry, 'app')) ?? optStr(first(content, 'app', 'saved_search_app')),
      saved_search_name: optStr(content['savedsearch_name']),
      alert_type: optStr(content['alert_type']),
      expiration_time: unixToIso(content['expiration_time']),
    })
  }

  toPublicDict(): Record<string, unknown> {
    return pruneNulls({ ...this }) as Record<string, unknown>
  }
}

/** 一条已保存搜索 / 告警定义（只读）。 */
export class SavedSearch {
  readonly name: string
  readonly app: string | null
  readonly owner: string | null
  readonly disabled: boolean | null
  readonly cron_schedule: string | null
  readonly is_scheduled: boolean | null
  readonly alert_type: string | null
  readonly alert_severity: string | null
  readonly alert_comparator: string | null
  readonly alert_threshold: string | null
  readonly description: string | null
  readonly next_scheduled_time: string | null

  constructor(fields: {
    name: string
    app: string | null
    owner: string | null
    disabled: boolean | null
    cron_schedule: string | null
    is_scheduled: boolean | null
    alert_type: string | null
    alert_severity: string | null
    alert_comparator: string | null
    alert_threshold: string | null
    description: string | null
    next_scheduled_time: string | null
  }) {
    this.name = fields.name
    this.app = fields.app
    this.owner = fields.owner
    this.disabled = fields.disabled
    this.cron_schedule = fields.cron_schedule
    this.is_scheduled = fields.is_scheduled
    this.alert_type = fields.alert_type
    this.alert_severity = fields.alert_severity
    this.alert_comparator = fields.alert_comparator
    this.alert_threshold = fields.alert_threshold
    this.description = fields.description
    this.next_scheduled_time = fields.next_scheduled_time
  }

  /** 从 `saved/searches` 的一个 entry 构造。 */
  static fromEntry(entry: Record<string, unknown>): SavedSearch {
    const rawContent = entry['content']
    const content: Record<string, unknown> =
      typeof rawContent === 'object' && rawContent !== null
        ? (rawContent as Record<string, unknown>)
        : {}
    const optBool = (value: unknown): boolean | null => {
      if (typeof value === 'boolean') return value
      if (value === '1' || value === 1) return true
      if (value === '0' || value === 0) return false
      return null
    }
    return new SavedSearch({
      name: String(entry['name'] ?? content['name'] ?? '<unnamed>'),
      app:
        optStr(aclField(entry, 'app')) ??
        optStr(content['request.ui_dispatch_app']) ??
        optStr(content['app']),
      owner: optStr(aclField(entry, 'owner')),
      disabled: optBool(content['disabled']),
      cron_schedule: optStr(content['cron_schedule']),
      is_scheduled: optBool(content['is_scheduled']),
      alert_type: optStr(content['alert_type']),
      alert_severity: optStr(content['alert.severity']),
      alert_comparator: optStr(content['alert_comparator']),
      alert_threshold: optStr(content['alert_threshold']),
      description: optStr(content['description']),
      next_scheduled_time: optStr(content['next_scheduled_time']),
    })
  }

  toPublicDict(): Record<string, unknown> {
    return pruneNulls({ ...this }) as Record<string, unknown>
  }
}

/** `splunk-cli alerts` 的结果。 */
export class AlertList {
  readonly fired: FiredAlert[]
  readonly saved: SavedSearch[]
  readonly source: string
  readonly truncated: boolean
  readonly note: string | null

  constructor(fields: {
    fired?: FiredAlert[]
    saved?: SavedSearch[]
    source: string
    truncated?: boolean
    note?: string | null
  }) {
    this.fired = fields.fired ?? []
    this.saved = fields.saved ?? []
    this.source = fields.source
    this.truncated = fields.truncated ?? false
    this.note = fields.note ?? null
  }

  toPublicDict(): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      success: true,
      source: this.source,
      count: this.fired.length,
      alerts: this.fired.map((alert) => alert.toPublicDict()),
      truncated: this.truncated,
    }
    if (this.saved.length > 0) {
      payload['saved_searches'] = this.saved.map((saved) => saved.toPublicDict())
      payload['saved_count'] = this.saved.length
    }
    if (this.note !== null && this.note !== '') {
      payload['note'] = this.note
    }
    return payload
  }
}
