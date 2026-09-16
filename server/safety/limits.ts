/**
 * 查询上限与只读安全策略。
 *
 * Phase 1 严格只读。本模块持有数值上限（结果数、时间跨度、查询长度）与端点白名单，
 * 并且**绝不静默改写用户输入**：超限一律以结构化的 `SafetyLimitError` 拒绝，
 * 由调用方显式决定怎么办（AGENTS.md §4）。
 */

import { parseDuration } from '../config/settings'
import { SplunkError } from '../errors'
import { formatG } from '../format'

/** 绝不允许发出的 HTTP 方法。 */
export const FORBIDDEN_METHODS: ReadonlySet<string> = new Set(['DELETE', 'PUT', 'PATCH', 'HEAD'])

/** Phase 1 明确允许的端点。 */
export const ALLOWED_ENDPOINTS: ReadonlySet<string> = new Set([
  '/services/server/info',
  '/services/licenser/pools',
  '/services/search/jobs',
  '/services/saved/searches',
  '/services/alerts/fired_alerts',
])

/** 允许按前缀匹配的参数化端点（按 sid 查询搜索 Job）。 */
export const ALLOWED_PREFIXES: readonly string[] = ['/services/search/jobs/']

/** 即使在允许前缀下也一律拒绝的路径片段。 */
export const FORBIDDEN_PATH_FRAGMENTS: readonly string[] = [
  '/services/search/jobs/export',
  '/services/data/',
  '/services/admin/',
  '/services/authentication/',
  '/services/authorization/',
  '/services/configs/',
  '/services/deployment',
  '/services/cluster',
  '/services/apps/local',
  '/services/apps/install',
  '/services/shcluster',
  '/services/licenser/licenses',
  '/services/licenser/groups',
  '/services/licenser/messages',
  '/services/licenser/slaves',
]

/** 请求会超出安全上限或违反只读模式。稳定的错误类型，映射退出码 6。 */
export class SafetyLimitError extends SplunkError {
  override readonly errorType: string = 'SafetyLimitError'

  constructor(message: string, options: { details?: Record<string, unknown> } = {}) {
    super(message, options)
    this.name = 'SafetyLimitError'
  }
}

/**
 * 每次查询都要强制执行的不可变上限集合。
 */
export class SafetyPolicy {
  readonly max_results: number
  readonly max_time_range_seconds: number
  readonly max_query_length: number
  readonly read_only: boolean

  constructor(fields: {
    max_results?: number
    max_time_range_seconds?: number
    max_query_length?: number
    read_only?: boolean
  } = {}) {
    this.max_results = fields.max_results ?? 5000
    this.max_time_range_seconds = fields.max_time_range_seconds ?? 7 * 86400
    this.max_query_length = fields.max_query_length ?? 10_000
    this.read_only = fields.read_only ?? true
  }

  /** 由配置构建策略。 */
  static fromSettings(settings: {
    max_results: number
    max_time_range_seconds: number
    max_query_length: number
  }): SafetyPolicy {
    return new SafetyPolicy({
      max_results: settings.max_results,
      max_time_range_seconds: settings.max_time_range_seconds,
      max_query_length: settings.max_query_length,
      read_only: true,
    })
  }

  /**
   * 校验请求的结果条数上限。
   *
   * @param limit 请求条数；`undefined` 表示用策略默认值。
   */
  check_limit(limit: number | null | undefined): number {
    if (limit === null || limit === undefined) return this.max_results
    if (limit <= 0) {
      throw new SafetyLimitError(`limit must be a positive integer (got ${limit})`, {
        details: { limit, max_results: this.max_results },
      })
    }
    if (limit > this.max_results) {
      throw new SafetyLimitError(
        `requested limit ${limit} exceeds the maximum allowed ` +
          `${this.max_results} results; narrow the query or raise SPLUNK_MAX_RESULTS`,
        { details: { limit, max_results: this.max_results } },
      )
    }
    return limit
  }

