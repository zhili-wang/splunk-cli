import express from 'express'
import { describe, expect, it, vi } from 'vitest'
import request from 'supertest'

import { createApp } from '../../server/app'
import { SplunkConnectionError, SplunkError, SplunkQueryError, SplunkTimeoutError } from '../../server/errors'
import { setLoggerOutput } from '../../server/logger'
import { SafetyLimitError } from '../../server/safety/limits'
import {
  HTTP_STATUS_BY_ERROR_TYPE,
  errorHandler,
  statusFor,
} from '../../server/web/errors'
import { attachShutdownHandler } from '../../server/web/lifecycle'
import { WebRuntime } from '../../server/web/runtime'
import { VERSION } from '../../server/version'
import { jsonResponse, fixture, offlineClient, okSearchClient, settings } from './stub'

const NO_WEB = { webDir: null }

describe('/api/health', () => {
  it('探针成功 → 200 + success true', async () => {
    const app = createApp({ settings: settings(), client: okSearchClient(), ...NO_WEB })
    const response = await request(app).get('/api/health')
    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)
    expect(response.body.connection).toBe('ok')
    expect(response.body.authentication).toBe('ok')
  })

  it('include_license=false 时不查 license', async () => {
    const app = createApp({ settings: settings(), client: okSearchClient(), ...NO_WEB })
    const response = await request(app).get('/api/health?include_license=false')
    expect(response.body.license).toBeUndefined()
  })

  it('探针认证失败 → **仍是 200**，失败在报告内呈现（这是刻意的）', async () => {
    const client = offlineClient([
      { match: '/services/server/info', response: jsonResponse(401, { messages: [{ text: 'denied' }] }) },
    ])
    const app = createApp({ settings: settings(), client, ...NO_WEB })
    const response = await request(app).get('/api/health?include_license=false')
    expect(response.status).toBe(200)
    expect(response.body.success).toBe(false)
    expect(response.body.connection).toBe('ok')
    expect(response.body.authentication).toBe('failed')
    expect(response.body.error.type).toBe('SplunkAuthenticationError')
  })

  it('连不上 → 200 + connection failed（不是 5xx）', async () => {
    const client = offlineClient([
      {
        match: '/services/server/info',
        response: () => {
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
        },
      },
    ])
    const app = createApp({ settings: settings(), client, ...NO_WEB })
    const response = await request(app).get('/api/health?include_license=false')
    expect(response.status).toBe(200)
    expect(response.body.success).toBe(false)
    expect(response.body.connection).toBe('failed')
    expect(response.body.error.type).toBe('SplunkConnectionError')
  })
})

describe('/api/search · /api/stats · /api/timeline', () => {
  it('search 返回与 CLI --json 一致的载荷', async () => {
    const app = createApp({ settings: settings(), client: okSearchClient(), ...NO_WEB })
    const response = await request(app).post('/api/search').send({ query: 'index=app' })
    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)
    expect(response.body.query).toBe('index=app')
    expect(response.body.count).toBe(1)
    expect(response.body.time_range.duration_seconds).toBe(3600)
    // 面板的 Job 状态栏直接读这个块；它必须是 Service 模型的原样输出。
    expect(response.body.job.search_earliest_time).toBe(1789464924)
    expect(response.body.job.sample_ratio).toBe('1')
  })

  it('stats 返回 spl / function / by / rows', async () => {
    const app = createApp({
      settings: settings(),
      client: okSearchClient([{ host: 'api-01', count: '3' }]),
      ...NO_WEB,
    })
    const response = await request(app).post('/api/stats').send({ query: 'q', by: 'host' })
    expect(response.status).toBe(200)
    expect(response.body.spl).toContain('| stats count by host')
    expect(response.body.rows).toEqual([{ key: 'api-01', count: 3 }])
  })

  it('timeline 返回 span / total / timeline', async () => {
    const app = createApp({
      settings: settings(),
      client: okSearchClient([{ _time: 'T0', count: '2' }]),
      ...NO_WEB,
    })
    const response = await request(app).post('/api/timeline').send({ query: 'q' })
    expect(response.status).toBe(200)
    expect(response.body.span).toBe('5m')
    expect(response.body.total).toBe(2)
    expect(response.body.timeline).toEqual([{ time: 'T0', count: 2 }])
  })

  it('缺少 query → 422 + ValidationError 信封（而不是框架的 detail）', async () => {
    const app = createApp({ settings: settings(), client: okSearchClient(), ...NO_WEB })
    const response = await request(app).post('/api/search').send({})
    expect(response.status).toBe(422)
    expect(response.body.success).toBe(false)
    expect(response.body.error.type).toBe('ValidationError')
    expect(response.body.error.message).toContain('query')
  })

  it('多余字段被拒绝（strict 请求体）', async () => {
    const app = createApp({ settings: settings(), client: okSearchClient(), ...NO_WEB })
    const response = await request(app).post('/api/search').send({ query: 'q', nope: 1 })
    expect(response.status).toBe(422)
    expect(response.body.error.type).toBe('ValidationError')
  })

  it('畸形 JSON 正文 → 422（不是 500）', async () => {
    const app = createApp({ settings: settings(), client: okSearchClient(), ...NO_WEB })
    const response = await request(app)
      .post('/api/search')
      .set('Content-Type', 'application/json')
      .send('{ not json')
    expect(response.status).toBe(422)
    expect(response.body.error.type).toBe('ValidationError')
  })
})

