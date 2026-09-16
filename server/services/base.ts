/**
 * 服务层基类。
 *
 * 分层位置（AGENTS.md §3）：CLI 与 Web 都只依赖本层；本层依赖 client / models /
 * safety / output，**绝不**依赖 CLI 或 Express。时间范围解析、安全上限、结果分页
 * 都在这里，所以 CLI 与未来的 MCP 层共享同一套行为。
 */

import type { Settings } from '../config/settings'
import { parseDuration } from '../config/settings'
import type { SplunkClient } from '../client/splunk'
import { SafetyLimitError, SafetyPolicy } from '../safety/limits'
import { validateSpl } from '../safety/validator'
import { SearchJob, TimeRange } from '../models/search'

/** 未指定时间窗时的默认下界。 */
export const DEFAULT_EARLIEST = '-1h'

/** 默认上界。 */
export const DEFAULT_LATEST = 'now'

/** Splunk 的时间单位。`mon` / `y` / `q` 是标准写法，此前被一律拒绝。 */
const TIME_OFFSET = '(?:mon|y|q|[smhdw])'

/** 允许的对齐点（snap）。`@w0`…`@w6` 是"该周的星期几"，Splunk 的周预设用它。 */
const TIME_SNAP = '(?:mon|y|q|w[0-6]|[smhdw])'

/** 相对偏移，如 `-1h`、`-1mon`、`30s`，可选对齐：`-1d@d`、`-7d@w0`。 */
const OFFSET_RE = new RegExp(`^(?<base>[+-]?\\d+${TIME_OFFSET}|now|0)(?<snap>@${TIME_SNAP})?$`)

/** 裸对齐：它本身就是"该周期的起点"，如 `@d`（今天零点）、`@mon`（本月一日）。 */
const SNAP_ONLY_RE = new RegExp(`^@${TIME_SNAP}$`)

/**
 * 具名时间**字面量**：一个名字解析成单个 Splunk 表达式，供 `--earliest` / `--latest` 用。
 *
 * `week` / `month` 曾经是 `-7d@d` / `-30d@d`，也就是"滚动的 7 / 30 天"——那与面板上的
 * 「本周」「本月」（`@w` / `@mon`，本周/本月的起点）不是一回事。现在两处对齐：同一个
 * 名字在 CLI 和面板上指同一个窗口，不再各说各话。
 */
const NAMED_TIMES: Readonly<Record<string, string>> = {
  now: 'now',
  today: '@d',
  yesterday: '-1d@d',
  week: '@w',
  'this-week': '@w',
  month: '@mon',
  'this-month': '@mon',
  year: '@y',
  'this-year': '@y',
}

/** 一个具名时间窗的两端。 */
export interface NamedWindow {
  readonly earliest: string
  readonly latest: string
}

/**
 * 具名时间**窗**：一个名字同时给出两端，供 `--range` 用。
 *
 * 与面板「日历」组一一对应（`web/src/lib/timeRange.ts`），所以 `--range last-month`
 * 和面板上点「上月」搜的是同一个窗口。写成 `@mon` 这类对齐表达式，宽度交给 Splunk 端
 * 求值——`-1mon@mon` 到底指哪两个月界，由服务端的时间语义决定。
 */
export const NAMED_WINDOWS: Readonly<Record<string, NamedWindow>> = {
  today: { earliest: '@d', latest: 'now' },
  yesterday: { earliest: '-1d@d', latest: '@d' },
  'this-week': { earliest: '@w', latest: 'now' },
  'last-week': { earliest: '-7d@w0', latest: '@w0' },
  'this-month': { earliest: '@mon', latest: 'now' },
  'last-month': { earliest: '-1mon@mon', latest: '@mon' },
  'this-year': { earliest: '@y', latest: 'now' },
  'last-year': { earliest: '-1y@y', latest: '@y' },
}

/** `this_week` / `This-Week` / ` last-week ` 统一成一种键。 */
function windowKey(value: string): string {
  return value.trim().toLowerCase().replaceAll('_', '-')
}

/** `--range` 能接受的具名窗口，按声明顺序。 */
export function timeRangeNames(): string[] {
  return Object.keys(NAMED_WINDOWS)
}

