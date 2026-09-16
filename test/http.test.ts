import { describe, expect, it } from 'vitest'

import {
  HttpClient,
  connectPlanFor,
  dispatcherKindFor,
  cleanParams,
  extractErrorDetailFromText,
  isDeterministicTlsFailure,
  isTimeoutError,
  rootCause,
  type FetchInitLike,
  type FetchLike,
  type HttpResponseLike,
} from '../server/client/http'
import {
  ConfigurationError,
  SplunkAuthenticationError,
  SplunkConnectionError,
  SplunkQueryError,
  SplunkResultError,
  SplunkTimeoutError,
} from '../server/errors'

// --------------------------------------------------------------------------
// 替身工具
// --------------------------------------------------------------------------

interface RecordedCall {
  url: string
  init: FetchInitLike
}

function jsonResponse(status: number, body: unknown, contentType = 'application/json'): HttpResponseLike {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => text,
  }
}

/** 按脚本依次返回响应；脚本用尽后重复最后一个。 */
function scriptedFetch(responses: HttpResponseLike[]): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const index = Math.min(calls.length - 1, responses.length - 1)
    const response = responses[index]
    if (response === undefined) throw new Error('scriptedFetch: 空脚本')
    return response
  }
  return { fetchImpl, calls }
}

/** 依次抛错的 fetch。 */
function throwingFetch(errors: unknown[]): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const index = Math.min(calls.length - 1, errors.length - 1)
    throw errors[index]
  }
  return { fetchImpl, calls }
}

function timeoutError(): Error {
  const error = new Error('The operation was aborted due to timeout')
  error.name = 'TimeoutError'
  return error
}

/** undici 把底层失败包成 TypeError('fetch failed')，真正原因在 cause。 */
function wrapped(name: string, message: string, code: string): Error {
  const cause = Object.assign(new Error(message), { code, name })
  return new TypeError('fetch failed', { cause })
}

function connectionRefused(): Error {
  const error = new Error('connect ECONNREFUSED 127.0.0.1:1') as Error & { code?: string }
  error.code = 'ECONNREFUSED'
  return error
}

/** 不建真实 dispatcher 的客户端（测试注入 fetch，避免触碰全局 dispatcher）。 */
function client(
  fetchImpl: FetchLike,
  overrides: Partial<ConstructorParameters<typeof HttpClient>[0]> = {},
): HttpClient {
  return new HttpClient({
    base_url: 'https://splunk.example:8089',
    username: 'splunk_user',
    password: 'hunter2',
    timeout: 30,
    max_retries: 0,
    retry_backoff: 0,
    fetch: fetchImpl,
    dispatcher: { close: async () => {} },
    ...overrides,
  })
}

// --------------------------------------------------------------------------
// R1：TLS 装配（ADR §4.4）
// --------------------------------------------------------------------------

