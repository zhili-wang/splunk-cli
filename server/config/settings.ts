/**
 * 配置加载。
 *
 * 分层来源（优先级由低到高，后者覆盖前者）：
 *   1. 内置默认值
 *   2. 项目内 `./.env`（git-ignored，便于本地开发）
 *   3. 全局 `~/.splunk-cli/config.env`
 *   4. `SPLUNK_*` 环境变量
 *   5. `loadSettings()` 的显式 overrides
 *
 * **合并语义是逐字段的**：不是"候选路径首命中即返回"，而是按优先级做**字段级覆盖**——
 * 高优先级来源只覆盖它显式提供的字段，其余字段继续沿用低优先级来源的值。
 *
 * 字段名刻意用 snake_case：它们同时是环境变量名（大写下划线）与 `redacted()` 的公开键，
 * 逐字对应可以避免映射错位。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

import { ConfigurationError } from '../errors'
import { writableConfigFile } from './paths'

/** 时长字面量，如 `30s`、`5m`、`1h`、`7d`。 */
const DURATION_RE = /^(?<value>\d+(?:\.\d+)?)(?<unit>[smhdw])$/

const UNIT_SECONDS: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
}

/** 环境变量前缀。 */
const ENV_PREFIX = 'SPLUNK_'

/**
 * 解析 Splunk 风格时长字面量。
 *
 * @param value 如 `"5m"`、`"7d"`；允许前导 `-`（Splunk 相对修饰符）。
 * @returns 秒数；不是固定时长时返回 `null`（如 `"now"`、`"@d"`、`"-1h@h"`、epoch）。
 */
export function parseDuration(value: string): number | null {
  const text = value
    .trim()
    .replace(/^[-+]+/, '')
    .trim()
  const match = DURATION_RE.exec(text)
  if (match?.groups === undefined) return null
  const amount = Number(match.groups['value'])
  const unit = match.groups['unit']
  if (unit === undefined || !Number.isFinite(amount)) return null
  const factor = UNIT_SECONDS[unit]
  if (factor === undefined) return null
  return amount * factor
}

/** 字段的原始（字符串）来源取值。 */
type RawSettings = Record<string, string | undefined>

/** 解析 `.env` / `config.env` 的常用子集。 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const eq = withoutExport.indexOf('=')
    if (eq === -1) continue
    const key = withoutExport.slice(0, eq).trim()
    if (key === '') continue
    let value = withoutExport.slice(eq + 1).trim()
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    if (quoted) {
      value = value.slice(1, -1)
    } else {
      // 只在未加引号时剥离 " #" 之后的内联注释。
      const hash = value.search(/\s#/)
      if (hash !== -1) value = value.slice(0, hash).trim()
    }
    out[key] = value
  }
  return out
}

function readEnvFileIfPresent(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  try {
    return parseEnvFile(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new ConfigurationError(
      `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** 校验字段取值范围。zod 只负责"取值约束"，字符串→值 的转换由上面的显式解析完成。 */
const rangeSchema = z.object({
  port: z.number().int().min(1).max(65_535),
  timeout: z.number().gt(0).max(600),
  max_results: z.number().int().gt(0).max(1_000_000),
  poll_interval: z.number().gt(0).max(60),
  search_timeout: z.number().gt(0).max(3600),
  max_query_length: z.number().int().gt(0).max(1_000_000),
  max_retries: z.number().int().min(0).max(10),
  retry_backoff: z.number().min(0).max(30),
})

function parseIntField(raw: string, field: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ConfigurationError(`${field} must be an integer (got ${JSON.stringify(raw)})`)
  }
  return value
}

function parseFloatField(raw: string, field: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new ConfigurationError(`${field} must be a number (got ${JSON.stringify(raw)})`)
  }
  return value
}

/** 布尔解析：**不能用 `Boolean(raw)`**——那会把字符串 "false" 判成 true。 */
function parseBoolField(raw: string, field: string): boolean {
  const value = raw.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(value)) return true
  if (['false', '0', 'no', 'off'].includes(value)) return false
  throw new ConfigurationError(`${field} must be a boolean (got ${JSON.stringify(raw)})`)
}

function validateHost(value: string): string {
  const text = value.trim().replace(/\/+$/, '')
  if (text === '') return ''
  if (text.includes('://')) {
    throw new ConfigurationError(
      `SPLUNK_HOST must be a bare host or IP, not a URL (got '${text}'). ` +
        'Put the scheme in SPLUNK_INSECURE and the port in SPLUNK_PORT, ' +
        'or set SPLUNK_URL instead.',
    )
  }
  // 冒号只在"非 IPv6 字面量"时才代表端口：`[::1]` 有方括号；裸 IPv6（如 `::1`）有多个冒号。
  if (text.includes(':') && !text.startsWith('[') && text.split(':').length === 2) {
    throw new ConfigurationError(
      `SPLUNK_HOST must not include a port (got '${text}'). ` +
        'Use SPLUNK_PORT, e.g. SPLUNK_PORT=8089.',
    )
  }
  if (text.includes('/')) {
    throw new ConfigurationError(
      `SPLUNK_HOST must not include a path (got '${text}'). ` +
        'For a path-prefixed deployment set the full SPLUNK_URL instead.',
    )
  }
  return text
}

