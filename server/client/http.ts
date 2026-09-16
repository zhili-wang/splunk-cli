/**
 * HTTP 传输层。
 *
 * 这是**全项目技术风险最高的模块**（ADR R1/R2/R4）：
 *   - R1 自签证书：Node 原生 `fetch` 无法按客户端关闭校验，所以用 undici 的
 *     `Agent({ connect: { rejectUnauthorized, ca } })`，每个实例一个 dispatcher（ADR §4.4）；
 *   - R2 超时：`headersTimeout`/`bodyTimeout` 覆盖"读到响应/两个 body 块之间"的等待，
 *     每次请求再叠加 `AbortSignal.timeout()` 作为总时长上限（ADR §4.5）；
 *   - R4 重试：只有 `{502,503,504}` 与超时/连接类错误会重试；**400/401/403 绝不重试**。
 *
 * 两个刻意的设计：
 *   1. `fetch` 与 `dispatcher` 都**可注入**。undici 的 `MockAgent` 拦截**原生全局**
 *      fetch 存在已知互操作问题（allowH2 会让原生 fetch 绕过 mock，见 undici PR #5448），
 *      所以传输层单测用注入而不是 `setGlobalDispatcher()`（ADR §4.4）；
 *   2. 这里是 async——HTTP 语义一致，只是不阻塞事件循环。
 */

import { readFileSync } from 'node:fs'

import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from 'undici'

import {
  ConfigurationError,
  SplunkAuthenticationError,
  SplunkConnectionError,
  SplunkQueryError,
  SplunkResultError,
  SplunkTimeoutError,
  sanitizeMessage,
} from '../errors'
import { formatG } from '../format'
import { debug } from '../logger'
import { USER_AGENT } from '../version'

/** 可以安全重试的状态码：仅瞬时上游故障。 */
export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([502, 503, 504])

/** 绝不重试的状态码（由"只重试上面那组"自然保证，这里显式登记以表达契约）。 */
export const NON_RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([400, 401, 403])

/** 我们对 fetch 的最小结构要求（便于注入替身，不绑定 undici 的具体类型）。 */
export interface HttpResponseLike {
  readonly status: number
  readonly headers: { get(name: string): string | null }
  text(): Promise<string>
}

/** fetch 的初始化参数（只声明我们用到的字段）。 */
export interface FetchInitLike {
  method: string
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
  dispatcher?: unknown
}

/** 可注入的 fetch。 */
export type FetchLike = (url: string, init: FetchInitLike) => Promise<HttpResponseLike>

/** 可关闭的 dispatcher。 */
export interface DispatcherLike {
  close(): Promise<void>
}

/** 构造 HttpClient 的参数。 */
export interface HttpClientOptions {
  /** 基地址，不带尾斜杠，如 `https://host:8089`。 */
  base_url: string
  /** Basic Auth 用户名；空字符串表示不认证。 */
  username?: string
  /** Basic Auth 密码。**绝不写入日志或错误。** */
  password?: string
  /** 单请求超时（秒）。 */
  timeout?: number
  /** 是否校验 TLS 证书。`false` 仅限开发环境对接自签证书。 */
  verify_ssl?: boolean
  /** 可选 PEM CA 包路径，仅在开启校验时生效。 */
  ca_bundle?: string | null
  /** 传输层最大重试次数（0 表示不重试）。 */
  max_retries?: number
  /** 指数退避基数（秒）。 */
  retry_backoff?: number
  /** 是否遵循代理环境变量与系统代理。默认 `false`（理由见下）。 */
  trust_env?: boolean
  /** 注入 fetch（测试用）。 */
  fetch?: FetchLike
  /** 注入 dispatcher（测试用），提供后不再自建。 */
  dispatcher?: DispatcherLike
  /** 注入 CA 文件读取（测试用）。 */
  readCaBundle?: (path: string) => string
}