/**
 * 展开 `--range` 的取值：具名窗口（`last-month`）或一个固定时长（`7d` → `-7d → now`）。
 *
 * 认不出来时**拒绝**并列出可用写法：猜一个近似窗口，或者静默退回默认的 `-1h`，都会让
 * 调用方拿到一份不是自己要的数据——而这份数据看起来完全正常。
 */
export function expandTimeRange(value: string): NamedWindow {
  const key = windowKey(value)
  const named = NAMED_WINDOWS[key]
  if (named !== undefined) return named
  // `-7d` / `+7d` 里的符号是相对偏移的写法，这里只取量值。
  const duration = key.startsWith('-') || key.startsWith('+') ? key.slice(1) : key
  if (/^\d+[smhdw]$/.test(duration)) return { earliest: `-${duration}`, latest: DEFAULT_LATEST }
  throw new SafetyLimitError(
    `unknown range '${value}': expected one of ${timeRangeNames().join(', ')}, ` +
      'or a duration such as 30m, 12h, 7d',
    { details: { range: value, known: timeRangeNames() } },
  )
}

/** 分页取结果时的页大小。 */
export const RESULT_PAGE_SIZE = 500

/** 一次查询的结果与截断元数据。 */
export interface QueryOutcome {
  readonly rows: Array<Record<string, unknown>>
  readonly fields: string[]
  readonly job: SearchJob
  readonly truncated: boolean
  readonly total_available: number
}

/** 把所有服务共用的策略与客户端封装起来。 */
export class BaseService {
  readonly #client: SplunkClient
  readonly #policy: SafetyPolicy
  readonly #pollInterval: number | null
  readonly #searchTimeout: number | null

  constructor(
    client: SplunkClient,
    options: {
      policy?: SafetyPolicy
      pollInterval?: number | null
      searchTimeout?: number | null
    } = {},
  ) {
    this.#client = client
    const settings: Settings = client.settings
    this.#policy =
      options.policy ??
      new SafetyPolicy({
        max_results: settings.max_results,
        max_time_range_seconds: settings.max_time_range_seconds,
        max_query_length: settings.max_query_length,
      })
    this.#pollInterval = options.pollInterval ?? null
    this.#searchTimeout = options.searchTimeout ?? null
  }

  /** 底层只读客户端（供需要更多端点的服务使用）。 */
  get client(): SplunkClient {
    return this.#client
  }

  /** 生效中的安全策略。 */
  get policy(): SafetyPolicy {
    return this.#policy
  }

  // ------------------------------------------------------------------ //
  // 时间范围
  // ------------------------------------------------------------------ //