function validateUrl(value: string): string {
  const text = value.trim()
  if (text === '') return ''
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw new ConfigurationError(
      `SPLUNK_URL must use http:// or https:// (got '${text}'); ` +
        'you can also set SPLUNK_HOST and SPLUNK_PORT instead',
    )
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigurationError(
      `SPLUNK_URL must use http:// or https:// (got scheme '${parsed.protocol.replace(':', '')}'); ` +
        'you can also set SPLUNK_HOST and SPLUNK_PORT instead',
    )
  }
  if (parsed.hostname === '') {
    throw new ConfigurationError('SPLUNK_URL must include a hostname')
  }
  return text.replace(/\/+$/, '')
}

/** 校验后的运行时配置。 */
export class Settings {
  readonly host: string
  readonly port: number
  readonly insecure: boolean
  readonly url: string
  readonly username: string
  /** 原始密码。**只允许在构造认证头时读取，绝不可渲染。** */
  readonly password: string
  readonly verify_ssl: boolean
  readonly ca_bundle: string | null
  readonly trust_env: boolean
  readonly timeout: number
  readonly max_results: number
  readonly max_time_range: string
  readonly poll_interval: number
  readonly search_timeout: number
  readonly max_query_length: number
  readonly max_retries: number
  readonly retry_backoff: number

  constructor(fields: {
    host: string
    port: number
    insecure: boolean
    url: string
    username: string
    password: string
    verify_ssl: boolean
    ca_bundle: string | null
    trust_env: boolean
    timeout: number
    max_results: number
    max_time_range: string
    poll_interval: number
    search_timeout: number
    max_query_length: number
    max_retries: number
    retry_backoff: number
  }) {
    this.host = fields.host
    this.port = fields.port
    this.insecure = fields.insecure
    this.url = fields.url
    this.username = fields.username
    this.password = fields.password
    this.verify_ssl = fields.verify_ssl
    this.ca_bundle = fields.ca_bundle
    this.trust_env = fields.trust_env
    this.timeout = fields.timeout
    this.max_results = fields.max_results
    this.max_time_range = fields.max_time_range
    this.poll_interval = fields.poll_interval
    this.search_timeout = fields.search_timeout
    this.max_query_length = fields.max_query_length
    this.max_retries = fields.max_retries
    this.retry_backoff = fields.retry_backoff
  }

  /** `url` 是否为显式设置（而非由 host/port 推导）。 */
  get is_url_explicit(): boolean {
    return this.url !== ''
  }

  /** 要连接的基地址（无尾斜杠）；未配置 host 时为 `""`。 */
  get effective_url(): string {
    if (this.url !== '') return this.url
    if (this.host === '') return ''
    const scheme = this.insecure ? 'http' : 'https'
    // 裸 IPv6 字面量加方括号，避免端口分隔符歧义。
    const host = this.host.includes(':') && !this.host.startsWith('[') ? `[${this.host}]` : this.host
    return `${scheme}://${host}:${this.port}`
  }

  /** 时间跨度上限（秒）。 */
  get max_time_range_seconds(): number {
    const seconds = parseDuration(this.max_time_range)
    if (seconds === null) {
      throw new ConfigurationError(`invalid max_time_range: '${this.max_time_range}'`)
    }
    return seconds
  }

  /** Splunk API 基路径。 */
  get base_path(): string {
    const resolved = this.effective_url
    return resolved === '' ? '' : `${resolved}/services`
  }

  /** 搜索 Job 的墙钟预算，**永不低于单请求超时**。 */
  get effective_search_timeout(): number {
    return Math.max(this.search_timeout, this.timeout)
  }

  /** 是否具备发起连接的最小配置。 */
  get is_configured(): boolean {
    return this.effective_url !== '' && this.username !== '' && this.password !== ''
  }

  /** 配置缺失时抛 `ConfigurationError`。消息绝不包含密码值。 */
  require_credentials(): void {
    const missing: string[] = []
    if (this.effective_url === '') missing.push('SPLUNK_HOST')
    if (this.username === '') missing.push('SPLUNK_USERNAME')
    if (this.password === '') missing.push('SPLUNK_PASSWORD')
    if (missing.length > 0) {
      throw new ConfigurationError(
        `missing required configuration: ${missing.join(', ')} ` +
          `(fill in ${writableConfigFile()}, export them, or, from a ` +
          "source checkout's root, copy .env.example to ./.env)",
      )
    }
  }