/** 传给 undici 的连接与超时计划。抽成纯函数是为了让 R1 可以被直接断言。 */
export interface ConnectPlan {
  readonly connect: { rejectUnauthorized?: boolean; ca?: string; timeout: number }
  readonly headersTimeout: number
  readonly bodyTimeout: number
}

/**
 * 由配置推导出连接计划。
 *
 * 校验开关与 CA bundle 的优先级：校验开启且提供 `ca_bundle` 时使用 bundle，
 * 否则退回布尔开关。关闭校验时 **ca_bundle 被忽略**（不该出现"关了校验还加载 CA"这种自相矛盾）。
 *
 * @param options.verify_ssl 是否校验证书。
 * @param options.ca_bundle PEM 路径，或 `null`。
 * @param options.timeout 单请求超时（秒）。
 * @param options.readCaBundle 读取 PEM 的实现；默认读文件系统。
 */
export function connectPlanFor(options: {
  verify_ssl: boolean
  ca_bundle: string | null
  timeout: number
  readCaBundle?: (path: string) => string
}): ConnectPlan {
  const { verify_ssl, ca_bundle, timeout } = options
  const read = options.readCaBundle ?? ((path: string) => readFileSync(path, 'utf8'))
  const timeoutMs = Math.max(1, Math.round(timeout * 1000))

  const connect: { rejectUnauthorized?: boolean; ca?: string; timeout: number } = {
    timeout: timeoutMs,
  }
  if (!verify_ssl) {
    connect.rejectUnauthorized = false
  } else if (ca_bundle !== null && ca_bundle !== '') {
    connect.ca = readCaBundle(read, ca_bundle)
  }
  return { connect, headersTimeout: timeoutMs, bodyTimeout: timeoutMs }
}

/**
 * 读 CA 包，并把 `fs` 的裸错误翻译成**配置错误**。
 *
 * 不翻译的话，`SPLUNK_CA_BUNDLE=/path/that/does/not/exist` 抛的是裸 `ENOENT`——
 * 它不属于错误体系，于是 CLI 归类成"意外错误"（退出码 1），面板则崩在启动上或回一个
 * 500 `internal error`。两种表现都把真正的原因（**路径写错了**）藏起来，而这恰恰是
 * 用户第一次配 CA 时最容易犯的错。
 *
 * 路径来自本地配置、不是远端字符串，可以照实打印；仍过一遍 `sanitizeMessage`。
 */
function readCaBundle(read: (path: string) => string, path: string): string {
  try {
    return read(path)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ConfigurationError(
      `SPLUNK_CA_BUNDLE could not be read: ${path} (${sanitizeMessage(detail)})`,
      { details: { path } },
    )
  }
}

/**
 * 取出最底层的 `cause`。
 *
 * **为什么必须做这件事**：undici 的 `fetch` 把连接/TLS 失败统一包成
 * `TypeError('fetch failed')`，真正的原因（`ECONNREFUSED`、`self-signed certificate`
 * 等）藏在 `error.cause` 里。不解包，用户只会看到 `cannot reach Splunk at ...: fetch failed`——
 * 对排查毫无帮助，对 R1（自签证书）更是灾难——底层原因必须透出给用户。
 */
export function rootCause(error: unknown): unknown {
  let current: unknown = error
  const seen = new Set<unknown>()
  while (
    current instanceof Error &&
    current.cause !== undefined &&
    current.cause !== null &&
    !seen.has(current.cause)
  ) {
    seen.add(current.cause)
    current = current.cause
  }
  return current
}

/** 判断一个异常是否为超时（不靠 message 文本匹配，且会检查 cause 链）。 */
export function isTimeoutError(error: unknown): boolean {
  let current: unknown = error
  const seen = new Set<unknown>()
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    if (typeof current === 'object') {
      const name = (current as { name?: unknown }).name
      if (name === 'TimeoutError' || name === 'AbortError') return true
      const code = (current as { code?: unknown }).code
      if (
        code === 'UND_ERR_HEADERS_TIMEOUT' ||
        code === 'UND_ERR_BODY_TIMEOUT' ||
        code === 'UND_ERR_CONNECT_TIMEOUT' ||
        code === 'UND_ERR_ABORTED'
      ) {
        return true
      }
      current = (current as { cause?: unknown }).cause
      continue
    }
    break
  }
  return false
}

