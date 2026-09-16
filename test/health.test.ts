import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { FetchLike, HttpResponseLike } from '../server/client/http'
import { SplunkClient } from '../server/client/splunk'
import { loadSettings, type Settings } from '../server/config/settings'
import { HealthReport, LicenseInfo, ServerInfo, unixToIso } from '../server/models/health'
import { HealthService } from '../server/services/health'

function makeSettings(): Settings {
  return loadSettings(
    { host: 'splunk.example', username: 'u', password: 'p', max_retries: '0', retry_backoff: '0' },
    { SPLUNK_CONFIG_DIR: join(tmpdir(), 'splunk-cli-health-tests-no-such-dir') },
    join(tmpdir(), 'splunk-cli-health-tests-no-such-cwd'),
  )
}

function jsonResponse(status: number, body: unknown): HttpResponseLike {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => text,
  }
}

function scriptedFetch(responses: HttpResponseResponse[]): FetchLike {
  let index = 0
  return async () => {
    const response = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (response === undefined) throw new Error('scriptedFetch: 空脚本')
    return response
  }
}
type HttpResponseResponse = HttpResponseLike

function makeClient(fetchImpl: FetchLike): SplunkClient {
  return new SplunkClient(makeSettings(), { fetch: fetchImpl, dispatcher: { close: async () => {} } })
}

