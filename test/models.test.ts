import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { ResultSet } from '../server/models/result'
import { SearchJob, TimeRange, optString } from '../server/models/search'

/** 真实实例抓取并脱敏过的 Job 响应，不是手写的理想形状。 */
function fixture(name: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`./fixtures/splunk/${name}.json`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

const SID = '1700000000.00001'

describe('SearchJob.fromApi', () => {
  it('从真实 Job 响应里读出执行事实', () => {
    const job = SearchJob.fromApi(SID, fixture('job_done'))

    expect(job.sid).toBe(SID)
    expect(job.dispatch_state).toBe('DONE')
    expect(job.is_done).toBe(true)
    expect(job.result_count).toBe(5)
  })

  it('读出 Splunk 实际执行的时间窗（epoch 秒）', () => {
    // 请求里的 `-1mon@mon` 只是表达式，只有服务端知道它落到哪两个瞬间。
    const job = SearchJob.fromApi(SID, fixture('job_done'))

    expect(job.search_earliest_time).toBe(1789464924)
    expect(job.search_latest_time).toBe(1789468524)
    expect(job.sample_ratio).toBe('1')
  })

  it('缺少这些字段时给 null / 空串，而不是编一个时间窗', () => {
    const job = SearchJob.fromApi(SID, {
      entry: [{ content: { dispatchState: 'RUNNING', isDone: false } }],
    })

    expect(job.search_earliest_time).toBeNull()
    expect(job.search_latest_time).toBeNull()
    expect(job.sample_ratio).toBe('')
  })

  it('字段是数字或字符串都能吃下（不同版本编码不同）', () => {
    const job = SearchJob.fromApi(SID, {
      entry: [
        {
          content: {
            dispatchState: 'DONE',
            isDone: true,
            searchEarliestTime: '1789464924',
            searchLatestTime: 1789468524,
            sampleRatio: 10,
          },
        },
      ],
    })

    expect(job.search_earliest_time).toBe(1789464924)
    expect(job.search_latest_time).toBe(1789468524)
    expect(job.sample_ratio).toBe('10')
  })
})

describe('SearchJob.toPublicDict', () => {
  it('公开执行元数据，但只在服务端真的给出时间窗时', () => {
    const job = SearchJob.fromApi(SID, fixture('job_done'))
    const payload = job.toPublicDict()

    expect(payload).toMatchObject({
      sid: SID,
      dispatch_state: 'DONE',
      result_count: 5,
      search_earliest_time: 1789464924,
      search_latest_time: 1789468524,
      sample_ratio: '1',
    })
  })

  it('不泄漏 Job 的内部内容（messages 不在公开视图里）', () => {
    const payload = SearchJob.fromApi(SID, fixture('job_done')).toPublicDict()

    expect(payload['messages']).toBeUndefined()
    expect(Object.keys(payload)).not.toContain('search')
  })

  it('未知的时间窗不出现在载荷里（"不知道"不等于"没有"）', () => {
    const job = new SearchJob({
      sid: SID,
      dispatch_state: 'RUNNING',
      is_done: false,
      is_failed: false,
      is_finalized: false,
      is_paused: false,
      result_count: 0,
      event_count: 0,
      scan_count: 0,
      done_progress: 0,
      run_duration: null,
      ttl: null,
      messages: [],
    })

    expect(Object.keys(job.toPublicDict())).not.toContain('search_earliest_time')
    expect(Object.keys(job.toPublicDict())).not.toContain('sample_ratio')
  })
})

describe('optString', () => {
  it('把有值的东西变成文本，空值变成空串', () => {
    expect(optString('1')).toBe('1')
    expect(optString(10)).toBe('10')
    expect(optString(null)).toBe('')
    expect(optString(undefined)).toBe('')
  })
})

describe('ResultSet.toPublicDict', () => {
  const job = SearchJob.fromApi(SID, fixture('job_done'))

  it('带上 Job 的执行元数据，让调用方知道表达式真正落在哪个窗口', () => {
    const payload = new ResultSet({
      sid: SID,
      query: 'index=app',
      time_range: new TimeRange({ earliest: '@mon', latest: 'now' }),
      count: 1,
      total_available: 1,
      results: [{ host: 'api-01' }],
      fields: ['host'],
      job,
    }).toPublicDict()

    expect(payload['time_range']).toEqual({ earliest: '@mon', latest: 'now' })
    expect(payload['job']).toMatchObject({
      result_count: 5,
      search_earliest_time: 1789464924,
    })
  })

  it('没有 Job 时载荷里就没有这个键（离线构造的结果集照样是合法的）', () => {
    const payload = new ResultSet({ query: 'index=app', results: [] }).toPublicDict()

    expect(Object.keys(payload)).not.toContain('job')
  })
})
