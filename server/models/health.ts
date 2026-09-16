/**
 * 健康检查模型。
 *
 * 三条容易踩错的序列化规则（都参与对拍）：
 *   1. `ServerInfo.toPublicDict()` **保留** `null`；
 *   2. `HealthReport.toPublicDict()` **剔除** `null`（递归作用到嵌套对象）；
 *   3. 失败的探针仍返回结构化报告，并套上标准错误信封（`success:false` + `error`），
 *      退出码由 `failureExitCode()` 决定（认证 3 / 连接 4 / 其它 1）。
 */

/**
 * 把 epoch 秒转换为 ISO-8601 时间戳。
 *
 * 两处与 JS `toISOString()` 的差异（都由对拍暴露）：
 *   - 时区偏移写成 `+00:00`，**不是** `Z`；
 *   - 微秒为 0 时**整个小数部分省略**（`...T10:02:11+00:00`），
 *     非 0 时补足 6 位（`...T10:02:11.500000+00:00`）。
 *
 * 数值 epoch 转 ISO-8601；已是普通字符串则原样返回，无法解释返回 `null`。
 */
export function unixToIso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null

  let seconds: number
  if (typeof value === 'number') {
    seconds = value
  } else if (typeof value === 'string') {
    const asNumber = Number(value)
    if (!Number.isFinite(asNumber)) return value
    seconds = asNumber
  } else {
    return null
  }
  if (!Number.isFinite(seconds)) return null

  const date = new Date(Math.round(seconds * 1000))
  if (Number.isNaN(date.getTime())) return null

  const iso = date.toISOString() // 2026-08-28T10:02:11.000Z
  const [datePart = '', rest = ''] = iso.split('T')
  const withoutZ = rest.replace('Z', '')
  const [hms = '', fraction = '0'] = withoutZ.split('.')
  const micros = Math.round(Number(`0.${fraction}`) * 1_000_000)
  const fractionText = micros === 0 ? '' : `.${String(micros).padStart(6, '0')}`
  return `${datePart}T${hms}${fractionText}+00:00`
}

/** `null`/空串归一为 `null`，否则转字符串。 */
function optStr(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

/** 取集合响应的第一个 `content`。 */
function firstContent(payload: Record<string, unknown>): Record<string, unknown> {
  const entries = payload['entry']
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (typeof entry === 'object' && entry !== null) {
        const content = (entry as Record<string, unknown>)['content']
        if (typeof content === 'object' && content !== null) {
          return content as Record<string, unknown>
        }
      }
    }
  }
  return {}
}

