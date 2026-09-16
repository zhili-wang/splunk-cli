/**
 * 真实 Splunk 集成测试 —— **默认不执行**，必须显式开启。
 *
 * ```bash
 * export RUN_SPLUNK_INTEGRATION_TESTS=1
 * export SPLUNK_URL="https://203.0.113.10:8089"
 * export SPLUNK_USERNAME="..."
 * export SPLUNK_PASSWORD="..."          # 绝不提交
 * export SPLUNK_VERIFY_SSL=false        # 开发环境自签名证书
 * npm run test:integration
 * ```
 *
 * 三条硬约束（AGENTS.md §2.16、§7）：
 *   1. **默认不执行**：开关没开、或凭据不全时整个文件 skip，因此 `npm test`
 *      始终不需要任何外部依赖；
 *   2. **凭据只来自环境变量**：本文件里没有任何主机名、用户名或密码字面量；
 *   3. **隔离**：只创建搜索 Job 与读取端点，不写 Splunk 配置、不删数据。
 *
 * skip 而不是 fail 是刻意的：CI 上没有真实 Splunk，缺凭据是正常状态而非故障。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { SplunkClient } from '../../server/client/splunk'
import { loadSettings } from '../../server/config/settings'
import {
  SplunkAuthenticationError,
  SplunkConnectionError,
  SplunkTimeoutError,
} from '../../server/errors'
import { SafetyLimitError } from '../../server/safety/limits'
import { AlertsService } from '../../server/services/alerts'
import { FieldsService } from '../../server/services/fields'
import { HealthService } from '../../server/services/health'
import { SearchService } from '../../server/services/search'
import { StatsService } from '../../server/services/stats'
import { TimelineService } from '../../server/services/timeline'

/** 开启集成测试的环境变量开关。 */
const SWITCH = 'RUN_SPLUNK_INTEGRATION_TESTS'

/**
 * 一个在任何 Splunk 实例上都能跑、且不需要额外索引权限的最小查询。
 * `index=_internal` 是 Splunk 自身的内部索引，始终存在。
 */
const SMOKE_QUERY = 'search index=_internal | head 5'

/** 开关是否被显式打开。 */
function enabled(): boolean {
  return ['1', 'true', 'yes'].includes((process.env[SWITCH] ?? '').trim().toLowerCase())
}

/**
 * 判断是否应当跳过整个文件。
 *
 * @returns 跳过原因；条件齐全时返回 `null`。
 */
function skipReason(): string | null {
  if (!enabled()) return `设置 ${SWITCH}=1 才会执行集成测试`
  if (!process.env['SPLUNK_URL'] && !process.env['SPLUNK_HOST']) {
    return '缺少 SPLUNK_URL（或 SPLUNK_HOST/SPLUNK_PORT）'
  }
  const missing = ['SPLUNK_USERNAME', 'SPLUNK_PASSWORD'].filter((name) => !process.env[name])
  if (missing.length > 0) return `缺少环境变量: ${missing.join(', ')}`
  return null
}

const REASON = skipReason()

// 默认静默（未开启是正常状态）；但如果有人**开了开关**却因凭据不全而跳过，
// 必须说出来，否则"测试全绿"会被误读成"真的验过了真实实例"。
if (REASON !== null && enabled()) {
  process.stderr.write(`[integration] 跳过真实 Splunk 集成测试：${REASON}\n`)
}

/** 真实实例上的客户端；凭证缺失时保持为 null。 */
let client: SplunkClient | null = null

/**
 * 断言某个调用以**指定错误类型之一**失败。
 *
 * 不用 `rejects.toBeInstanceOf` 是因为有些场景（例如错误凭据）在真实部署里既可能是
 * `SplunkAuthenticationError`，也可能是认证失败后直接断开导致的 `SplunkConnectionError`
 * ——两者都是正确答案，硬性指定一种会让测试变成对部署细节的断言。
 */
async function expectFailureOf(
  promise: Promise<unknown>,
  expected: ReadonlyArray<new (...args: never[]) => Error>,
): Promise<void> {
  const names = expected.map((type) => type.name).join(' / ')
  let error: unknown
  try {
    await promise
  } catch (caught) {
    error = caught
  }
  if (error === undefined) throw new Error(`期望以 ${names} 失败，但调用成功了`)
  if (!expected.some((type) => error instanceof type)) {
    const actual = error instanceof Error ? error.constructor.name : typeof error
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`期望 ${names}，实际是 ${actual}: ${message}`)
  }
}

beforeAll(() => {
  if (REASON !== null) return
  client = new SplunkClient(loadSettings())
})

afterAll(async () => {
  await client?.close()
})

describe.skipIf(REASON !== null)('连通性与认证', () => {
  it('HTTPS 连接与认证都能通过', async () => {
    const info = await client!.serverInfo()
    expect(info.version).not.toBe('unknown')
    expect(info.server_name).toBeTruthy()
  })

  it('server info 的公开视图形状稳定', async () => {
    const payload = (await client!.serverInfo()).toPublicDict()
    expect(typeof payload['version']).toBe('string')
    expect(['green', 'yellow', 'red', 'unknown']).toContain(payload['health'])
  })

  it('错误凭据被拒绝，绝不静默成功', async () => {
    // 只覆盖 password：其余字段仍旧从环境变量读取（override 优先级最高）。
    const failing = new SplunkClient(loadSettings({ password: 'definitely-not-the-password' }))
    try {
      await expectFailureOf(failing.serverInfo(), [
        SplunkAuthenticationError,
        SplunkConnectionError,
      ])
    } finally {
      await failing.close()
    }
  })

  it('不可达主机报连接错误，而不是超时或成功', async () => {
    // 192.0.2.0/24 是 RFC 5737 保留给文档的地址，永不路由。
    const failing = new SplunkClient(
      loadSettings({
        url: 'https://192.0.2.1:8089',
        timeout: '3',
        max_retries: '0',
        retry_backoff: '0',
      }),
    )
    try {
      await expectFailureOf(failing.serverInfo(), [SplunkConnectionError])
    } finally {
      await failing.close()
    }
  })
})