/** 取出异常的可读名（优先系统/undici 错误码，其次 name）。 */
function errorName(error: unknown): string {
  const root = rootCause(error)
  if (typeof root !== 'object' || root === null) return 'Error'
  const code = (root as { code?: unknown }).code
  if (typeof code === 'string' && code !== '') return code
  const name = (root as { name?: unknown }).name
  return typeof name === 'string' && name !== '' ? name : 'Error'
}

/** 取出最有用的一条错误消息（用底层 cause 的消息，而不是 undici 的 "fetch failed"）。 */
function errorMessage(error: unknown): string {
  const root = rootCause(error)
  if (root instanceof Error && root.message !== '') return root.message
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

/** 自签 / 签发链不可验证类的错误码（OpenSSL 与 Node 的命名）。 */
const UNTRUSTED_CERT_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
])

/**
 * 证书本身无效的错误码：重试同样不可能成功，但**没有**"改信任配置"这种建议
 * （证书过期了就该换证书，而不是关掉校验）。
 */
const CERT_VALIDITY_CODES = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID'])

/** 一次 TLS 握手失败的成因。`null` 表示不是证书类问题。 */
type CertFailureKind = 'untrusted' | 'altname' | 'validity' | null

/**
 * 给一次 TLS 失败归类。
 *
 * **同时被两处使用**：决定要不要给用户提示（`tlsTrustHint`），以及决定**要不要重试**
 * （`isDeterministicTlsFailure`）。两处共用一套判断，避免"会给提示的"和"不重试的"
 * 两个集合悄悄漂移。
 */
function classifyCertFailure(error: unknown): CertFailureKind {
  const root = rootCause(error)
  const code =
    typeof root === 'object' && root !== null ? (root as { code?: unknown }).code : undefined
  const text = root instanceof Error ? root.message.toLowerCase() : ''
  const has = (needle: string): boolean => text.includes(needle)

  if (
    (typeof code === 'string' && UNTRUSTED_CERT_CODES.has(code)) ||
    has('self-signed certificate') ||
    has('self signed certificate') ||
    has('unable to verify the first certificate')
  ) {
    return 'untrusted'
  }

  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || has('altnames')) {
    return 'altname'
  }

  if (typeof code === 'string' && CERT_VALIDITY_CODES.has(code)) {
    return 'validity'
  }

  return null
}

/**
 * 这次失败是否**重试也不会成功**。
 *
 * 证书类失败是确定性的：换一次握手并不会让一张不被信任、名字不匹配或已过期的证书
 * 变得可用。此前它们和 `ECONNREFUSED` 一样被重试，默认配置下要白等 3 次指数退避
 * （0.5 + 1 + 2 ≈ 3.5s）才拿到那句本来第一次就成立的报错。
 *
 * `ECONNREFUSED` / `ENOTFOUND` 等**不在**此列：服务重启、DNS 抖动都可能是暂时的，
 * 重试是合理的。
 */
export function isDeterministicTlsFailure(error: unknown): boolean {
  return classifyCertFailure(error) !== null
}

