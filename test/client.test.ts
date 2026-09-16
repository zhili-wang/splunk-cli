import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  SplunkClient,
  entries,
  normaliseQuery,
} from '../server/client/splunk'
import type { FetchInitLike, FetchLike, HttpResponseLike } from '../server/client/http'
import { loadSettings, type Settings } from '../server/config/settings'
import { SplunkJobError, SplunkQueryError, SplunkResultError, SplunkTimeoutError } from '../server/errors'

// --------------------------------------------------------------------------
// 测试替身与隔离
// --------------------------------------------------------------------------

/** 隔离配置：两个路径都不存在，所以不会读到真实的 ~/.splunk-cli 或 ./.env。 */
function makeSettings(overrides: Record<string, string | number> = {}): Settings {
  return loadSettings(
    {
      host: 'splunk.example',
      username: 'splunk_user',
      password: 'hunter2',
      max_retries: '0',
      retry_backoff: '0',
      ...overrides,
    },
    { SPLUNK_CONFIG_DIR: join(tmpdir(), 'splunk-cli-client-tests-no-such-dir') },
    join(tmpdir(), 'splunk-cli-client-tests-no-such-cwd'),
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

interface RecordedCall {
  url: string
  init: FetchInitLike
}

function scriptedFetch(responses: HttpResponseLike[]): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const response = responses[Math.min(calls.length - 1, responses.length - 1)]
    if (response === undefined) throw new Error('scriptedFetch: 空脚本')
    return response
  }
  return { fetchImpl, calls }
}

function makeClient(
  fetchImpl: FetchLike,
  settings: Settings = makeSettings(),
): SplunkClient {
  return new SplunkClient(settings, { fetch: fetchImpl, dispatcher: { close: async () => {} } })
}

/** 真实 fixture（由抓取脚本从 Splunk 8.0.2 抓取）。 */
function fixture(name: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`./fixtures/splunk/${name}.json`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** 由真实 DONE fixture 派生的 RUNNING 变体：只改状态字段，其余保持真实形状。 */
function runningJob(): Record<string, unknown> {
  const base = structuredClone(fixture('job_done'))
  const entry = (base['entry'] as Array<Record<string, unknown>>)[0]
  const content = entry?.['content'] as Record<string, unknown>
  content['dispatchState'] = 'RUNNING'
  content['isDone'] = false
  content['isFailed'] = false
  content['doneProgress'] = 0.5
  return base
}

function failedJob(): Record<string, unknown> {
  return fixture('job_failed')
}

// --------------------------------------------------------------------------
// normaliseQuery：Q12 决策的行为钉子
// --------------------------------------------------------------------------

describe('normaliseQuery（ADR §5.10 / Q12：刻意保留缺陷）', () => {
  it('前导管道查询被**加上** search 前缀——这是刻意的行为钉子，必须一致', () => {
    // ⚠ 这不是"期望的正确行为"，而是"必须钉住的现状"（Q12）。
    expect(normaliseQuery('| tstats count')).toBe('search | tstats count')
    expect(normaliseQuery('| makeresults count=5')).toBe('search | makeresults count=5')
  })

  it('生成式命令（不带管道）原样透传——存在绕行写法', () => {
    expect(normaliseQuery('makeresults count=5')).toBe('makeresults count=5')
    expect(normaliseQuery('search index=app')).toBe('search index=app')
    expect(normaliseQuery('tstats count')).toBe('tstats count')
  })

  it('含 = 的裸条件被补上 search 前缀', () => {
    expect(normaliseQuery('index=app level=ERROR')).toBe('search index=app level=ERROR')
    expect(normaliseQuery('  index=app  ')).toBe('search index=app')
  })

  it('空查询 → SplunkQueryError', () => {
    expect(() => normaliseQuery('   ')).toThrowError(SplunkQueryError)
    expect(() => normaliseQuery('   ')).toThrowError('search query is empty')
  })
})

// --------------------------------------------------------------------------
// Job 创建
// --------------------------------------------------------------------------

describe('createSearchJob', () => {
  it('从**顶层** sid 读取（真实响应只有这一个键），并发送正确的表单字段', async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(200, { sid: '1700000000.00001' })])
    const sid = await makeClient(fetchImpl).createSearchJob('makeresults count=5', {
      earliestTime: '-1h',
      latestTime: 'now',
      maxCount: 5000,
    })
    expect(sid).toBe('1700000000.00001')

    const init = calls[0]?.init
    expect(init?.method).toBe('POST')
    const body = new URLSearchParams(init?.body ?? '')
    expect(body.get('search')).toBe('makeresults count=5')
    expect(body.get('exec_mode')).toBe('normal')
    expect(body.get('output_mode')).toBe('json')
    expect(body.get('earliest_time')).toBe('-1h')
    expect(body.get('latest_time')).toBe('now')
    expect(body.get('max_count')).toBe('5000')
  })

  it('缺陷在请求层可见：| tstats 发出去的是 "search | tstats count"', async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(200, { sid: 'x' })])
    await makeClient(fetchImpl).createSearchJob('| tstats count')
    const body = new URLSearchParams(calls[0]?.init.body ?? '')
    expect(body.get('search')).toBe('search | tstats count')
  })

  it('可选字段缺省时不发送', async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(200, { sid: 'x' })])
    await makeClient(fetchImpl).createSearchJob('makeresults count=1')
    const body = new URLSearchParams(calls[0]?.init.body ?? '')
    expect(body.has('earliest_time')).toBe(false)
    expect(body.has('latest_time')).toBe(false)
    expect(body.has('max_count')).toBe(false)
  })

  it('响应缺少 sid → SplunkResultError，details 带顶层键', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(200, { entry: [], paging: {} })])
    let error: unknown = null
    try {
      await makeClient(fetchImpl).createSearchJob('makeresults count=1')
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(SplunkResultError)
    expect((error as SplunkResultError).message).toBe(
      'Splunk accepted the search request but returned no search id (sid)',
    )
    expect((error as SplunkResultError).details).toEqual({ keys: ['entry', 'paging'] })
  })
})