describe.skipIf(REASON !== null)('health', () => {
  it('探针报告 ok 且失败退出码为 0', async () => {
    const report = await new HealthService(client!).health()
    expect(report.connection).toBe('ok')
    expect(report.authentication).toBe('ok')
    expect(report.splunk).not.toBeNull()
    expect(report.failureExitCode()).toBe(0)
  })

  it('includeLicense=false 时 license 为 null 但仍成功', async () => {
    const report = await new HealthService(client!).health({ includeLicense: false })
    expect(report.success).toBe(true)
    expect(report.license).toBeNull()
  })
})

describe.skipIf(REASON !== null)('search', () => {
  it('冒烟搜索返回 sid、时间范围与稳定信封', async () => {
    const result = await new SearchService(client!).search(SMOKE_QUERY, {
      earliest: '-1h',
      latest: 'now',
      limit: 5,
    })
    expect(result.sid).toBeTruthy()
    expect(result.count).toBeLessThanOrEqual(5)
    expect(result.time_range).not.toBeNull()
    const payload = result.toPublicDict()
    expect(payload['success']).toBe(true)
    expect(payload['query']).toBe(SMOKE_QUERY)
    expect(payload['count']).toBe(result.count)
  })

  it('结果行是扁平的 JSON 对象（键都是字符串）', async () => {
    const result = await new SearchService(client!).search(SMOKE_QUERY, { limit: 3 })
    for (const row of result.results) {
      expect(row).not.toBeNull()
      expect(typeof row).toBe('object')
      expect(Object.keys(row).every((key) => typeof key === 'string')).toBe(true)
    }
  })

  it('空结果不是错误', async () => {
    const result = await new SearchService(client!).search(
      'search index=_internal sourcetype="__does_not_exist__"',
      { limit: 5 },
    )
    expect(result.count).toBe(0)
    expect(result.results).toEqual([])
  })

  it('Job 超时被如实报告为 SplunkTimeoutError', async () => {
    // 预算 0.5s + 10ms 轮询：一个 stats 查询不可能这么快跑完，必然超时。
    const impatient = new SearchService(client!, { pollInterval: 0.01, searchTimeout: 0.5 })
    await expectFailureOf(
      impatient.search('search index=_internal | stats count by sourcetype', { limit: 1 }),
      [SplunkTimeoutError],
    )
  })

  it('limit 被尊重，且 truncated 如实告知还有更多', async () => {
    const result = await new SearchService(client!).search('search index=_internal', { limit: 2 })
    expect(result.count).toBeLessThanOrEqual(2)
    expect(result.truncated).toBe(true)
  })
})

describe.skipIf(REASON !== null)('聚合：stats / timeline / fields', () => {
  it('stats --by sourcetype 生成有界的 SPL', async () => {
    const result = await new StatsService(client!).stats('search index=_internal', {
      by: 'sourcetype',
      limit: 5,
    })
    expect(result.spl.endsWith('| head 5')).toBe(true)
    expect(result.rows.length).toBeLessThanOrEqual(5)
    const payload = result.toPublicDict()
    expect(payload['success']).toBe(true)
    expect(payload['by']).toEqual(['sourcetype'])
  })

  it('timeline 的分桶总数与各桶之和一致', async () => {
    const result = await new TimelineService(client!).timeline('search index=_internal', {
      span: '5m',
      earliest: '-30m',
      limit: 20,
    })
    expect(result.span).toBe('5m')
    expect(result.timeline.every((point) => point.count >= 0)).toBe(true)
    expect(result.total).toBe(result.timeline.reduce((sum, point) => sum + point.count, 0))
  })

  it('fields 发现返回非空字段名列表', async () => {
    const result = await new FieldsService(client!).fields('search index=_internal', {
      earliest: '-30m',
      limit: 20,
    })
    expect(Array.isArray(result.fields)).toBe(true)
    expect(result.fields.every((name) => typeof name === 'string' && name.length > 0)).toBe(true)
    const payload = result.toPublicDict()
    expect(payload['success']).toBe(true)
    expect(payload['count']).toBe(result.fields.length)
  })
})

describe.skipIf(REASON !== null)('alerts', () => {
  it('告警列表可读且永不抛错', async () => {
    const result = await new AlertsService(client!).alerts({ count: 5 })
    const payload = result.toPublicDict()
    expect(payload['success']).toBe(true)
    // 新版 Splunk 已经移除 fired_alerts 端点；此时"空列表 + note"才是诚实且非致命的结果。
    expect(Array.isArray(result.fired)).toBe(true)
    if (result.note) expect(result.fired).toEqual([])
  })

  it('已保存搜索可读且都有名字', async () => {
    const result = await new AlertsService(client!).alerts({ count: 3, includeSaved: true })
    expect(result.saved.every((saved) => Boolean(saved.name))).toBe(true)
  })
})

describe.skipIf(REASON !== null)('安全上限在真实实例上同样生效', () => {
  it('过宽的时间范围在发出任何请求之前就被拒绝', async () => {
    await expectFailureOf(
      new SearchService(client!).search('index=*', { earliest: '-30d' }),
      [SafetyLimitError],
    )
  })

  it('被禁的写命令被拒绝', async () => {
    await expectFailureOf(
      new SearchService(client!).search('index=_internal | delete'),
      [SafetyLimitError],
    )
  })
})