/** 递归剔除值为 `null`/`undefined` 的键。 */
export function pruneNulls(node: unknown): unknown {
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

/** Splunk 实例的身份与能力信息。 */
export class ServerInfo {
  readonly version: string
  readonly build: string | null
  readonly server_name: string | null
  readonly guid: string | null
  readonly license_state: string | null
  readonly health: string
  readonly os_name: string | null
  readonly cpu_arch: string | null
  readonly server_start_time: string | null

  constructor(fields: {
    version: string
    build: string | null
    server_name: string | null
    guid: string | null
    license_state: string | null
    health: string
    os_name: string | null
    cpu_arch: string | null
    server_start_time: string | null
  }) {
    this.version = fields.version
    this.build = fields.build
    this.server_name = fields.server_name
    this.guid = fields.guid
    this.license_state = fields.license_state
    this.health = fields.health
    this.os_name = fields.os_name
    this.cpu_arch = fields.cpu_arch
    this.server_start_time = fields.server_start_time
  }

  /** 从 `GET /services/server/info` 构造。 */
  static fromApi(payload: Record<string, unknown>): ServerInfo {
    const content = firstContent(payload)
    const health = content['health'] ?? content['health_status'] ?? 'unknown'
    return new ServerInfo({
      version: String(content['version'] ?? 'unknown'),
      build: optStr(content['build']),
      server_name: optStr(content['serverName'] ?? content['server_name']),
      guid: optStr(content['guid']),
      license_state: optStr(content['licenseState'] ?? content['license_state']),
      health: String(health).toLowerCase(),
      os_name: optStr(content['os_name'] ?? content['osName']),
      cpu_arch: optStr(content['cpu_arch']),
      server_start_time: unixToIso(content['start_time'] ?? content['startup_time']),
    })
  }

  /** 公开 JSON 视图（**保留** `null`）。 */
  toPublicDict(): Record<string, unknown> {
    return {
      version: this.version,
      build: this.build,
      server_name: this.server_name,
      guid: this.guid,
      license_state: this.license_state,
      health: this.health,
      os_name: this.os_name,
      cpu_arch: this.cpu_arch,
      server_start_time: this.server_start_time,
    }
  }
}

/** 单个 license pool 摘要。 */
export interface LicensePool {
  name: string | null
  stack_size: number | null
  used_bytes: number | null
  quota: number | string | null
}

/** 粗粒度 license 视图。 */
export class LicenseInfo {
  readonly status: string
  readonly reason: string | null
  readonly pools: LicensePool[]

  constructor(fields: { status: string; reason: string | null; pools: LicensePool[] }) {
    this.status = fields.status
    this.reason = fields.reason
    this.pools = fields.pools
  }

  /**
   * 从客户端的 license 摘要构造。
   *
   * 摘要形状：`{status, pools, reason?}`；`pools` 里每个条目的键总是齐全、
   * 值可能为 `null`（由上层决定是否输出）。
   */
  static fromApi(payload: Record<string, unknown>): LicenseInfo {
    const rawPools = payload['pools']
    const pools: LicensePool[] = []
    if (Array.isArray(rawPools)) {
      for (const entry of rawPools) {
        if (typeof entry === 'object' && entry !== null) {
          const record = entry as Record<string, unknown>
          pools.push({
            name: optStr(record['name']),
            stack_size: record['stack_size'] === null || record['stack_size'] === undefined
              ? null
              : Math.trunc(Number(record['stack_size'])),
            used_bytes: record['used_bytes'] === null || record['used_bytes'] === undefined
              ? null
              : Math.trunc(Number(record['used_bytes'])),
            quota:
              record['quota'] === null || record['quota'] === undefined
                ? null
                : typeof record['quota'] === 'number'
                  ? Math.trunc(record['quota'])
                  : String(record['quota']),
          })
        }
      }
    }
    return new LicenseInfo({
      status: String(payload['status'] ?? 'unknown'),
      reason: optStr(payload['reason']),
      pools,
    })
  }

  toPublicDict(): Record<string, unknown> {
    return { status: this.status, reason: this.reason, pools: this.pools }
  }
}

/** `splunk-cli health` 的结果。 */
export class HealthReport {
  readonly success: boolean
  readonly splunk: ServerInfo | null
  readonly connection: string
  readonly authentication: string
  readonly health: string
  readonly license: LicenseInfo | null
  readonly latency_ms: number | null
  readonly error: string | null

  constructor(fields: {
    success?: boolean
    splunk?: ServerInfo | null
    connection?: string
    authentication?: string
    health?: string
    license?: LicenseInfo | null
    latency_ms?: number | null
    error?: string | null
  }) {
    this.success = fields.success ?? true
    this.splunk = fields.splunk ?? null
    this.connection = fields.connection ?? 'ok'
    this.authentication = fields.authentication ?? 'ok'
    this.health = fields.health ?? 'unknown'
    this.license = fields.license ?? null
    this.latency_ms = fields.latency_ms ?? null
    this.error = fields.error ?? null
  }

  /** 失败探针的退出码：认证 3 / 连接 4 / 其它 1。 */
  failureExitCode(): number {
    if (this.success) return 0
    if (this.authentication === 'failed') return 3
    if (this.connection === 'failed') return 4
    return 1
  }

  /**
   * 稳定公开视图。
   *
   * 失败时套上标准错误信封——调用方对每种失败看到同一个形状。
   */
  toPublicDict(): Record<string, unknown> {
    const payload = pruneNulls({
      success: this.success,
      splunk: this.splunk === null ? null : this.splunk.toPublicDict(),
      connection: this.connection,
      authentication: this.authentication,
      health: this.health,
      license: this.license === null ? null : this.license.toPublicDict(),
      latency_ms: this.latency_ms,
      error: this.error,
    }) as Record<string, unknown>

    if (this.success) return payload

    const errorType =
      this.authentication === 'failed'
        ? 'SplunkAuthenticationError'
        : this.connection === 'failed'
          ? 'SplunkConnectionError'
          : 'SplunkError'
    payload['error'] = {
      type: errorType,
      message: this.error !== null && this.error !== '' ? this.error : 'Splunk health probe failed',
    }
    return payload
  }
}