  /** 日志安全的配置视图。密码只以存在性标记出现。 */
  redacted(): Record<string, unknown> {
    return {
      host: this.host,
      port: this.port,
      url: this.effective_url,
      url_source: this.url !== '' ? 'SPLUNK_URL' : 'SPLUNK_HOST/SPLUNK_PORT',
      username: this.username,
      password: this.password !== '' ? '<set>' : '<unset>',
      verify_ssl: this.verify_ssl,
      ca_bundle: this.ca_bundle,
      trust_env: this.trust_env,
      timeout: this.timeout,
      max_results: this.max_results,
      max_time_range: this.max_time_range,
      poll_interval: this.poll_interval,
      search_timeout: this.effective_search_timeout,
      max_query_length: this.max_query_length,
      max_retries: this.max_retries,
      retry_backoff: this.retry_backoff,
    }
  }
}

/** 允许 override 的字段名。 */
export type SettingsOverrides = Partial<Record<string, string | number | boolean>>

/**
 * 从所有来源构建配置。
 *
 * @param overrides 覆盖一切来源的显式取值（测试与内部调用用）。
 * @param env 环境变量表；默认 `process.env`。
 * @param cwd 用于定位项目内 `./.env`；默认 `process.cwd()`。
 */
export function loadSettings(
  overrides: SettingsOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Settings {
  // 升序合并：默认值 → ./.env → 全局 config.env → SPLUNK_* 环境变量。
  const merged: RawSettings = {}

  const localEnv = readEnvFileIfPresent(join(cwd, '.env'))
  for (const [key, value] of Object.entries(localEnv)) {
    if (key.toUpperCase().startsWith(ENV_PREFIX)) merged[key.slice(ENV_PREFIX.length).toLowerCase()] = value
  }

  const globalConfig = writableConfigFile(env)
  const globalEnv = readEnvFileIfPresent(globalConfig)
  for (const [key, value] of Object.entries(globalEnv)) {
    if (key.toUpperCase().startsWith(ENV_PREFIX)) merged[key.slice(ENV_PREFIX.length).toLowerCase()] = value
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (upper.startsWith(ENV_PREFIX)) merged[upper.slice(ENV_PREFIX.length).toLowerCase()] = value
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue
    merged[key.toLowerCase()] = String(value)
  }

  const pick = (field: string): string | undefined => merged[field]
  const text = (field: string, fallback: string): string => pick(field) ?? fallback

  const rangeCandidate = {
    port: pick('port') === undefined ? 8089 : parseIntField(pick('port') as string, 'port'),
    timeout: pick('timeout') === undefined ? 30 : parseFloatField(pick('timeout') as string, 'timeout'),
    max_results:
      pick('max_results') === undefined ? 5000 : parseIntField(pick('max_results') as string, 'max_results'),
    poll_interval:
      pick('poll_interval') === undefined ? 1 : parseFloatField(pick('poll_interval') as string, 'poll_interval'),
    search_timeout:
      pick('search_timeout') === undefined ? 60 : parseFloatField(pick('search_timeout') as string, 'search_timeout'),
    max_query_length:
      pick('max_query_length') === undefined
        ? 10_000
        : parseIntField(pick('max_query_length') as string, 'max_query_length'),
    max_retries:
      pick('max_retries') === undefined ? 3 : parseIntField(pick('max_retries') as string, 'max_retries'),
    retry_backoff:
      pick('retry_backoff') === undefined
        ? 0.5
        : parseFloatField(pick('retry_backoff') as string, 'retry_backoff'),
  }

  const ranged = rangeSchema.safeParse(rangeCandidate)
  if (!ranged.success) {
    const issues = ranged.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new ConfigurationError(`invalid configuration: ${issues}`)
  }

  const maxTimeRange = text('max_time_range', '7d')
  if (parseDuration(maxTimeRange) === null) {
    throw new ConfigurationError(
      `SPLUNK_MAX_TIME_RANGE must be a fixed duration such as 30m, 24h, 7d ` +
        `(got '${maxTimeRange}')`,
    )
  }

  const caBundleRaw = pick('ca_bundle')
  const caBundle = caBundleRaw === undefined || caBundleRaw.trim() === '' ? null : caBundleRaw.trim()

  const fields = {
    host: validateHost(text('host', '')),
    port: ranged.data.port,
    insecure: pick('insecure') === undefined ? false : parseBoolField(pick('insecure') as string, 'insecure'),
    url: validateUrl(text('url', '')),
    username: text('username', ''),
    password: text('password', ''),
    verify_ssl:
      pick('verify_ssl') === undefined ? true : parseBoolField(pick('verify_ssl') as string, 'verify_ssl'),
    ca_bundle: caBundle,
    trust_env:
      pick('trust_env') === undefined ? false : parseBoolField(pick('trust_env') as string, 'trust_env'),
    timeout: ranged.data.timeout,
    max_results: ranged.data.max_results,
    max_time_range: maxTimeRange,
    poll_interval: ranged.data.poll_interval,
    search_timeout: ranged.data.search_timeout,
    max_query_length: ranged.data.max_query_length,
    max_retries: ranged.data.max_retries,
    retry_backoff: ranged.data.retry_backoff,
  }

  return new Settings(fields)
}
