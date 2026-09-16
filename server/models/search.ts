/**
 * 搜索相关模型（`TimeRange` 与 `SearchJob`）。
 *
 * 每个 `toPublicDict()` 都是**公开契约**：键名与顺序对应对拍逐字段比较，
 * 不是"随便挑几个字段"。
 */

import { SplunkJobError } from '../errors'

/** 停止推进的 dispatch 状态。 */
export const TERMINAL_DISPATCH_STATES: ReadonlySet<string> = new Set([
  'DONE',
  'FAILED',
  'INTERNAL_ERROR',
  'PAUSED',
  'CANCELLED',
])

/** Splunk 把布尔值编码成 JSON bool 或 `"1"`/`"0"` 字符串，两种都要吃下。 */
export function asBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return ['1', 'true', 'yes'].includes(value.trim().toLowerCase())
  return false
}

/** 把 Splunk 的数值字段转成整数，无法解释时为 0。 */
export function asInt(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0
  }
  return 0
}

/** 可选浮点：`null`/空串/无法解析都得到 `null`。 */
export function optFloat(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** 可选整数。 */
export function optInt(value: unknown): number | null {
  const parsed = optFloat(value)
  return parsed === null ? null : Math.trunc(parsed)
}

/**
 * 可选字符串。
 *
 * Splunk 的同一字段在不同版本里可能是数字或字符串（`sampleRatio` 实测是 `"1"`），
 * 所以按"有值就转成文本、空值给 `''`"处理，不额外猜测类型。
 */
export function optString(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
}

/** 请求的搜索时间窗，原样回显在 JSON 输出里。 */
export class TimeRange {
  readonly earliest: string
  readonly latest: string
  readonly duration_seconds: number | null

  constructor(fields: { earliest: string; latest: string; duration_seconds?: number | null }) {
    this.earliest = fields.earliest
    this.latest = fields.latest
    this.duration_seconds = fields.duration_seconds ?? null
  }

  /** 稳定的公开 JSON 视图。 */
  toPublicDict(): Record<string, unknown> {
    const payload: Record<string, unknown> = { earliest: this.earliest, latest: this.latest }
    if (this.duration_seconds !== null) {
      payload['duration_seconds'] = this.duration_seconds
    }
    return payload
  }
}

/** 搜索 Job 的状态。 */
export class SearchJob {
  readonly sid: string
  readonly dispatch_state: string
  readonly is_done: boolean
  readonly is_failed: boolean
  readonly is_finalized: boolean
  readonly is_paused: boolean
  readonly result_count: number
  readonly event_count: number
  readonly scan_count: number
  readonly done_progress: number
  readonly run_duration: number | null
  readonly ttl: number | null
  readonly messages: Array<Record<string, unknown>>
  /**
   * Splunk 实际执行的时间窗（epoch 秒）。
   *
   * 请求里的 `-1mon@mon` / `now` 是**表达式**，只有 Splunk 知道它落到了哪两个瞬间。
   * 这两个字段就是答案，也是面板上"1,125 个事件 (… 至 …)"括号里的内容。`null` 表示
   * 服务端没给出（例如 Job 还没走到能解析时间窗的阶段）。
   */
  readonly search_earliest_time: number | null
  readonly search_latest_time: number | null
  /**
   * Job 的事件采样比，原样保存（`"1"` = 未采样）。
   *
   * 存它是为了让"这份结果是不是抽样得到的"可被回答——采样会让计数变成近似值，
   * 而近似值必须能被识别出来，不能悄悄混进结论。
   */
  readonly sample_ratio: string

  constructor(fields: {
    sid: string
    dispatch_state: string
    is_done: boolean
    is_failed: boolean
    is_finalized: boolean
    is_paused: boolean
    result_count: number
    event_count: number
    scan_count: number
    done_progress: number
    run_duration: number | null
    ttl: number | null
    messages: Array<Record<string, unknown>>
    search_earliest_time?: number | null
    search_latest_time?: number | null
    sample_ratio?: string
  }) {
    this.sid = fields.sid
    this.dispatch_state = fields.dispatch_state
    this.is_done = fields.is_done
    this.is_failed = fields.is_failed
    this.is_finalized = fields.is_finalized
    this.is_paused = fields.is_paused
    this.result_count = fields.result_count
    this.event_count = fields.event_count
    this.scan_count = fields.scan_count
    this.done_progress = fields.done_progress
    this.run_duration = fields.run_duration
    this.ttl = fields.ttl
    this.messages = fields.messages
    this.search_earliest_time = fields.search_earliest_time ?? null
    this.search_latest_time = fields.search_latest_time ?? null
    this.sample_ratio = fields.sample_ratio ?? ''
  }

  /** Splunk 是否报告该 Job 已取消。 */
  get is_cancelled(): boolean {
    const state = this.dispatch_state.toUpperCase()
    return state === 'CANCELLED' || state === 'CANCELED'
  }

  /** Job 是否已停止推进。 */
  get is_terminal(): boolean {
    return TERMINAL_DISPATCH_STATES.has(this.dispatch_state.toUpperCase())
  }

  /**
   * 从 `GET /services/search/jobs/{sid}` 的响应构造。
   *
   * 接受集合形态（`entry[0].content`）与扁平 content 对象；
   * 有些代理/替身会把 content 字段放在顶层，也一并接受。
   */
  static fromApi(sid: string, payload: Record<string, unknown>): SearchJob {
    let content: Record<string, unknown> = {}
    const entries = payload['entry']
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (typeof entry === 'object' && entry !== null) {
          const candidate = (entry as Record<string, unknown>)['content']
          if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
            content = candidate as Record<string, unknown>
            break
          }
        }
      }
    } else if (typeof payload['content'] === 'object' && payload['content'] !== null) {
      content = payload['content'] as Record<string, unknown>
    } else if (Object.keys(payload).length > 0) {
      const skipped = new Set([
        'links',
        'origin',
        'updated',
        'generator',
        'paging',
        'messages',
      ])
      content = Object.fromEntries(
        Object.entries(payload).filter(([key]) => !skipped.has(key)),
      )
    }

    if (Object.keys(content).length === 0 && !payload['entry']) {
      throw new SplunkJobError(`no search job found for sid ${sid}`, { details: { sid } })
    }

    const rawMessages = content['messages']
    const messages: Array<Record<string, unknown>> = Array.isArray(rawMessages)
      ? rawMessages.filter(
          (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
        )
      : []

    const dispatchState = String(content['dispatchState'] ?? content['dispatch_state'] ?? '')

    return new SearchJob({
      sid,
      dispatch_state: dispatchState.toUpperCase() || 'UNKNOWN',
      is_done: asBool(content['isDone']),
      is_failed: asBool(content['isFailed']),
      is_finalized: asBool(content['isFinalized']),
      is_paused: asBool(content['isPaused']),
      result_count: asInt(content['resultCount']),
      event_count: asInt(content['eventCount']),
      scan_count: asInt(content['scanCount']),
      done_progress: Number(content['doneProgress'] ?? 0) || 0,
      run_duration: optFloat(content['runDuration']),
      ttl: optInt(content['ttl']),
      messages,
      search_earliest_time: optInt(content['searchEarliestTime']),
      search_latest_time: optInt(content['searchLatestTime']),
      sample_ratio: optString(content['sampleRatio'] ?? content['sample_ratio']),
    })
  }

  /** 稳定的公开 JSON 视图（`--json` 输出用）。 */
  toPublicDict(): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      sid: this.sid,
      dispatch_state: this.dispatch_state,
      is_done: this.is_done,
      is_failed: this.is_failed,
      is_finalized: this.is_finalized,
      done_progress: Math.round(this.done_progress * 10_000) / 10_000,
      result_count: this.result_count,
      event_count: this.event_count,
      scan_count: this.scan_count,
      run_duration: this.run_duration,
    }
    // 只在服务端真的给出时间窗时才出现：`null` 说明"不知道"，而不是"没有窗口"。
    if (this.search_earliest_time !== null) payload['search_earliest_time'] = this.search_earliest_time
    if (this.search_latest_time !== null) payload['search_latest_time'] = this.search_latest_time
    if (this.sample_ratio !== '') payload['sample_ratio'] = this.sample_ratio
    return payload
  }
}