describe('R1 connectPlanFor：per-client 的 TLS 决策', () => {  it('默认校验：不出现 rejectUnauthorized，也不加载 CA', () => {
    const plan = connectPlanFor({ verify_ssl: true, ca_bundle: null, timeout: 30 })
    expect(plan.connect).toEqual({ timeout: 30_000 })
    expect(plan.headersTimeout).toBe(30_000)
    expect(plan.bodyTimeout).toBe(30_000)
  })

  it('SPLUNK_VERIFY_SSL=false → rejectUnauthorized:false（开发环境对接自签证书）', () => {
    const plan = connectPlanFor({ verify_ssl: false, ca_bundle: null, timeout: 5 })
    expect(plan.connect.rejectUnauthorized).toBe(false)
    expect(plan.connect).not.toHaveProperty('ca')
    expect(plan.headersTimeout).toBe(5000)
  })

  it('SPLUNK_CA_BUNDLE 在开启校验时被读入 ca', () => {
    const plan = connectPlanFor({
      verify_ssl: true,
      ca_bundle: '/tmp/ca.pem',
      timeout: 30,
      readCaBundle: (path) => `PEM(${path})`,
    })
    expect(plan.connect.ca).toBe('PEM(/tmp/ca.pem)')
  })

  it('关闭校验时忽略 ca_bundle（不做"关了校验还加载 CA"这种自相矛盾的事）', () => {
    const plan = connectPlanFor({
      verify_ssl: false,
      ca_bundle: '/tmp/ca.pem',
      timeout: 30,
      readCaBundle: () => 'PEM',
    })
    expect(plan.connect.rejectUnauthorized).toBe(false)
    expect(plan.connect).not.toHaveProperty('ca')
  })

  it('空字符串 ca_bundle 视为未设置', () => {
    const plan = connectPlanFor({ verify_ssl: true, ca_bundle: '', timeout: 30 })
    expect(plan.connect).not.toHaveProperty('ca')
  })

  it('CA 路径读不到 → ConfigurationError，而不是裸 ENOENT', () => {
    // 首次配 CA 时最容易把路径写错。不翻译的话抛的是裸 `ENOENT`：它不属于错误体系，
    // CLI 归类成"意外错误"（退出码 1），面板则回 500 `internal error`——真正的原因被藏起来。
    let error: unknown = null
    try {
      connectPlanFor({ verify_ssl: true, ca_bundle: '/definitely/not/here.pem', timeout: 30 })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(ConfigurationError)
    expect((error as ConfigurationError).errorType).toBe('ConfigurationError')
    const message = (error as Error).message
    expect(message).toContain('SPLUNK_CA_BUNDLE could not be read')
    expect(message).toContain('/definitely/not/here.pem')
    // 配置类错误的退出码是 2，而不是"意外错误"的 1。
    expect((error as ConfigurationError).details['path']).toBe('/definitely/not/here.pem')
  })
})

// --------------------------------------------------------------------------
// R2：超时（ADR §4.5）
// --------------------------------------------------------------------------

describe('undici 错误解包（不这么做的话用户只会看到 "fetch failed"）', () => {
  it('连接失败：消息与 cause 取自底层，而不是 "fetch failed"', async () => {
    const { fetchImpl } = throwingFetch([
      wrapped('Error', 'connect ECONNREFUSED 127.0.0.1:1', 'ECONNREFUSED'),
    ])
    let error: unknown = null
    try {
      await client(fetchImpl).get('/services/server/info')
    } catch (err) {
      error = err
    }
    const connectionError = error as SplunkConnectionError
    expect(connectionError).toBeInstanceOf(SplunkConnectionError)
    expect(connectionError.message).toBe(
      'cannot reach Splunk at https://splunk.example:8089: connect ECONNREFUSED 127.0.0.1:1',
    )
    expect(connectionError.message).not.toContain('fetch failed')
    // 非 TLS 信任类失败**不加**提示：这条消息被逐字锁定，必须保持稳定。
    expect(connectionError.message).not.toContain('hint:')
    expect(connectionError.details['cause']).toBe('ECONNREFUSED')
  })

  it('自签证书：附上可照做的处置提示，且不改动 cause', async () => {
    const { fetchImpl } = throwingFetch([
      wrapped('Error', 'self-signed certificate in certificate chain', 'SELF_SIGNED_CERT_IN_CHAIN'),
    ])
    let error: unknown = null
    try {
      await client(fetchImpl).get('/services/server/info')
    } catch (err) {
      error = err
    }
    const connectionError = error as SplunkConnectionError
    // 底层成因仍原样透出——提示只是追加，不是替换。
    expect(connectionError.message).toContain(
      'cannot reach Splunk at https://splunk.example:8089: self-signed certificate in certificate chain',
    )
    expect(connectionError.message).toContain('hint:')
    expect(connectionError.message).toContain('SPLUNK_VERIFY_SSL=false')
    // cause 不变：调用方仍按它做分支判断。
    expect(connectionError.details['cause']).toBe('SELF_SIGNED_CERT_IN_CHAIN')
  })

  it('SAN 不匹配：提示点明「光信任证书没用」', async () => {
    const { fetchImpl } = throwingFetch([
      wrapped(
        'Error',
        "Hostname/IP does not match certificate's altnames: IP: 203.0.113.10 is not in the cert's list",
        'ERR_TLS_CERT_ALTNAME_INVALID',
      ),
    ])
    let error: unknown = null
    try {
      await client(fetchImpl).get('/services/server/info')
    } catch (err) {
      error = err
    }
    const connectionError = error as SplunkConnectionError
    expect(connectionError.message).toContain('no SAN for this host')
    expect(connectionError.message).toContain('SPLUNK_VERIFY_SSL=false')
  })

  it('只有消息、没有已知错误码时，仍能识别自签证书', async () => {
    const { fetchImpl } = throwingFetch([wrapped('Error', 'self-signed certificate', 'SOME_CODE')])
    let error: unknown = null
    try {
      await client(fetchImpl).get('/services/server/info')
    } catch (err) {
      error = err
    }
    expect((error as SplunkConnectionError).message).toContain('hint:')
  })

  it('TLS 失败：自签证书的原因被带出来（R1 的诊断基础）', async () => {
    const { fetchImpl } = throwingFetch([
      wrapped('Error', 'self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'),
    ])
    let error: unknown = null
    try {
      await client(fetchImpl).get('/services/server/info')
    } catch (err) {
      error = err
    }
    const connectionError = error as SplunkConnectionError
    expect(connectionError.message).toContain('self-signed certificate')
    expect(connectionError.details['cause']).toBe('DEPTH_ZERO_SELF_SIGNED_CERT')
  })

  it('DNS 失败同样被解包', async () => {
    const { fetchImpl } = throwingFetch([wrapped('Error', 'getaddrinfo ENOTFOUND nope', 'ENOTFOUND')])
    let error: unknown = null
    try {
      await client(fetchImpl).get('/services/server/info')
    } catch (err) {
      error = err
    }
    expect((error as SplunkConnectionError).details['cause']).toBe('ENOTFOUND')
  })

  it('藏在 cause 里的超时仍被识别为超时', async () => {
    expect(
      isTimeoutError(new TypeError('fetch failed', { cause: timeoutError() })),
    ).toBe(true)
    const { fetchImpl } = throwingFetch([
      new TypeError('fetch failed', { cause: timeoutError() }),
    ])
    await expect(client(fetchImpl, { timeout: 2 }).get('/services/server/info')).rejects.toBeInstanceOf(
      SplunkTimeoutError,
    )
  })

  it('rootCause 不会在自引用链上死循环', () => {
    const loop: Error & { cause?: unknown } = new Error('outer')
    loop.cause = loop
    expect(rootCause(loop)).toBe(loop)
  })
})

describe('R3 代理：默认不遵循代理环境变量', () => {
  it('trust_env 关闭（默认）时用普通 Agent，不读代理环境变量', () => {
    expect(dispatcherKindFor(false)).toBe('Agent')
  })

  it('只有显式打开 trust_env 才用 EnvHttpProxyAgent', () => {
    expect(dispatcherKindFor(true)).toBe('EnvHttpProxyAgent')
  })

  it('设置 HTTP_PROXY 也不会改变默认行为（默认值来自配置，不来自环境）', () => {
    const original = process.env['HTTP_PROXY']
    process.env['HTTP_PROXY'] = 'http://proxy.invalid:3128'
    try {
      // 默认 trust_env=false → 仍然是 Agent，请求不会被系统代理劫持。
      expect(dispatcherKindFor(false)).toBe('Agent')
    } finally {
      if (original === undefined) delete process.env['HTTP_PROXY']
      else process.env['HTTP_PROXY'] = original
    }
  })
})

describe('R2 超时语义', () => {
  it('isTimeoutError 按 name / undici code 判定，不靠 message 文本', () => {
    expect(isTimeoutError(timeoutError())).toBe(true)
    expect(isTimeoutError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true)
    expect(isTimeoutError(Object.assign(new Error('x'), { code: 'UND_ERR_HEADERS_TIMEOUT' }))).toBe(true)
    expect(isTimeoutError(Object.assign(new Error('x'), { code: 'UND_ERR_BODY_TIMEOUT' }))).toBe(true)
    expect(isTimeoutError(connectionRefused())).toBe(false)
    expect(isTimeoutError(new Error('timed out'))).toBe(false)
  })

  it('读超时 → SplunkTimeoutError，消息逐字稳定（用 %g 格式化秒数）', async () => {
    const { fetchImpl } = throwingFetch([timeoutError()])
    let error: unknown = null
    try {
      await client(fetchImpl, { timeout: 1 }).post('/services/search/jobs', { search: 'x' })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(SplunkTimeoutError)
    expect((error as SplunkTimeoutError).message).toBe(
      'request timed out after 1s: POST /services/search/jobs to https://splunk.example:8089',
    )
    expect((error as SplunkTimeoutError).details).toEqual({
      method: 'POST',
      path: '/services/search/jobs',
    })
  })

  it('每次请求都带上 AbortSignal 作为总时长上限', async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(200, { ok: true })])
    await client(fetchImpl).get('/services/server/info')
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('服务端 504 → SplunkTimeoutError（不是 QueryError）', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(504, { messages: [{ text: 'gateway' }] })])
    await expect(client(fetchImpl).get('/services/server/info')).rejects.toBeInstanceOf(
      SplunkTimeoutError,
    )
  })

  it('服务端 408 → SplunkTimeoutError', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(408, '')])
    await expect(client(fetchImpl).get('/services/server/info')).rejects.toBeInstanceOf(
      SplunkTimeoutError,
    )
  })

  it('超时会重试，耗尽后抛出', async () => {
    const { fetchImpl, calls } = throwingFetch([timeoutError()])
    await expect(
      client(fetchImpl, { max_retries: 2 }).get('/services/server/info'),
    ).rejects.toBeInstanceOf(SplunkTimeoutError)
    expect(calls).toHaveLength(3) // 1 次 + 2 次重试
  })
})

