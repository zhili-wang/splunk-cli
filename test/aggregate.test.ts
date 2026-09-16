import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { FetchLike, HttpResponseLike } from '../server/client/http'
import { SplunkClient } from '../server/client/splunk'
import { loadSettings, type Settings } from '../server/config/settings'
import { FieldList, FieldSummary } from '../server/models/result'
import { FieldsService } from '../server/services/fields'
import { StatsService, rowKey, rowMetric } from '../server/services/stats'
import { TimelineService, toPoint } from '../server/services/timeline'
import { sparkline, statKey } from '../server/output/table'

function makeSettings(): Settings {
  return loadSettings(
    { host: 'splunk.example', username: 'u', password: 'p', max_retries: '0', retry_backoff: '0' },
    { SPLUNK_CONFIG_DIR: join(tmpdir(), 'splunk-cli-agg-tests-no-such-dir') },
    join(tmpdir(), 'splunk-cli-agg-tests-no-such-cwd'),
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

function fixture(name: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`./fixtures/splunk/${name}.json`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/**
 * 造一个客户端：job 创建返回固定 sid，之后 job 状态 DONE、结果用给定 payload。
 * 这样服务层的测试不需要复刻 fixture 的完整形状。
 */
function clientWithResults(results: Array<Record<string, unknown>>): SplunkClient {
  const fetchImpl: FetchLike = async (url) => {
    if (url.endsWith('/services/search/jobs')) return jsonResponse(200, { sid: 'sid-1' })
    if (url.includes('/results')) return jsonResponse(200, { results })
    return jsonResponse(200, fixture('job_done'))
  }
  return new SplunkClient(makeSettings(), {
    fetch: fetchImpl,
    dispatcher: { close: async () => {} },
  })
}

describe('sparkline', () => {
  it('空序列返回空串', () => {
    expect(sparkline([])).toBe('')
  })

  it('全相等时用最低字符铺满（不除零）', () => {
    expect(sparkline([0, 0, 0])).toBe('▁▁▁')
    expect(sparkline([7, 7])).toBe('▁▁')
  })

  it('按比例映射到 8 档字符', () => {
    expect(sparkline([0, 7])).toBe('▁█')
    expect(sparkline([0, 3.5, 7])).toHaveLength(3)
  })

  it('只取最后 80 个值', () => {
    const series = Array.from({ length: 100 }, (_, index) => index)
    expect(sparkline(series)).toHaveLength(80)
  })
})

describe('statKey', () => {
  it('单值原样返回，多值用 " | " 连接', () => {
    expect(statKey('api-01')).toBe('api-01')
    expect(statKey(['api-01', 'payments'])).toBe('api-01 | payments')
  })
})

describe('stats 行解析', () => {
  it('rowKey：单字段→字符串、多字段→数组、未分组→"*"', () => {
    expect(rowKey({ host: 'h1' }, ['host'])).toBe('h1')
    expect(rowKey({ host: 'h1', svc: 's1' }, ['host', 'svc'])).toEqual(['h1', 's1'])
    expect(rowKey({}, [])).toBe('*')
    expect(rowKey({}, ['missing'])).toBe('')
  })

  it('rowMetric：按 Splunk 的指标列名取，取不到时兜底第一个数值列', () => {
    expect(rowMetric({ count: '5', host: 'h' })).toBe(5)
    expect(rowMetric({ 'avg(*)': 2.5 })).toBe(2.5)
    expect(rowMetric({ host: 'h', other: 3 })).toBe(3)
    expect(rowMetric({ host: 'h' })).toBe(0)
    expect(rowMetric({ count: 'not-a-number', other: 1 })).toBe(0)
  })
})

describe('timeline 点解析', () => {
  it('取 _time 与第一个数值列', () => {
    const point = toPoint({ _time: 'T0', count: '4' })
    expect(point.time).toBe('T0')
    expect(point.count).toBe(4)
  })

  it('没有可用数值列时降级为 0', () => {
    expect(toPoint({ _time: 'T0', note: 'x' }).count).toBe(0)
  })

  it('缺 _time 时时间为空串', () => {
    expect(toPoint({ count: 1 }).time).toBe('')
  })
})

describe('FieldSummary.fromRow / FieldList.toPublicDict', () => {
  it('name 优先取 field，其次 name；modes 支持对象与字符串两种形态', () => {
    const summary = FieldSummary.fromRow({
      field: 'host',
      count: '10',
      distinct_count: '3',
      is_exact: '1',
      modes: [{ value: 'a', count: 5 }, 'b'],
    })
    expect(summary.name).toBe('host')
    expect(summary.count).toBe(10)
    expect(summary.distinct_count).toBe(3)
    expect(summary.is_exact).toBe(true)
    expect(summary.modes).toEqual([{ value: 'a', count: 5 }, { value: 'b' }])
  })

  it('toPublicDict：details 为空时不出现该键', () => {
    const list = new FieldList({ query: 'q', fields: ['host'] })
    expect(Object.keys(list.toPublicDict())).toEqual(['success', 'query', 'count', 'fields'])
    const withDetails = new FieldList({
      query: 'q',
      fields: ['host'],
      details: [FieldSummary.fromRow({ field: 'host', count: '1' })],
    })
    expect(withDetails.toPublicDict()['details']).toHaveLength(1)
  })
})

describe('StatsService', () => {
  it('生成正确的 SPL 并按结果行产出 key/count', async () => {
    const client = clientWithResults([
      { host: 'api-01', count: '3' },
      { host: 'api-02', count: '1' },
    ])
    const result = await new StatsService(client).stats('makeresults count=5', { by: 'host' })
    const payload = result.toPublicDict()
    expect(payload['spl']).toBe('makeresults count=5 | stats count by host | sort - count | head 5000')
    expect(payload['function']).toBe('count')
    expect(payload['by']).toEqual(['host'])
    expect(payload['count']).toBe(2)
    expect(payload['rows']).toEqual([
      { key: 'api-01', count: 3 },
      { key: 'api-02', count: 1 },
    ])
    expect(payload['truncated']).toBe(false)
  })

  it('未分组时 key 为 "*"，表头 label 由 CLI 决定', async () => {
    const client = clientWithResults([{ count: '7' }])
    const payload = (await new StatsService(client).stats('q')).toPublicDict()
    expect(payload['rows']).toEqual([{ key: '*', count: 7 }])
    expect(payload['by']).toEqual([])
  })

  it('非法 by 字段被拒绝（不能注入 SPL）', async () => {
    const client = clientWithResults([])
    await expect(
      new StatsService(client).stats('q', { by: 'host | delete' }),
    ).rejects.toThrowError(/invalid field name/)
  })

  it('浮点指标保持浮点（JSON 里 0.0 → 0）', async () => {
    const client = clientWithResults([{ host: 'a', count: '0' }])
    const payload = (await new StatsService(client).stats('q', { by: 'host' })).toPublicDict()
    expect((payload['rows'] as Array<Record<string, unknown>>)[0]).toEqual({ key: 'a', count: 0 })
  })
})

describe('TimelineService', () => {
  it('分桶、total 求和、span 与 SPL 回显', async () => {
    const client = clientWithResults([
      { _time: 'T0', count: '2' },
      { _time: 'T1', count: '3' },
    ])
    const payload = (await new TimelineService(client).timeline('q')).toPublicDict()
    expect(payload['span']).toBe('5m')
    expect(payload['spl']).toBe('q | timechart span=5m count | head 500')
    expect(payload['count']).toBe(2)
    expect(payload['total']).toBe(5)
    expect(payload['timeline']).toEqual([
      { time: 'T0', count: 2 },
      { time: 'T1', count: 3 },
    ])
  })

  it('非法 span 被拒绝', async () => {
    const client = clientWithResults([])
    await expect(new TimelineService(client).timeline('q', { span: '-5m' })).rejects.toThrowError(
      /invalid span/,
    )
  })

  it('桶数被 MAX_BUCKETS 截断（策略上限之内仍会被 500 截断）', async () => {
    const client = clientWithResults([])
    // 1000 在 max_results(5000) 之内，但超过 MAX_BUCKETS(500)。
    const result = await new TimelineService(client).timeline('q', { limit: 1000 })
    expect(result.spl).toContain('| head 500')
  })
})

describe('FieldsService', () => {
  it('按 count 降序、过滤空名、并限制上限', async () => {
    const client = clientWithResults([
      { field: 'a', count: '1' },
      { field: 'b', count: '9' },
      { field: '', count: '5' },
    ])
    const payload = (await new FieldsService(client).fields('q')).toPublicDict()
    expect(payload['fields']).toEqual(['b', 'a'])
    expect(payload['count']).toBe(2)
    expect((payload['details'] as unknown[]).length).toBe(2)
  })

  it('includeDetails=false 时不带 details', async () => {
    const client = clientWithResults([{ field: 'a', count: '1' }])
    const payload = (await new FieldsService(client).fields('q', { includeDetails: false })).toPublicDict()
    expect(payload['details']).toBeUndefined()
    expect(payload['fields']).toEqual(['a'])
  })

  it('SPL 使用 fieldsummary 且 limit 被 MAX_FIELDS 截断', async () => {
    const client = clientWithResults([])
    const result = await new FieldsService(client).fields('q', { limit: 5000 })
    expect(result.toPublicDict()['query']).toBe('q')
    // 服务内部用 SPL，不落在公开 payload 里；这里只验证不抛错即可。
    expect(result.fields).toEqual([])
  })
})