/**
 * TLS **信任类**失败的成因 → 一句可直接照做的处置。
 *
 * 只覆盖证书信任这一类（自签 / 无法验证签发链 / SAN 不匹配）：它们与
 * `ECONNREFUSED` 那种网络故障的处置完全不同，而 Splunk **默认安装**用的就是自签证书
 * （`SplunkServerDefaultCert`），因此这条报错几乎人人都会遇到——值得直接把答案写在
 * 消息里，而不是让用户回去翻文档。
 *
 * 证书过期/尚未生效（`validity`）刻意**不给**提示：那种情况该换证书，而不是关掉校验，
 * 给一句"设 SPLUNK_VERIFY_SSL=false"是坏建议。
 *
 * 其余错误一律返回 `null`：错误消息是调用方做分支判断的契约，不能膨胀成散文。
 *
 * SAN 那条提示特意点明"信任它也没用"：默认证书没有 SAN 扩展，把服务端证书本身当 CA
 * 传给 `SPLUNK_CA_BUNDLE` 只能把报错从"自签"换成"主机名不匹配"，用户会在两个错误
 * 之间来回撞。
 */
function tlsTrustHint(error: unknown): string | null {
  switch (classifyCertFailure(error)) {
    case 'untrusted':
      return (
        "Splunk's default certificate (SplunkServerDefaultCert) is self-signed; for development " +
        'set SPLUNK_VERIFY_SSL=false, or install a certificate the client can verify'
      )
    case 'altname':
      return (
        'the certificate carries no SAN for this host, so trusting it is not enough; for development ' +
        'set SPLUNK_VERIFY_SSL=false, or use a certificate with a SAN for this host'
      )
    default:
      return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 丢弃 `null`/`undefined`，其余按 Splunk 约定字符串化（布尔为小写）。 */
export function cleanParams(
  params: Record<string, unknown>,
): Record<string, string> {
  const cleaned: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue
    cleaned[key] = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)
  }
  return cleaned
}

/**
 * 从错误响应体里尽力取出人类可读的远端消息。
 *
 * 优先 `messages[].text` 用 ` | ` 连接，其次 `message`/`error`/`text`；
 * 非 JSON 时取正文前 500 字符。调用方负责脱敏。
 */
export function extractErrorDetailFromText(text: string): string {
  if (text === '') return ''
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return text.slice(0, 500)
  }
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>
    const messages = record['messages']
    if (Array.isArray(messages)) {
      const parts: string[] = []
      for (const entry of messages) {
        if (typeof entry === 'object' && entry !== null) {
          const text = (entry as Record<string, unknown>)['text']
          if (typeof text === 'string' && text !== '') parts.push(text)
        }
      }
      if (parts.length > 0) return parts.join(' | ')
    }
    for (const key of ['message', 'error', 'text']) {
      const value = record[key]
      if (typeof value === 'string' && value !== '') return value
    }
  }
  return ''
}

/**
 * 决定用哪种 dispatcher。
 *
 * **默认必须是普通 `Agent`**：`SPLUNK_TRUST_ENV=false` 是刻意的默认值
 * （README §13 有一条对应的排查条目——系统代理会拦截内网请求，表现为莫名的网关错误）。
 * 只有显式打开 `trust_env` 才使用读环境变量的 `EnvHttpProxyAgent`。
 *
 * 抽成纯函数是为了让 R3 可以被直接断言，而不是靠"读代码觉得对"。
 *
 * @param trust_env 是否遵循代理环境变量。
 */
export function dispatcherKindFor(trust_env: boolean): 'Agent' | 'EnvHttpProxyAgent' {
  return trust_env ? 'EnvHttpProxyAgent' : 'Agent'
}

/** 面向 Splunk REST API 的传输层客户端。 */
export class HttpClient {
  readonly #baseUrl: string
  readonly #username: string
  readonly #password: string
  readonly #timeout: number
  readonly #maxRetries: number
  readonly #retryBackoff: number
  readonly #fetchImpl: FetchLike
  readonly #dispatcher: DispatcherLike | null
  readonly #ownsDispatcher: boolean