// --------------------------------------------------------------------------
// R4：重试与认证语义
// --------------------------------------------------------------------------

describe('R4 重试白名单', () => {
  it('可重试状态码集合是 {502,503,504}', async () => {
    const { RETRYABLE_STATUS_CODES, NON_RETRYABLE_STATUS_CODES } = await import(
      '../server/client/http'
    )
    expect([...RETRYABLE_STATUS_CODES].sort()).toEqual([502, 503, 504])
    expect([...NON_RETRYABLE_STATUS_CODES].sort()).toEqual([400, 401, 403])
  })

  it('502 会重试并按退避次数重发，最后归类为 SplunkQueryError', async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(502, { messages: [{ text: 'bad gw' }] })])
    let error: unknown = null
    try {
      await client(fetchImpl, { max_retries: 2 }).get('/services/server/info')
    } catch (err) {
      error = err
    }
    expect(calls).toHaveLength(3)
    expect(error).toBeInstanceOf(SplunkQueryError)
    expect((error as SplunkQueryError).message).toBe(
      'Splunk returned HTTP 502 for GET /services/server/info: bad gw',
    )
  })

  it('502 之后成功：重试结果被正常返回', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      jsonResponse(502, ''),
      jsonResponse(200, { entry: [] }),
    ])
    const payload = await client(fetchImpl, { max_retries: 1 }).get('/services/server/info')
    expect(payload).toEqual({ entry: [] })
    expect(calls).toHaveLength(2)
  })

  it('503 也会重试', async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(503, '')])
    await expect(
      client(fetchImpl, { max_retries: 1 }).get('/services/server/info'),
    ).rejects.toBeInstanceOf(SplunkQueryError)
    expect(calls).toHaveLength(2)
  })

  it.each([400, 401, 403])('%s 绝不重试（只发一次请求）', async (status) => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(status, { messages: [{ text: 'nope' }] })])
    await expect(
      client(fetchImpl, { max_retries: 3 }).get('/services/server/info'),
    ).rejects.toBeInstanceOf(status === 400 ? SplunkQueryError : SplunkAuthenticationError)
    expect(calls).toHaveLength(1)
  })

  it('连接类错误会重试，耗尽后归类为 SplunkConnectionError', async () => {
    const { fetchImpl, calls } = throwingFetch([connectionRefused()])
    let error: unknown = null
    try {
      await client(fetchImpl, { max_retries: 1 }).get('/services/server/info')
    } catch (err) {
      error = err
    }
    expect(calls).toHaveLength(2)
    expect(error).toBeInstanceOf(SplunkConnectionError)
    const connectionError = error as SplunkConnectionError
    expect(connectionError.message).toContain('cannot reach Splunk at https://splunk.example:8089:')
    expect(connectionError.details['cause']).toBe('ECONNREFUSED')
  })

  it('自签证书失败**不重试**：重试不会让不被信任的证书变得可信', async () => {
    const { fetchImpl, calls } = throwingFetch([
      wrapped('Error', 'self-signed certificate in certificate chain', 'SELF_SIGNED_CERT_IN_CHAIN'),
    ])
    let error: unknown = null
    try {
      // max_retries: 3 —— 若照旧重试，这里会打 4 次并白等 3 次指数退避（默认约 3.5s）。
      await client(fetchImpl, { max_retries: 3 }).get('/services/server/info')
    } catch (err) {
      error = err
    }
    expect(calls).toHaveLength(1)
    expect(error).toBeInstanceOf(SplunkConnectionError)
    expect((error as Error).message).toContain('self-signed certificate in certificate chain')
    expect((error as SplunkConnectionError).details['cause']).toBe('SELF_SIGNED_CERT_IN_CHAIN')
  })

  it('SAN 不匹配、证书过期同样不重试', async () => {
    const cases: Array<[string, string]> = [
      [
        "Hostname/IP does not match certificate's altnames: IP: 203.0.113.10 is not in the cert's list",
        'ERR_TLS_CERT_ALTNAME_INVALID',
      ],
      ['certificate has expired', 'CERT_HAS_EXPIRED'],
    ]
    for (const [message, code] of cases) {
      const { fetchImpl, calls } = throwingFetch([wrapped('Error', message, code)])
      await expect(
        client(fetchImpl, { max_retries: 3 }).get('/services/server/info'),
      ).rejects.toBeInstanceOf(SplunkConnectionError)
      expect(calls, `${code} 不应重试`).toHaveLength(1)
    }
  })

  it('对照组：ECONNREFUSED 仍按次数重试（服务重启可能是暂时的）', async () => {
    const { fetchImpl, calls } = throwingFetch([connectionRefused()])
    await expect(
      client(fetchImpl, { max_retries: 3 }).get('/services/server/info'),
    ).rejects.toBeInstanceOf(SplunkConnectionError)
    expect(calls).toHaveLength(4)
  })
})