function fixture(name: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`./fixtures/splunk/${name}.json`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('unixToIso：ISO-8601 时间戳', () => {
  it('微秒为 0 时省略小数，偏移写成 +00:00（不是 Z）', () => {
    // 期望值来自实测：epoch 1756375331 → 2025-08-28T10:02:11+00:00
    expect(unixToIso(1756375331)).toBe('2025-08-28T10:02:11+00:00')
  })

  it('有小数秒时补足 6 位微秒', () => {
    expect(unixToIso(1756375331.5)).toBe('2025-08-28T10:02:11.500000+00:00')
  })

  it('非数值字符串原样返回，空值返回 null', () => {
    expect(unixToIso('already-iso')).toBe('already-iso')
    expect(unixToIso('')).toBeNull()
    expect(unixToIso(null)).toBeNull()
    expect(unixToIso(undefined)).toBeNull()
  })

  it('数字字符串按 epoch 解析', () => {
    expect(unixToIso('1756375331')).toBe('2025-08-28T10:02:11+00:00')
  })
})

describe('ServerInfo.fromApi（用真实 fixture）', () => {
  it('解析真实 server_info 响应', () => {
    const info = ServerInfo.fromApi(fixture('server_info'))
    expect(info.version).toBe('8.0.2')
    expect(info.server_name).toBe('splunk-dev-01')
    expect(info.guid).toBe('00000000-0000-4000-8000-000000000000')
    expect(info.health).toBe('unknown')
    expect(info.cpu_arch).toBe('x86_64')
    expect(info.os_name).toBe('Linux')
  })

  it('toPublicDict 保留 null', () => {
    const info = new ServerInfo({
      version: 'x',
      build: null,
      server_name: null,
      guid: null,
      license_state: null,
      health: 'unknown',
      os_name: null,
      cpu_arch: null,
      server_start_time: null,
    })
    expect(Object.keys(info.toPublicDict())).toEqual([
      'version',
      'build',
      'server_name',
      'guid',
      'license_state',
      'health',
      'os_name',
      'cpu_arch',
      'server_start_time',
    ])
    expect(info.toPublicDict()['build']).toBeNull()
  })
})

describe('HealthReport.toPublicDict', () => {
  const info = new ServerInfo({
    version: '8.0.2',
    build: 'abc',
    server_name: 'srv',
    guid: 'g',
    license_state: 'OK',
    health: 'unknown',
    os_name: 'Linux',
    cpu_arch: 'x86_64',
    server_start_time: '2026-08-28T10:02:11+00:00',
  })

  it('成功时剔除 null 字段，且没有 error 键', () => {
    const report = new HealthReport({
      success: true,
      splunk: info,
      connection: 'ok',
      authentication: 'ok',
      health: 'unknown',
      license: new LicenseInfo({ status: 'unknown', reason: 'SplunkAuthenticationError', pools: [] }),
      latency_ms: 7.2,
    })
    const payload = report.toPublicDict()
    expect(Object.keys(payload)).toEqual([
      'success',
      'splunk',
      'connection',
      'authentication',
      'health',
      'license',
      'latency_ms',
    ])
    expect(payload['error']).toBeUndefined()
    expect(payload['latency_ms']).toBe(7.2)
  })

  it('失败时套标准错误信封，并按维度推导 error.type', () => {
    const authFailure = new HealthReport({
      success: false,
      connection: 'ok',
      authentication: 'failed',
      health: 'unknown',
      latency_ms: 3.1,
      error: 'authentication failed (HTTP 401) for user u at https://h:8089',
    })
    const payload = authFailure.toPublicDict()
    expect(payload['splunk']).toBeUndefined()
    expect(payload['license']).toBeUndefined()
    expect(payload['connection']).toBe('ok')
    expect(payload['authentication']).toBe('failed')
    expect(payload['error']).toEqual({
      type: 'SplunkAuthenticationError',
      message: 'authentication failed (HTTP 401) for user u at https://h:8089',
    })
    expect(authFailure.failureExitCode()).toBe(3)

    const connFailure = new HealthReport({
      success: false,
      connection: 'failed',
      authentication: 'unknown',
      error: 'cannot reach Splunk',
    })
    expect(connFailure.toPublicDict()['error']).toMatchObject({ type: 'SplunkConnectionError' })
    expect(connFailure.failureExitCode()).toBe(4)
  })

  it('失败的探针即使没有 error 文本也给出兜底消息', () => {
    const report = new HealthReport({ success: false, connection: 'failed', authentication: 'unknown' })
    expect(report.toPublicDict()['error']).toEqual({
      type: 'SplunkConnectionError',
      message: 'Splunk health probe failed',
    })
  })

  it('成功时退出码为 0', () => {
    expect(new HealthReport({}).failureExitCode()).toBe(0)
  })
})

describe('HealthService', () => {
  it('探针成功：connection/authentication 均为 ok，license 降级也如实呈现', async () => {
    const client = makeClient(
      scriptedFetch([
        jsonResponse(200, fixture('server_info')),
        jsonResponse(403, { messages: [{ text: 'Forbidden' }] }),
      ]),
    )
    const report = await new HealthService(client).health()
    expect(report.success).toBe(true)
    expect(report.connection).toBe('ok')
    expect(report.authentication).toBe('ok')
    expect(report.splunk?.version).toBe('8.0.2')
    // licenser 端点 403 → 优雅降级，不影响整体成功
    expect(report.license?.status).toBe('unknown')
    expect(report.license?.reason).toBe('SplunkAuthenticationError')
    expect(report.license?.pools).toEqual([])
  })

  it('includeLicense=false 时不查 license', async () => {
    let calls = 0
    const client = makeClient(async () => {
      calls += 1
      return jsonResponse(200, fixture('server_info'))
    })
    const report = await new HealthService(client).health({ includeLicense: false })
    expect(report.license).toBeNull()
    expect(calls).toBe(1)
  })

  it('认证失败：报告内呈现（不抛错），connection=ok 且 authentication=failed', async () => {
    const client = makeClient(scriptedFetch([jsonResponse(401, { messages: [{ text: 'denied' }] })]))
    const report = await new HealthService(client).health()
    expect(report.success).toBe(false)
    expect(report.connection).toBe('ok')
    expect(report.authentication).toBe('failed')
    expect(report.splunk).toBeNull()
    expect(report.failureExitCode()).toBe(3)
  })

  it('连接失败：connection=failed 且 authentication=unknown', async () => {
    const client = makeClient(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' })
    })
    const report = await new HealthService(client).health()
    expect(report.success).toBe(false)
    expect(report.connection).toBe('failed')
    expect(report.authentication).toBe('unknown')
    expect(report.failureExitCode()).toBe(4)
    expect(report.error).toContain('cannot reach Splunk')
  })
})