  constructor(options: HttpClientOptions) {
    this.#baseUrl = options.base_url.replace(/\/+$/, '')
    this.#username = options.username ?? ''
    this.#password = options.password ?? ''
    this.#timeout = options.timeout ?? 30
    this.#maxRetries = Math.max(0, options.max_retries ?? 3)
    this.#retryBackoff = Math.max(0, options.retry_backoff ?? 0.5)
    this.#fetchImpl = options.fetch ?? (undiciFetch as unknown as FetchLike)

    if (options.dispatcher !== undefined) {
      this.#dispatcher = options.dispatcher
      this.#ownsDispatcher = false
    } else {
      const plan = connectPlanFor({
        verify_ssl: options.verify_ssl ?? true,
        ca_bundle: options.ca_bundle ?? null,
        timeout: this.#timeout,
        ...(options.readCaBundle !== undefined ? { readCaBundle: options.readCaBundle } : {}),
      })
      // trust_env 默认 false：Splunk 通常在内网，把管理 API 悄悄绕进开发机的系统代理
      // 会得到莫名其妙的网关错误而不是清晰的连接结果（README §13 有对应排查条目）。
      const DispatcherCtor = dispatcherKindFor(options.trust_env === true) === 'EnvHttpProxyAgent'
        ? EnvHttpProxyAgent
        : Agent
      this.#dispatcher = new DispatcherCtor(plan) as unknown as DispatcherLike
      this.#ownsDispatcher = true
    }
  }

  /** 基地址（错误消息与诊断用）。 */
  get baseUrl(): string {
    return this.#baseUrl
  }

  /** 关闭连接池。 */
  async close(): Promise<void> {
    if (this.#ownsDispatcher && this.#dispatcher !== null) {
      await this.#dispatcher.close()
    }
  }

  /** 构造 Authorization 头；无用户名时返回空映射。**绝不记录该值。** */
  #authHeader(): Record<string, string> {
    if (this.#username === '') return {}
    const encoded = Buffer.from(`${this.#username}:${this.#password}`, 'utf8').toString('base64')
    return { Authorization: `Basic ${encoded}` }
  }