describe('证书类失败的分类（提示与重试决策共用同一套判断）', () => {
  it('证书类为 true；网络类与超时为 false（那些可能是暂时的）', () => {
    const certs: Array<[string, string]> = [
      ['self-signed certificate', 'SELF_SIGNED_CERT_IN_CHAIN'],
      ['self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'],
      ["does not match certificate's altnames", 'ERR_TLS_CERT_ALTNAME_INVALID'],
      ['certificate has expired', 'CERT_HAS_EXPIRED'],
      ['certificate is not yet valid', 'CERT_NOT_YET_VALID'],
    ]
    for (const [message, code] of certs) {
      expect(isDeterministicTlsFailure(wrapped('Error', message, code)), code).toBe(true)
    }

    // 这几种都可能是暂时的：服务重启、DNS 抖动、网络拥塞——重试是合理的。
    expect(isDeterministicTlsFailure(connectionRefused())).toBe(false)
    expect(isDeterministicTlsFailure(wrapped('Error', 'getaddrinfo ENOTFOUND h', 'ENOTFOUND'))).toBe(false)
    expect(isDeterministicTlsFailure(timeoutError())).toBe(false)
    expect(isDeterministicTlsFailure(new Error('boom'))).toBe(false)
  })
})

describe('R4 认证失败消息（逐字稳定）', () => {
  it('包含 HTTP 状态、用户名与基地址，并附带远端 detail', async () => {
    const { fetchImpl } = scriptedFetch([
      jsonResponse(401, { messages: [{ type: 'ERROR', text: 'injected failure' }] }),
    ])
    let error: unknown = null
    try {
      await client(fetchImpl).post('/services/search/jobs', { search: 'x' })
    } catch (err) {
      error = err
    }
    const authError = error as SplunkAuthenticationError
    expect(authError.message).toBe(
      'authentication failed (HTTP 401) for user splunk_user at https://splunk.example:8089: injected failure',
    )
    expect(authError.details).toEqual({
      status: 401,
      path: '/services/search/jobs',
      method: 'POST',
    })
  })

  it('无用户名时消息用 <anonymous>', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(403, '')])
    let error: unknown = null
    try {
      await client(fetchImpl, { username: '' }).get('/services/server/info')
    } catch (err) {
      error = err
    }
    expect((error as SplunkAuthenticationError).message).toContain('for user <anonymous> at')
  })

  it('错误里绝不出现密码或 Authorization 头', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(401, 'denied')])
    let error: unknown = null
    try {
      await client(fetchImpl).get('/services/server/info')
    } catch (err) {
      error = err
    }
    const serialized = JSON.stringify((error as SplunkAuthenticationError).toDict())
    expect(serialized).not.toContain('hunter2')
    expect(serialized.toLowerCase()).not.toContain('authorization')
    expect(serialized).not.toContain('Basic ')
  })
})