describe('错误映射（HTTP 状态码表）', () => {
  it('表与契约完全一致', () => {
    expect(HTTP_STATUS_BY_ERROR_TYPE).toEqual({
      ConfigurationError: 500,
      SplunkAuthenticationError: 502,
      SplunkConnectionError: 502,
      SplunkQueryError: 400,
      SplunkJobError: 502,
      SplunkResultError: 502,
      SafetyLimitError: 422,
      SplunkTimeoutError: 504,
      ForbiddenOrigin: 403,
      FrontendNotBuilt: 503,
      ServiceNotStoppable: 503,
    })
  })

  it('statusFor：已知类型按表，未知类型 500', () => {
    expect(statusFor(new SplunkQueryError('x'))).toBe(400)
    expect(statusFor(new SplunkTimeoutError('x'))).toBe(504)
    expect(statusFor(new SafetyLimitError('x'))).toBe(422)
    expect(statusFor(new SplunkError('x'))).toBe(500)
    expect(statusFor(new Error('x'))).toBe(500)
  })

  it('安全上限 → 422，连接失败 → 502', async () => {
    const tooBig = createApp({
      settings: settings(),
      client: okSearchClient(),
      ...NO_WEB,
    })
    const limited = await request(tooBig)
      .post('/api/search')
      .send({ query: 'index=*', limit: 999999 })
    expect(limited.status).toBe(422)
    expect(limited.body.error.type).toBe('SafetyLimitError')

    const unreachable = createApp({
      settings: settings(),
      client: offlineClient([
        {
          match: '/services/search/jobs',
          response: () => {
            throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
          },
        },
      ]),
      ...NO_WEB,
    })
    const failed = await request(unreachable).post('/api/search').send({ query: 'index=app' })
    expect(failed.status).toBe(502)
    expect(failed.body.error.type).toBe('SplunkConnectionError')
  })

  it('意外异常 → 500 + InternalError，绝不泄漏异常原文，但**必须留在服务端日志里**', async () => {
    const app = express()
    app.get('/boom', () => {
      throw new Error('secret at /etc/passwd and password=hunter2')
    })
    app.use(errorHandler)

    // 响应体只给 `internal error`，所以日志是唯一的诊断入口——没有它，用户和我们都只能
    // 看到一个没有任何信息的 500。这条断言把"必须打日志"钉住。
    const captured: string[] = []
    setLoggerOutput((line) => captured.push(line))
    try {
      const response = await request(app).get('/boom')
      expect(response.status).toBe(500)
      expect(response.body).toEqual({
        success: false,
        error: { type: 'InternalError', message: 'internal error' },
      })
      expect(JSON.stringify(response.body)).not.toContain('passwd')
      expect(JSON.stringify(response.body)).not.toContain('hunter2')

      // 日志里有真实成因，且凭据已被脱敏。
      expect(captured.join('\n')).toContain('unhandled Error')
      expect(captured.join('\n')).toContain('passwd')
      expect(captured.join('\n')).not.toContain('hunter2')
    } finally {
      setLoggerOutput(null)
    }
  })
})