// --------------------------------------------------------------------------
// 结果解析
// --------------------------------------------------------------------------

describe('getSearchResults', () => {
  it('解析真实 fixture 的结果行', async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(200, fixture('job_results'))])
    const rows = await makeClient(fetchImpl).getSearchResults('sid-1', { count: 5, offset: 0 })
    expect(rows).toHaveLength(5)
    expect(rows[0]).toHaveProperty('_time')
    const url = new URL(calls[0]?.url ?? '')
    expect(url.searchParams.get('count')).toBe('5')
    expect(url.searchParams.get('offset')).toBe('0')
  })

  it('缺少 results 键 → 空数组（空结果集是合法的）', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(200, { fields: [] })])
    await expect(makeClient(fetchImpl).getSearchResults('sid-1')).resolves.toEqual([])
  })

  it('results 不是数组 → SplunkResultError', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(200, { results: 'nope' })])
    await expect(makeClient(fetchImpl).getSearchResults('sid-1')).rejects.toThrowError(
      "expected 'results' to be a list, got string",
    )
  })

  it('某一行不是对象 → SplunkResultError，消息带索引', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(200, { results: [{ a: 1 }, 'bad'] })])
    await expect(makeClient(fetchImpl).getSearchResults('sid-1')).rejects.toThrowError(
      "expected each search result to be a JSON object, got string at index 1",
    )
  })
})

describe('getSearchMessages（ADR §5.11 的降级语义）', () => {
  it('端点 404 → 空数组而不是报错（Splunk 8.0.2 的真实行为）', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(404, { messages: [{ text: 'Unknown endpoint' }] })])
    await expect(makeClient(fetchImpl).getSearchMessages('sid-1')).resolves.toEqual([])
  })

  it('正常返回时过滤掉非对象条目', async () => {
    const { fetchImpl } = scriptedFetch([
      jsonResponse(200, { messages: [{ type: 'FATAL', text: 'bad' }, 'x', 1] }),
    ])
    await expect(makeClient(fetchImpl).getSearchMessages('sid-1')).resolves.toEqual([
      { type: 'FATAL', text: 'bad' },
    ])
  })
})

// --------------------------------------------------------------------------
// Job 轮询
// --------------------------------------------------------------------------