// --------------------------------------------------------------------------
// 请求构造与 JSON 解析
// --------------------------------------------------------------------------

describe('请求构造', () => {
  it('GET 把参数编码进查询串，null 丢弃、布尔小写', async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(200, {})])
    await client(fetchImpl).get('/services/search/jobs/x/results', {
      output_mode: 'json',
      count: 5,
      offset: 0,
      include_saved: true,
      dropped: null,
    })
    const url = new URL(calls[0]?.url ?? '')
    expect(url.searchParams.get('output_mode')).toBe('json')
    expect(url.searchParams.get('count')).toBe('5')
    expect(url.searchParams.get('offset')).toBe('0')
    expect(url.searchParams.get('include_saved')).toBe('true')
    expect(url.searchParams.has('dropped')).toBe(false)
  })

  it('POST 用表单编码并设置 Content-Type', async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(200, {})])
    await client(fetchImpl).post('/services/search/jobs', { search: 'index=x', exec_mode: 'normal' })
    const init = calls[0]?.init
    expect(init?.method).toBe('POST')
    expect(init?.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(init?.body).toBe('search=index%3Dx&exec_mode=normal')
  })

  it('带用户名时附 Basic 凭据，不带时省略', async () => {
    const withAuth = scriptedFetch([jsonResponse(200, {})])
    await client(withAuth.fetchImpl).get('/services/server/info')
    expect(withAuth.calls[0]?.init.headers['Authorization']).toBe(
      `Basic ${Buffer.from('splunk_user:hunter2').toString('base64')}`,
    )

    const withoutAuth = scriptedFetch([jsonResponse(200, {})])
    await client(withoutAuth.fetchImpl, { username: '' }).get('/services/server/info')
    expect(withoutAuth.calls[0]?.init.headers).not.toHaveProperty('Authorization')
  })

  it('User-Agent 带版本号与只读标记', async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(200, {})])
    await client(fetchImpl).get('/services/server/info')
    expect(calls[0]?.init.headers['User-Agent']).toMatch(/^splunk-cli\/\d+\.\d+\.\d+ \(\+read-only\)$/)
  })
})