describe('/api/alerts', () => {
  it('默认只取已触发告警', async () => {
    const app = createApp({ settings: settings(), client: okSearchClient(), ...NO_WEB })
    const response = await request(app).get('/api/alerts')
    expect(response.status).toBe(200)
    expect(response.body.source).toBe('fired_alerts')
    expect(response.body.count).toBe(1)
  })

  it('include_saved=true 时同时列出已保存搜索', async () => {
    const app = createApp({ settings: settings(), client: okSearchClient(), ...NO_WEB })
    const response = await request(app).get('/api/alerts?include_saved=true')
    expect(response.body.source).toBe('both')
    expect(response.body.saved_count).toBe(2)
  })

  it('端点不可用 → 空列表 + note，状态仍是 200', async () => {
    const client = offlineClient([
      { match: '/services/alerts/fired_alerts', response: jsonResponse(404, { messages: [] }) },
    ])
    const app = createApp({ settings: settings(), client, ...NO_WEB })
    const response = await request(app).get('/api/alerts')
    expect(response.status).toBe(200)
    expect(response.body.source).toBe('unavailable')
    expect(response.body.note).toContain('unavailable')
  })
})

describe('/api/overview', () => {
  it('三个子查询都成功 → 面板与指标齐全', async () => {
    const app = createApp({
      settings: settings(),
      client: okSearchClient([{ _time: 'T0', count: '5' }]),
      ...NO_WEB,
    })
    const response = await request(app).post('/api/overview').send({ query: 'index=app' })
    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)
    expect(response.body.partial).toBe(false)
    expect(response.body.metrics.events).toBe(5)
    expect(response.body.errors).toEqual({})
  })

  it('某个分布失败 → 只降级它自己：面板 null、指标 null、partial=true', async () => {
    const app = createApp({
      settings: settings(),
      // ⚠ 顺序即优先级：job 状态/结果这类**具体路径必须在泛化的 create 之前**，
      // 否则 `GET /jobs/s` 会被 create 的桩接走，返回 `{sid}` 而永远到不了终态。
      client: offlineClient([
        { match: '/services/search/jobs/s/results', response: jsonResponse(200, { results: [{ _time: 'T0', count: '5' }] }) },
        { match: '/services/search/jobs/s/messages', response: jsonResponse(200, { messages: [] }) },
        { match: '/services/search/jobs/s', response: jsonResponse(200, fixture('job_done')) },
        { match: '/services/search/jobs', bodyIncludes: 'stats', response: jsonResponse(500, { messages: [{ text: 'boom' }] }) },
        { match: '/services/search/jobs', response: jsonResponse(200, { sid: 's' }) },
      ]),
      ...NO_WEB,
    })
    const response = await request(app).post('/api/overview').send({ query: 'index=app' })
    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)
    expect(response.body.partial).toBe(true)
    expect(response.body.by_service).toBeNull()
    expect(response.body.by_host).toBeNull()
    expect(response.body.metrics.services).toBeNull()
    expect(response.body.metrics.hosts).toBeNull()
    expect(response.body.errors.by_service.type).toBe('SplunkQueryError')
    // 时间线成功，所以 events 有值——null 与 0 的差别是契约的一部分
    expect(response.body.metrics.events).toBe(5)
  })

  it('时间线失败 → 整体 success=false（它就是首屏本身）', async () => {
    const app = createApp({
      settings: settings(),
      client: offlineClient([
        { match: '/services/search/jobs/s/results', response: jsonResponse(200, { results: [{ _time: 'T0', count: '5' }] }) },
        { match: '/services/search/jobs/s/messages', response: jsonResponse(200, { messages: [] }) },
        { match: '/services/search/jobs/s', response: jsonResponse(200, fixture('job_done')) },
        { match: '/services/search/jobs', bodyIncludes: 'timechart', response: jsonResponse(500, { messages: [{ text: 'boom' }] }) },
        { match: '/services/search/jobs', response: jsonResponse(200, { sid: 's' }) },
      ]),
      ...NO_WEB,
    })
    const response = await request(app).post('/api/overview').send({ query: 'index=app' })
    expect(response.status).toBe(200)
    expect(response.body.success).toBe(false)
    expect(response.body.partial).toBe(true)
    expect(response.body.timeline).toBeNull()
    expect(response.body.metrics.buckets).toBeNull()
  })

  it('时间范围超限 → 422（在花掉三个查询之前就拒绝）', async () => {
    const app = createApp({ settings: settings(), client: okSearchClient(), ...NO_WEB })
    const response = await request(app)
      .post('/api/overview')
      .send({ query: 'index=app', earliest: '-30d' })
    expect(response.status).toBe(422)
    expect(response.body.error.type).toBe('SafetyLimitError')
  })
})

