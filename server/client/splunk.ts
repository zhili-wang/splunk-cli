/**
 * Splunk REST 客户端。
 *
 * 职责边界（AGENTS.md §3）：本层只说 REST 与 Job 轮询，**绝不格式化输出、绝不决定策略**。
 * 安全上限由 Service 层的 `SafetyPolicy` 决定；这里只执行。
 */

import { HttpClient, type DispatcherLike, type FetchLike } from './http'
import type { Settings } from '../config/settings'
import {
  SplunkError,
  SplunkJobError,
  SplunkQueryError,
  SplunkResultError,
  SplunkTimeoutError,
} from '../errors'
import { formatG } from '../format'
import { debug } from '../logger'
import { ServerInfo } from '../models/health'
import { SearchJob } from '../models/search'

/** 视为失败的 dispatch 状态。 */
export const FAILED_DISPATCH_STATES: ReadonlySet<string> = new Set([
  'FAILED',
  'INTERNAL_ERROR',
  'PAUSED',
])

/** 轮询次数的硬上限：即使时钟异常也保证终止。 */
const MAX_POLLS_BACKSTOP = 100_000

/** 构造客户端时可注入的依赖（测试用）。 */
export interface SplunkClientOptions {
  fetch?: FetchLike
  dispatcher?: DispatcherLike
  readCaBundle?: (path: string) => string
}

/**
 * 归一化用户查询，用于 `search` 表单字段。
 *
 * ⚠ **这里刻意保留了一个已知缺陷，不要"顺手修好"。**
 *
 * 当前实现对以 `|` 开头的查询**加上** `search ` 前缀，
 * 与函数注释恰好相反，于是 `| tstats count` 变成
 * `search | tstats count`，被 Splunk 以 "This command must be the first command of a search"
 * 拒绝。实测影响 `| tstats` / `| makeresults`（`| stats` 因可处于管道中段而侥幸可用）。
 *
 * ADR Q12 已决策：**先钉住当前行为**，以便对拍可机检；修复作为独立的
 * 后续改动另行排期，之后一起改。详见 ADR §5.10。
 *
 * @param query 原始输入。
 * @returns 发往 Splunk 的查询文本。
 */
export function normaliseQuery(query: string): string {
  const text = query.trim()
  if (text === '') {
    throw new SplunkQueryError('search query is empty')
  }

  if (text.startsWith('|')) {
    // ← 缺陷所在：按函数注释应当**不加**前缀。Q12 决策：此处保持当前行为。
    return `search ${text}`
  }

  const firstToken = text.split(/\s+/)[0]?.toLowerCase() ?? ''
  // 已经是生成式命令（search / tstats / from / makeresults ...）
  if (!firstToken.includes('=')) {
    return text
  }
  return `search ${text}`
}