describe('JSON 解析', () => {
  it('空正文解析为 {}（不是错误）', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(200, '')])
    await expect(client(fetchImpl).get('/services/server/info')).resolves.toEqual({})
  })

  it('畸形 JSON → SplunkResultError，消息含字节数与 content-type', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(200, '{ this is not json')])
    let error: unknown = null
    try {
      await client(fetchImpl).get('/services/server/info')
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(SplunkResultError)
    expect((error as SplunkResultError).message).toBe(
      'Splunk returned a body that is not valid JSON (18 bytes, content-type application/json)',
    )
  })

  it('JSON 数组 → SplunkResultError（期望对象）', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(200, '[1,2]')])
    await expect(client(fetchImpl).get('/services/server/info')).rejects.toBeInstanceOf(
      SplunkResultError,
    )
  })

  it('getText 返回原始正文', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(200, 'plain text')])
    await expect(client(fetchImpl).getText('/services/server/info')).resolves.toBe('plain text')
  })
})

describe('cleanParams / extractErrorDetailFromText', () => {
  it('cleanParams 丢弃 null/undefined 并把布尔转成小写字符串', () => {
    expect(cleanParams({ a: null, b: undefined, c: true, d: false, e: 1, f: 'x' })).toEqual({
      c: 'true',
      d: 'false',
      e: '1',
      f: 'x',
    })
  })

  it('优先用 messages[].text 并以 " | " 连接', () => {
    expect(
      extractErrorDetailFromText(
        JSON.stringify({ messages: [{ text: 'first' }, { text: 'second' }, { other: 1 }] }),
      ),
    ).toBe('first | second')
  })

  it('其次取 message / error / text 键', () => {
    expect(extractErrorDetailFromText(JSON.stringify({ message: 'm' }))).toBe('m')
    expect(extractErrorDetailFromText(JSON.stringify({ error: 'e' }))).toBe('e')
    expect(extractErrorDetailFromText(JSON.stringify({ text: 't' }))).toBe('t')
  })

  it('非 JSON 时取正文前 500 字符；空正文返回空串', () => {
    expect(extractErrorDetailFromText('not json')).toBe('not json')
    expect(extractErrorDetailFromText('x'.repeat(600))).toHaveLength(500)
    expect(extractErrorDetailFromText('')).toBe('')
  })

  it('数组或无法识别的结构返回空串', () => {
    expect(extractErrorDetailFromText('[1,2]')).toBe('')
    expect(extractErrorDetailFromText('{"nope":1}')).toBe('')
  })
})