  /**
   * 校验搜索时间窗宽度。
   *
   * @param seconds 已解析的宽度；`null` 表示无法静态判定（交给服务端兜底）。
   */
  check_time_range(seconds: number | null, options: { earliest: string; latest: string }): void {
    if (seconds === null) return
    const { earliest, latest } = options
    if (seconds < 0) {
      throw new SafetyLimitError(`earliest (${earliest}) is later than latest (${latest})`, {
        details: { earliest, latest },
      })
    }
    if (seconds > this.max_time_range_seconds) {
      throw new SafetyLimitError(
        `requested time range of ${formatG(seconds)}s exceeds the maximum allowed ` +
          `range of ${formatG(this.max_time_range_seconds)}s ` +
          `(earliest=${earliest}, latest=${latest})`,
        {
          details: {
            earliest,
            latest,
            requested_seconds: seconds,
            max_time_range_seconds: this.max_time_range_seconds,
          },
        },
      )
    }
  }

  /** 校验 SPL 长度；返回去掉首尾空白后的查询。 */
  check_query_length(query: string): string {
    const text = query.trim()
    if (text === '') {
      throw new SafetyLimitError('search query is empty')
    }
    if (text.length > this.max_query_length) {
      throw new SafetyLimitError(
        `query length ${text.length} exceeds the maximum allowed ` +
          `${this.max_query_length} characters`,
        { details: { length: text.length, max_query_length: this.max_query_length } },
      )
    }
    return text
  }

  /** 校验 `timechart` 的 span 字面量。 */
  check_span(span: string): string {
    // span 是宽度，显式正负号在此不合法。
    if (span.trim().startsWith('-') || span.trim().startsWith('+') || parseDuration(span) === null) {
      throw new SafetyLimitError(
        `invalid span '${span}': expected a positive fixed duration such as ` +
          '30s, 5m, 1h or 1d',
        { details: { span } },
      )
    }
    return span
  }

  /** 断言请求在只读模式下被允许。 */
  check_read_only(method: string, path: string): void {
    if (!this.read_only) return
    const upper = method.toUpperCase()
    if (FORBIDDEN_METHODS.has(upper)) {
      throw new SafetyLimitError(
        `${upper} ${path} is not permitted: Splunk CLI is strictly read-only`,
        { details: { method: upper, path } },
      )
    }

    const withoutQuery = path.split('?')[0] ?? path
    const normalised = withoutQuery.replace(/\/+$/, '') || '/'
    for (const fragment of FORBIDDEN_PATH_FRAGMENTS) {
      const trimmed = fragment.replace(/\/+$/, '')
      if (normalised.startsWith(trimmed)) {
        throw new SafetyLimitError(
          `endpoint ${normalised} is not permitted: Splunk CLI is strictly read-only`,
          { details: { method: upper, path: normalised } },
        )
      }
    }

    if (ALLOWED_ENDPOINTS.has(normalised)) return
    if (ALLOWED_PREFIXES.some((prefix) => normalised.startsWith(prefix))) return
    throw new SafetyLimitError(`endpoint ${normalised} is not on the read-only allow-list`, {
      details: { method: upper, path: normalised },
    })
  }

  /** 生效中的上限，供诊断输出。 */
  toPublicDict(): Record<string, unknown> {
    return {
      max_results: this.max_results,
      max_time_range_seconds: this.max_time_range_seconds,
      max_query_length: this.max_query_length,
      read_only: this.read_only,
    }
  }
}

/**
 * `splunk-cli limits` 的载荷：安全上限 **加上** 搜索 Job 的运行预算。
 *
 * 前四个键由 {@link SafetyPolicy} 的 `check_*` 强制执行；`timeout` / `search_timeout` /
 * `poll_interval` 是运行参数，不由它校验，但同属"当前生效的护栏"——只有放在同一张表里，
 * 调用方才能判断一次查询最多等多久、会向服务器发多少次状态查询。
 *
 * @param settings 生效中的配置。`effective_search_timeout` 必须已经是
 *   `max(search_timeout, timeout)` 的结果（见 `Settings.effective_search_timeout`）；
 *   这里不再各自读原始值，避免把这条规则实现第二遍。
 */
export function limitsReport(settings: {
  timeout: number
  effective_search_timeout: number
  poll_interval: number
  max_results: number
  max_time_range_seconds: number
  max_query_length: number
}): Record<string, unknown> {
  return {
    ...SafetyPolicy.fromSettings(settings).toPublicDict(),
    timeout: settings.timeout,
    search_timeout: settings.effective_search_timeout,
    poll_interval: settings.poll_interval,
  }
}