describe('/api/version', () => {
  it('返回面板自己这一版的版本号', async () => {
    const app = createApp({ settings: settings(), client: okSearchClient(), ...NO_WEB })
    const response = await request(app).get('/api/version')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ name: 'splunk-cli', version: VERSION })
  })

  it('不读 Splunk：客户端一次都没被调用', async () => {
    // 唯一一条纯本地的 API。任何一次远端请求都说明它悄悄变成了 Splunk 读取。
    let calls = 0
    const app = createApp({
      settings: settings(),
      client: offlineClient([
        {
          match: '/services/',
          response: () => {
            calls += 1
            return jsonResponse(200, {})
          },
        },
      ]),
      ...NO_WEB,
    })
    const response = await request(app).get('/api/version')
    expect(response.status).toBe(200)
    expect(calls).toBe(0)
  })
})

describe('/api/shutdown', () => {
  it('宿主没交出关闭句柄 → 503，而不是假装成功', async () => {
    // 直接 `createApp()` 的宿主（supertest、把 app 嵌进别的进程）就是这种情况。
    // 应答 `{"success": true}` 会让页面显示「已停止」而进程其实还在跑 ——
    // 那比报错更糟，因为用户会去关掉终端却发现自己早就"关过了"。
    const app = createApp({ settings: settings(), client: okSearchClient(), ...NO_WEB })

    const response = await request(app).post('/api/shutdown')

    expect(response.status).toBe(503)
    expect(response.body.error.type).toBe('ServiceNotStoppable')
    // 报错信息必须给出下一步 —— 用户看不见钩子，只能靠这句话知道该去做什么。
    expect(response.body.error.message).toContain('Ctrl-C')
  })

  it('不读 Splunk：客户端一次都没被调用', async () => {
    // 与 `/api/version` 同一条约束。关的是这个进程，不是任何 Splunk 资源。
    let calls = 0
    const app = createApp({
      settings: settings(),
      client: offlineClient([
        {
          match: '/services/',
          response: () => {
            calls += 1
            return jsonResponse(200, {})
          },
        },
      ]),
      ...NO_WEB,
    })

    await request(app).post('/api/shutdown')

    expect(calls).toBe(0)
  })

  it('挂了钩子 → 200；且响应到手的那一刻**还没有**关闭', async () => {
    const app = createApp({ settings: settings(), client: okSearchClient(), ...NO_WEB })
    let closed = 0
    attachShutdownHandler(app, () => {
      closed += 1
    })

    const response = await request(app).post('/api/shutdown')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ success: true, stopping: true })
    // 顺序契约，也是整个宽限窗口存在的唯一理由：先回响应、后关闭。
    // 反过来的话浏览器看到的是连接重置而不是这个 200，用户以为按钮没生效，
    // 于是反复点一个其实已经生效的按钮（见 lifecycle.ts 的 SHUTDOWN_GRACE_MS）。
    expect(closed).toBe(0)

    await vi.waitFor(() => {
      expect(closed).toBe(1)
    })
  })
})

describe('WebRuntime', () => {
  it('同一服务类型只构造一次', () => {
    const runtime = new WebRuntime(settings(), { client: okSearchClient() })
    const first = runtime.service(Object as never)
    expect(runtime.service(Object as never)).toBe(first)
    void first
  })

  it('注入的客户端不被运行时关闭（所有权归调用方）', async () => {
    const client = okSearchClient()
    let closed = false
    client.close = async () => {
      closed = true
    }
    const runtime = new WebRuntime(settings(), { client })
    await runtime.close()
    expect(closed).toBe(false)
  })
})