describe('waitForSearch', () => {
  it('RUNNING → DONE 时返回终态 job', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      jsonResponse(200, runningJob()),
      jsonResponse(200, fixture('job_done')),
    ])
    const job = await makeClient(fetchImpl).waitForSearch('sid-1', { pollInterval: 0.001 })
    expect(job.is_done).toBe(true)
    expect(job.dispatch_state).toBe('DONE')
    expect(calls).toHaveLength(2)
  })

  it('失败 → SplunkJobError；messages 端点 404 时消息里没有原因（当前行为）', async () => {
    const { fetchImpl } = scriptedFetch([
      jsonResponse(200, failedJob()),
      jsonResponse(404, { messages: [{ text: 'Unknown endpoint' }] }),
    ])
    let error: unknown = null
    try {
      await makeClient(fetchImpl).waitForSearch('1700000000.00001', { pollInterval: 0.001 })
    } catch (err) {
      error = err
    }
    const jobError = error as SplunkJobError
    expect(jobError).toBeInstanceOf(SplunkJobError)
    // 实测输出：失败原因不可见（ADR §5.11）。Q13 决定是否改进。
    expect(jobError.message).toBe('search job 1700000000.00001 failed (dispatchState=FAILED)')
    expect(jobError.details).toEqual({
      sid: '1700000000.00001',
      dispatch_state: 'FAILED',
      polls: 1,
    })
  })

  it('失败且 messages 可用时，原因被拼进消息', async () => {
    const { fetchImpl } = scriptedFetch([
      jsonResponse(200, failedJob()),
      jsonResponse(200, { messages: [{ text: 'first' }, { text: 'second' }] }),
    ])
    await expect(
      makeClient(fetchImpl).waitForSearch('sid-1', { pollInterval: 0.001 }),
    ).rejects.toThrowError(
      'search job sid-1 failed (dispatchState=FAILED): first | second',
    )
  })

  it('取消 → SplunkJobError', async () => {
    const cancelled = structuredClone(fixture('job_done'))
    const entry = (cancelled['entry'] as Array<Record<string, unknown>>)[0]
    const content = entry?.['content'] as Record<string, unknown>
    content['dispatchState'] = 'CANCELLED'
    content['isDone'] = false
    const { fetchImpl } = scriptedFetch([jsonResponse(200, cancelled)])
    await expect(
      makeClient(fetchImpl).waitForSearch('sid-1', { pollInterval: 0.001 }),
    ).rejects.toThrowError('search job sid-1 was cancelled before completion')
  })

  it('预算耗尽 → SplunkTimeoutError，消息与 details 符合契约', async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(200, runningJob())])
    let error: unknown = null
    try {
      await makeClient(fetchImpl).waitForSearch('1700000000.00001', {
        timeout: 0.05,
        pollInterval: 0.01,
      })
    } catch (err) {
      error = err
    }
    const timeoutError = error as SplunkTimeoutError
    expect(timeoutError).toBeInstanceOf(SplunkTimeoutError)
    // 轮询次数取决于调度时序，所以只断言结构；权威值参考对拍报告。
    expect(timeoutError.message).toMatch(
      /^search job 1700000000\.00001 did not finish within 0\.05s \(\d+ status checks, last dispatchState=RUNNING\)$/,
    )
    expect(timeoutError.details['sid']).toBe('1700000000.00001')
    expect(timeoutError.details['dispatch_state']).toBe('RUNNING')
    expect(timeoutError.details['timeout']).toBe(0.05)
    expect(calls.length).toBeGreaterThan(1)
  })

  it('pollInterval 非正 → SplunkJobError（配置约束，不是超时）', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse(200, fixture('job_done'))])
    await expect(
      makeClient(fetchImpl).waitForSearch('sid-1', { pollInterval: 0 }),
    ).rejects.toThrowError('poll_interval must be greater than zero')
  })

  it('onPoll 每次轮询都被调用', async () => {
    const { fetchImpl } = scriptedFetch([
      jsonResponse(200, runningJob()),
      jsonResponse(200, fixture('job_done')),
    ])
    const seen: string[] = []
    await makeClient(fetchImpl).waitForSearch('sid-1', {
      pollInterval: 0.001,
      onPoll: (job) => seen.push(job.dispatch_state),
    })
    expect(seen).toEqual(['RUNNING', 'DONE'])
  })
})

describe('只读边界', () => {
  it('deleteSearchJob 永远拒绝', () => {
    const client = makeClient(scriptedFetch([jsonResponse(200, {})]).fetchImpl)
    expect(() => client.deleteSearchJob()).toThrowError(
      'deleting search jobs is not permitted: Splunk CLI is read-only',
    )
  })

  it('entries 跳过畸形条目', () => {
    expect(entries({ entry: [{ a: 1 }, 'x', null, { b: 2 }] })).toEqual([{ a: 1 }, { b: 2 }])
    expect(entries({})).toEqual([])
    expect(entries({ entry: 'nope' })).toEqual([])
  })

  it('savedSearches / firedAlerts 解析 entry 列表', async () => {
    const saved = scriptedFetch([jsonResponse(200, fixture('saved_searches'))])
    const alerts = scriptedFetch([jsonResponse(200, fixture('fired_alerts'))])
    await expect(makeClient(saved.fetchImpl).savedSearches({ count: 2 })).resolves.toHaveLength(2)
    await expect(makeClient(alerts.fetchImpl).firedAlerts({ count: 1 })).resolves.toHaveLength(1)
  })
})