  /**
   * 归一化并校验请求的时间窗。
   *
   * 只有两端都能静态求值时才计算宽度；需要服务端求值的表达式（如 `-1d@d`）
   * 原样透传，交给 Splunk 自己的上限兜底，**绝不静默改写**。
   */
  resolveTimeRange(earliest?: string | null, latest?: string | null): TimeRange {
    const rawEarliest = (earliest ?? DEFAULT_EARLIEST).trim() || DEFAULT_EARLIEST
    const rawLatest = (latest ?? DEFAULT_LATEST).trim() || DEFAULT_LATEST

    const resolvedEarliest = normaliseTimeLiteral(rawEarliest, 'earliest')
    const resolvedLatest = normaliseTimeLiteral(rawLatest, 'latest')

    const seconds = computeDuration(resolvedEarliest, resolvedLatest)
    this.#policy.check_time_range(seconds, {
      earliest: resolvedEarliest,
      latest: resolvedLatest,
    })
    return new TimeRange({
      earliest: resolvedEarliest,
      latest: resolvedLatest,
      duration_seconds: seconds,
    })
  }

  // ------------------------------------------------------------------ //
  // 查询执行
  // ------------------------------------------------------------------ //

  /** 校验、执行并分页取回一个只读 SPL 查询。 */
  async runSearch(
    spl: string,
    options: {
      timeRange: TimeRange
      limit: number
      earliest?: string | null
      latest?: string | null
    },
  ): Promise<QueryOutcome> {
    const effectiveSpl = validateSpl(spl, { maxLength: this.#policy.max_query_length })

    const sid = await this.#client.createSearchJob(effectiveSpl, {
      earliestTime: options.earliest ?? options.timeRange.earliest,
      latestTime: options.latest ?? options.timeRange.latest,
      execMode: 'normal',
      maxCount: options.limit,
    })

    const job = await this.#client.waitForSearch(sid, {
      timeout: this.#searchTimeout,
      pollInterval: this.#pollInterval,
    })

    const [rows, truncated] = await this.collectResults(sid, options.limit)
    const fields = orderedFields(rows)
    // Job 的 resultCount 已被搜索自身的 max_count 截断，所以它只是"至少有多少"。
    const totalAvailable = Math.max(job.result_count, rows.length)
    return { rows, fields, job, truncated, total_available: totalAvailable }
  }

  /**
   * 分页取回至多 `limit` 行。
   *
   * 截断判定方式是**多要一行**：那一行存在就说明服务端还有更多数据。
   * 这是唯一可靠的信号——`resultCount` 已被 max_count 截断，而"恰好填满一页"
   * 与"结果正好取完"无法区分。
   */
  async collectResults(
    sid: string,
    limit: number,
  ): Promise<[Array<Record<string, unknown>>, boolean]> {
    const collected: Array<Record<string, unknown>> = []
    let offset = 0

    while (collected.length < limit) {
      const wanted = Math.min(RESULT_PAGE_SIZE, limit - collected.length)
      const page = await this.#client.getSearchResults(sid, { count: wanted, offset })
      if (page.length === 0) return [collected, false]
      collected.push(...page)
      offset += page.length
      if (page.length < wanted) {
        // 短页说明结果已取尽。
        return [collected, false]
      }
    }

    const probe = await this.#client.getSearchResults(sid, { count: 1, offset: limit })
    return [collected.slice(0, limit), probe.length > 0]
  }
}

/** 校验单个时间字面量。 */
export function normaliseTimeLiteral(value: string, field: 'earliest' | 'latest'): string {
  const named = NAMED_TIMES[value.toLowerCase()]
  if (named !== undefined) return named

  if (SNAP_ONLY_RE.test(value) || OFFSET_RE.test(value)) return canonicalise(value)

  // 绝对 ISO-8601 时间戳原样接受。
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/.test(value)) return value

  // epoch 秒。
  if (/^\d{9,11}(\.\d+)?$/.test(value)) return value

  throw new SafetyLimitError(
    `invalid ${field} value '${value}': expected a relative time such as -1h or now, ` +
      'an ISO-8601 timestamp, or epoch seconds',
    { details: { field, value } },
  )
}

/** 把 `1h` 这类相对字面量规范成 Splunk 的 `-1h` 形式。 */
export function canonicalise(value: string): string {
  // A bare snap already names an instant: the start of that period.
  if (SNAP_ONLY_RE.test(value)) return value

  const match = OFFSET_RE.exec(value)
  if (match?.groups === undefined) return value
  const base = match.groups['base'] ?? ''
  const snap = match.groups['snap'] ?? ''
  if (base === 'now' || base === '0') return `${base}${snap}`
  // `+1d` asks for the future; forcing a minus onto it would silently invert it.
  if (base.startsWith('-') || base.startsWith('+')) return `${base}${snap}`
  return `-${base}${snap}`
}

/** 时间窗宽度（秒）；依赖服务端求值时返回 `null`。 */
export function computeDuration(earliest: string, latest: string): number | null {
  if (earliest.includes('@') || latest.includes('@')) return null
  if (/^\d{4}-/.test(earliest) || /^\d{4}-/.test(latest)) return null
  if (/^\d{9,11}/.test(earliest) || /^\d{9,11}/.test(latest)) return null

  const earliestSeconds = parseDuration(earliest)
  if (earliestSeconds === null) return null

  if (latest === 'now') return earliestSeconds

  const latestSeconds = parseDuration(latest)
  if (latestSeconds === null) return null
  // 两端都是 "-Xs" 偏移：窗口就是两者量值之差。
  return earliestSeconds - latestSeconds
}

/** 结果集的字段顺序：按首次出现顺序。 */
export function orderedFields(rows: Array<Record<string, unknown>>): string[] {
  const fields: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!fields.includes(key)) fields.push(key)
    }
  }
  return fields
}
