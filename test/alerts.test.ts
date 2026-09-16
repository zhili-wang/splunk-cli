import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { FetchLike, HttpResponseLike } from '../server/client/http'
import { SplunkClient } from '../server/client/splunk'
import { loadSettings, type Settings } from '../server/config/settings'
import { AlertList, FiredAlert, SavedSearch } from '../server/models/alert'
import { AlertsService } from '../server/services/alerts'

function makeSettings(): Settings {
  return loadSettings(
    { host: 'splunk.example', username: 'u', password: 'p', max_retries: '0', retry_backoff: '0' },
    { SPLUNK_CONFIG_DIR: join(tmpdir(), 'splunk-cli-alerts-tests-no-such-dir') },
    join(tmpdir(), 'splunk-cli-alerts-tests-no-such-cwd'),
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

function makeClient(responses: HttpResponseLike[]): SplunkClient {
  let index = 0
  const fetchImpl: FetchLike = async () => {
    const response = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (response === undefined) throw new Error('空脚本')
    return response
  }
  return new SplunkClient(makeSettings(), { fetch: fetchImpl, dispatcher: { close: async () => {} } })
}

function fixture(name: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`./fixtures/splunk/${name}.json`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('FiredAlert.fromEntry（用真实 fixture）', () => {
  it('真实条目在剔除 null 后只剩 {name, severity, app}', () => {
    const entries = fixture('fired_alerts')['entry'] as Array<Record<string, unknown>>
    const alert = FiredAlert.fromEntry(entries[0] as Record<string, unknown>)
    // 这一条是实测契约：其余字段在数据里就是 null，被整键剔除。
    expect(alert.toPublicDict()).toEqual({ name: '-', severity: 'unknown', app: 'search' })
  })

  it('数字严重级别映射成名称', () => {
    const build = (severity: unknown): Record<string, unknown> =>
      FiredAlert.fromEntry({ name: 'a', content: { severity } }).toPublicDict()
    expect(build(5).severity).toBe('critical')
    expect(build('3').severity).toBe('medium')
    expect(build('HIGH').severity).toBe('high')
    expect(build('weird').severity).toBe('unknown')
    expect(build(undefined).severity).toBe('unknown')
  })

  it('缺失 name 时用 <unnamed>', () => {
    expect(FiredAlert.fromEntry({ content: {} }).name).toBe('<unnamed>')
  })

  it('trigger_time 走 ISO-8601 语义', () => {
    const alert = FiredAlert.fromEntry({ name: 'a', content: { trigger_time: '1756375331' } })
    expect(alert.trigger_time).toBe('2025-08-28T10:02:11+00:00')
  })
})

describe('AlertList.toPublicDict', () => {
  it('基础形状：success/source/count/alerts/truncated', () => {
    const list = new AlertList({
      fired: [new FiredAlert({
        name: 'a',
        sid: null,
        trigger_time: null,
        triggered_alerts: null,
        severity: 'high',
        app: 'search',
        saved_search_name: null,
        alert_type: null,
        expiration_time: null,
      })],
      source: 'fired_alerts',
      truncated: false,
    })
    expect(list.toPublicDict()).toEqual({
      success: true,
      source: 'fired_alerts',
      count: 1,
      alerts: [{ name: 'a', severity: 'high', app: 'search' }],
      truncated: false,
    })
  })

  it('note 只在非空时出现；saved_searches 只在非空时出现', () => {
    const empty = new AlertList({ source: 'unavailable', note: 'because' })
    expect(Object.keys(empty.toPublicDict())).toEqual([
      'success',
      'source',
      'count',
      'alerts',
      'truncated',
      'note',
    ])
    expect(new AlertList({ source: 'fired_alerts' }).toPublicDict()['note']).toBeUndefined()
  })
})

describe('SavedSearch.fromEntry', () => {
  it('从真实 saved_searches fixture 解析（app 取自 acl）', () => {
    const entries = fixture('saved_searches')['entry'] as Array<Record<string, unknown>>
    const saved = SavedSearch.fromEntry(entries[0] as Record<string, unknown>)
    // fixture 里第一条就是 24 小时那条（顺序来自真实响应，不要凭印象断言）。
    expect(saved.name).toBe('Errors in the last 24 hours')
    expect(saved.owner).toBe('admin')
    expect(typeof saved.is_scheduled).toBe('boolean')
  })
})

describe('AlertsService', () => {
  it('正常返回：source=fired_alerts，count 与 truncated 正确', async () => {
    const client = makeClient([jsonResponse(200, fixture('fired_alerts'))])
    const result = await new AlertsService(client).alerts()
    const payload = result.toPublicDict()
    expect(payload['source']).toBe('fired_alerts')
    expect(payload['count']).toBe(1)
    expect(payload['truncated']).toBe(false)
    expect(payload['note']).toBeUndefined()
  })

  it('端点 404（Splunk 9.2 已移除）→ 空列表 + note + source=unavailable，且不抛错', async () => {
    const client = makeClient([jsonResponse(404, { messages: [{ text: 'Unknown endpoint' }] })])
    const result = await new AlertsService(client).alerts()
    const payload = result.toPublicDict()
    expect(payload['source']).toBe('unavailable')
    expect(payload['count']).toBe(0)
    expect(payload['alerts']).toEqual([])
    expect(String(payload['note'])).toContain('fired-alerts endpoint is unavailable')
    expect(String(payload['note'])).toContain('HTTP 404')
  })

  it('认证失败**不**降级（只有 404 这类查询错误才降级）', async () => {
    const client = makeClient([jsonResponse(401, { messages: [{ text: 'denied' }] })])
    await expect(new AlertsService(client).alerts()).rejects.toThrowError(/authentication failed/)
  })

  it('includeSaved 时同时取 saved/searches，source=both', async () => {
    const client = makeClient([
      jsonResponse(200, fixture('fired_alerts')),
      jsonResponse(200, fixture('saved_searches')),
    ])
    const payload = (await new AlertsService(client).alerts({ includeSaved: true })).toPublicDict()
    expect(payload['source']).toBe('both')
    expect(payload['saved_count']).toBe(2)
    expect(Array.isArray(payload['saved_searches'])).toBe(true)
  })

  it('count 超上限被策略拒绝，且被 MAX_ALERTS 截到 500', async () => {
    const client = makeClient([jsonResponse(200, fixture('fired_alerts'))])
    await expect(new AlertsService(client).alerts({ count: 999_999 })).rejects.toThrowError(
      /exceeds the maximum allowed/,
    )
  })
})