  #backoffDelay(attempt: number): number {
    return this.#retryBackoff * 2 ** (attempt - 1)
  }

  /**
   * 拼出完整请求 URL。
   *
   * 未配置端点时基地址是空串，`new URL('/path')` 会抛出裸 `TypeError`。那会以
   * "意外错误"逃逸成 500，而正确归类是**连接类失败**：`/api/health` 应当把它作为
   * 探针失败在报告内呈现（`connection: failed`），CLI 对应退出码 4。
   *
   * 这类失败是确定性的，**不重试**。
   */
  #buildUrl(path: string, method: string): URL {
    const target = `${this.#baseUrl}${path}`
    try {
      return new URL(target)
    } catch {
      throw new SplunkConnectionError(
        `cannot reach Splunk at ${this.#baseUrl === '' ? '<unconfigured>' : this.#baseUrl}: ` +
          'the base URL is missing or invalid (set SPLUNK_HOST/SPLUNK_PORT or SPLUNK_URL)',
        { details: { method, path, cause: 'InvalidURL' } },
      )
    }
  }

  /** 发起请求并处理重试与错误归类。成功时返回原始响应，正文由调用方读取。 */
  async #request(
    method: string,
    path: string,
    options: { params?: Record<string, string>; data?: Record<string, string> } = {},
  ): Promise<HttpResponseLike> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      ...this.#authHeader(),
    }

    const url = this.#buildUrl(path, method)
    for (const [key, value] of Object.entries(options.params ?? {})) {
      url.searchParams.set(key, value)
    }
    let body: string | undefined
    if (options.data !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(options.data).toString()
    }

    const attempts = this.#maxRetries + 1
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: HttpResponseLike
      try {
        response = await this.#fetchImpl(url.toString(), {
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
          signal: AbortSignal.timeout(Math.max(1, Math.round(this.#timeout * 1000))),
          dispatcher: this.#dispatcher,
        })
      } catch (error) {
        if (isTimeoutError(error)) {
          debug('http', `timeout on ${method} ${path} (attempt ${attempt}/${attempts})`)
          if (attempt < attempts) {
            await sleep(this.#backoffDelay(attempt) * 1000)
            continue
          }
          throw new SplunkTimeoutError(
            `request timed out after ${formatG(this.#timeout)}s: ${method} ${path} to ${this.#baseUrl}`,
            { details: { method, path } },
          )
        }
        debug(
          'http',
          `transport error on ${method} ${path} (attempt ${attempt}/${attempts}): ${errorName(error)}`,
        )
        // 证书类失败是**确定性**的：重试只是白等退避时间，不会让不被信任的证书变得可信。
        if (attempt < attempts && !isDeterministicTlsFailure(error)) {
          await sleep(this.#backoffDelay(attempt) * 1000)
          continue
        }
        const detail = sanitizeMessage(errorMessage(error)) || errorName(error)
        const hint = tlsTrustHint(error)
        throw new SplunkConnectionError(
          `cannot reach Splunk at ${this.#baseUrl}: ${detail}${hint === null ? '' : ` (hint: ${hint})`}`,
          { details: { method, path, cause: errorName(error) } },
        )
      }

      if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < attempts) {
        debug(
          'http',
          `retryable status ${response.status} on ${method} ${path} (attempt ${attempt}/${attempts})`,
        )
        await sleep(this.#backoffDelay(attempt) * 1000)
        continue
      }

      return this.#checkStatus(response, method, path)
    }

    throw new SplunkConnectionError(
      `request failed after ${attempts} attempts: ${method} ${path}`,
      { details: { method, path } },
    )
  }

  /** 把非 2xx 响应翻译成正确的错误类型。 */
  async #checkStatus(
    response: HttpResponseLike,
    method: string,
    path: string,
  ): Promise<HttpResponseLike> {
    const status = response.status
    if (status >= 200 && status < 300) return response

    const text = await response.text().catch(() => '')
    const detail = sanitizeMessage(extractErrorDetailFromText(text), 500)

    if (status === 401 || status === 403) {
      let message =
        `authentication failed (HTTP ${status}) for user ` +
        `${this.#username !== '' ? this.#username : '<anonymous>'} at ${this.#baseUrl}`
      if (detail !== '') message = `${message}: ${detail}`
      throw new SplunkAuthenticationError(message, { details: { status, path, method } })
    }

    if (status === 408 || status === 504) {
      let message = `request timed out at the server (HTTP ${status}): ${method} ${path}`
      if (detail !== '') message = `${message}: ${detail}`
      throw new SplunkTimeoutError(message, { details: { status, path } })
    }

    let message = `Splunk returned HTTP ${status} for ${method} ${path}`
    if (detail !== '') message = `${message}: ${detail}`
    throw new SplunkQueryError(message, { details: { status, path, method } })
  }

  /** 读取正文并解析为 JSON 对象。 */
  async #json(response: HttpResponseLike): Promise<Record<string, unknown>> {
    const text = await response.text()
    if (text.trim() === '') return {}
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      const contentType = response.headers.get('content-type') ?? 'unknown'
      throw new SplunkResultError(
        `Splunk returned a body that is not valid JSON ` +
          `(${text.length} bytes, content-type ${contentType})`,
      )
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new SplunkResultError(
        `expected a JSON object from Splunk, got ${Array.isArray(payload) ? 'array' : typeof payload}`,
      )
    }
    return payload as Record<string, unknown>
  }

  /** GET 并解析 JSON 对象。 */
  async get(path: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const response = await this.#request('GET', path, { params: cleanParams(params) })
    return this.#json(response)
  }

  /** 表单编码 POST 并解析 JSON 对象。 */
  async post(path: string, data: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const response = await this.#request('POST', path, { data: cleanParams(data) })
    return this.#json(response)
  }

  /** GET 并返回原始正文。 */
  async getText(path: string, params: Record<string, unknown> = {}): Promise<string> {
    const response = await this.#request('GET', path, { params: cleanParams(params) })
    return response.text()
  }
}