/** 从集合响应里取出 `entry` 对象；畸形条目被跳过而不是让整个列举失败。 */
export function entries(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = payload['entry']
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 只读的 Splunk REST 客户端。 */
export class SplunkClient {
  readonly #http: HttpClient
  readonly #settings: Settings

  constructor(settings: Settings, options: SplunkClientOptions = {}) {
    this.#settings = settings
    this.#http = new HttpClient({
      base_url: settings.effective_url,
      username: settings.username,
      password: settings.password,
      timeout: settings.timeout,
      verify_ssl: settings.verify_ssl,
      ca_bundle: settings.ca_bundle,
      max_retries: settings.max_retries,
      retry_backoff: settings.retry_backoff,
      trust_env: settings.trust_env,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.dispatcher !== undefined ? { dispatcher: options.dispatcher } : {}),
      ...(options.readCaBundle !== undefined ? { readCaBundle: options.readCaBundle } : {}),
    })
  }

  /** 底层传输层（仅供诊断；Service 层不应绕过本类直接用它构造请求）。 */
  get http(): HttpClient {
    return this.#http
  }

  /** 生效中的配置。 */
  get settings(): Settings {
    return this.#settings
  }

  /** 关闭连接池。 */
  async close(): Promise<void> {
    await this.#http.close()
  }

  // ------------------------------------------------------------------ //
  // 探针端点
  // ------------------------------------------------------------------ //

  /**
   * 取 `GET /services/server/info`。
   *
   * 它同时是**认证探针**：该端点需要有效凭据，所以调用成功即证明连通性与认证都正常。
   * 认证走真实业务端点，而不是 `/services/auth/login`（README §5）。
   */
  async serverInfo(): Promise<ServerInfo> {
    const payload = await this.#http.get('/services/server/info', { output_mode: 'json' })
    return ServerInfo.fromApi(payload)
  }

  /**
   * 取 `GET /services/licenser/pools` 的粗粒度 license 视图。
   *
   * 失败**优雅降级**为 `status="unknown"` 而不是抛错：缺 license 视图不该让
   * `splunk-cli health` 整个失败（README §12 记录的已知限制）。
   */
  async licenseInfo(): Promise<Record<string, unknown>> {
    let payload: Record<string, unknown>
    try {
      payload = await this.#http.get('/services/licenser/pools', { output_mode: 'json' })
    } catch (error) {
      const errorType = error instanceof SplunkError ? error.errorType : 'SplunkError'
      debug('splunk', `license info unavailable: ${errorType}`)
      return { status: 'unknown', pools: [], reason: errorType }
    }

    const entries = payload['entry']
    const pools: Array<Record<string, unknown>> = []
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null) continue
        const record = entry as Record<string, unknown>
        const content = record['content']
        if (typeof content !== 'object' || content === null) continue
        const fields = content as Record<string, unknown>
        pools.push({
          name: record['name'] ?? null,
          stack_size: fields['stack_size'] ?? null,
          used_bytes: fields['used_bytes'] ?? null,
          quota: fields['quota'] ?? null,
        })
      }
    }
    return { status: 'ok', pools }
  }

  // ------------------------------------------------------------------ //
  // 搜索 Job
  // ------------------------------------------------------------------ //

  /**
   * 创建搜索 Job（`POST /services/search/jobs`）。
   *
   * 创建查询属于读取行为，所以它在只读白名单内。
   */
  async createSearchJob(
    query: string,
    options: {
      earliestTime?: string | null
      latestTime?: string | null
      execMode?: string
      maxCount?: number | null
    } = {},
  ): Promise<string> {
    const body: Record<string, unknown> = {
      search: normaliseQuery(query),
      exec_mode: options.execMode ?? 'normal',
      output_mode: 'json',
    }
    if (options.earliestTime !== null && options.earliestTime !== undefined) {
      body['earliest_time'] = options.earliestTime
    }
    if (options.latestTime !== null && options.latestTime !== undefined) {
      body['latest_time'] = options.latestTime
    }
    if (options.maxCount !== null && options.maxCount !== undefined) {
      body['max_count'] = options.maxCount
    }

    const payload = await this.#http.post('/services/search/jobs', body)
    const sid = payload['sid']
    if (typeof sid !== 'string' || sid === '') {
      throw new SplunkResultError(
        'Splunk accepted the search request but returned no search id (sid)',
        { details: { keys: Object.keys(payload).sort().slice(0, 20) } },
      )
    }
    debug('splunk', `created search job sid=${sid}`)
    return sid
  }

  /** 查询 Job 状态（`GET /services/search/jobs/{sid}`）。 */
  async getSearchJob(sid: string): Promise<SearchJob> {
    const payload = await this.#http.get(`/services/search/jobs/${encodeURIComponent(sid)}`, {
      output_mode: 'json',
    })
    return SearchJob.fromApi(sid, payload)
  }

  /** 取结果页（`GET /services/search/jobs/{sid}/results`）。 */
  async getSearchResults(
    sid: string,
    options: { count?: number; offset?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const payload = await this.#http.get(
      `/services/search/jobs/${encodeURIComponent(sid)}/results`,
      {
        output_mode: 'json',
        count: options.count ?? 100,
        offset: options.offset ?? 0,
      },
    )
    const results = payload['results']
    if (results === null || results === undefined) {
      // 空结果集是合法的，报成 []。
      return []
    }
    if (!Array.isArray(results)) {
      throw new SplunkResultError(`expected 'results' to be a list, got ${typeof results}`)
    }
    return results.map((row, index) => {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        throw new SplunkResultError(
          `expected each search result to be a JSON object, got ${typeof row} at index ${index}`,
        )
      }
      return row as Record<string, unknown>
    })
  }

  /**
   * 取 Job 消息（`GET /services/search/jobs/{sid}/messages`）。
   *
   * 实测 Splunk 8.0.2 上该端点返回 **404 Unknown endpoint**；这里降级为空列表
   * 而不是报错（ADR §5.11）。是否把 `content.messages` 提升进错误信息
   * 由 Q13 决定，不得在此自行"优化"。
   */
  async getSearchMessages(sid: string): Promise<Array<Record<string, unknown>>> {
    let payload: Record<string, unknown>
    try {
      payload = await this.#http.get(`/services/search/jobs/${encodeURIComponent(sid)}/messages`, {
        output_mode: 'json',
      })
    } catch {
      return []
    }
    const messages = payload['messages']
    if (!Array.isArray(messages)) return []
    return messages.filter(
      (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
    )
  }

  /** 删除 Job 是写操作：Phase 1 严格只读，这里只用于记录边界。 */
  deleteSearchJob(): never {
    throw new SplunkJobError('deleting search jobs is not permitted: Splunk CLI is read-only')
  }

  /**
   * 轮询 Job 直到完成、失败或预算耗尽。
   *
   * 预算取 `max(timeout ?? settings.effective_search_timeout)`——注意
   * `effective_search_timeout` 本身是 `max(search_timeout, timeout)`，所以只调小
   * `SPLUNK_SEARCH_TIMEOUT` 而不动 `SPLUNK_TIMEOUT` 是不会生效的。
   */
  async waitForSearch(
    sid: string,
    options: {
      timeout?: number | null
      pollInterval?: number | null
      maxPolls?: number | null
      onPoll?: (job: SearchJob) => void
    } = {},
  ): Promise<SearchJob> {
    const budget = Number(options.timeout ?? this.#settings.effective_search_timeout)
    const interval = Number(options.pollInterval ?? this.#settings.poll_interval)
    if (interval <= 0) {
      throw new SplunkJobError('poll_interval must be greater than zero')
    }

    const requestedCap =
      options.maxPolls !== null && options.maxPolls !== undefined
        ? options.maxPolls
        : Math.trunc(budget / interval) + 5
    const pollCap = Math.max(1, Math.min(requestedCap, MAX_POLLS_BACKSTOP))

    const deadline = Date.now() + budget * 1000
    let polls = 0
    let job: SearchJob | null = null

    while (polls < pollCap) {
      job = await this.getSearchJob(sid)
      polls += 1
      options.onPoll?.(job)

      if (job.is_failed) {
        const messages = await this.getSearchMessages(sid)
        const detail = messages
          .map((entry) => entry['text'])
          .filter((text): text is string => typeof text === 'string')
          .join(' | ')
        const message =
          `search job ${sid} failed (dispatchState=${job.dispatch_state})` +
          (detail !== '' ? `: ${detail}` : '')
        throw new SplunkJobError(message, {
          details: { sid, dispatch_state: job.dispatch_state, polls },
        })
      }

      if (job.is_cancelled) {
        throw new SplunkJobError(`search job ${sid} was cancelled before completion`, {
          details: { sid, dispatch_state: job.dispatch_state },
        })
      }

      if (job.is_done) return job

      if (Date.now() >= deadline) break

      // 绝不睡过截止时间。
      const remaining = deadline - Date.now()
      await sleep(Math.min(interval * 1000, Math.max(remaining, 0)))
    }

    const state = job === null ? 'UNKNOWN' : job.dispatch_state
    throw new SplunkTimeoutError(
      `search job ${sid} did not finish within ${formatG(budget)}s ` +
        `(${polls} status checks, last dispatchState=${state})`,
      { details: { sid, polls, dispatch_state: state, timeout: budget } },
    )
  }

  // ------------------------------------------------------------------ //
  // 只读列举端点
  // ------------------------------------------------------------------ //

  /** 列举已保存搜索/告警（`GET /services/saved/searches`）。 */
  async savedSearches(options: { count?: number; offset?: number } = {}): Promise<Array<Record<string, unknown>>> {
    const payload = await this.#http.get('/services/saved/searches', {
      output_mode: 'json',
      count: options.count ?? 100,
      offset: options.offset ?? 0,
    })
    return entries(payload)
  }

  /** 列举已触发告警（`GET /services/alerts/fired_alerts`）。 */
  async firedAlerts(options: { count?: number; offset?: number } = {}): Promise<Array<Record<string, unknown>>> {
    const payload = await this.#http.get('/services/alerts/fired_alerts', {
      output_mode: 'json',
      count: options.count ?? 100,
      offset: options.offset ?? 0,
    })
    return entries(payload)
  }
}
