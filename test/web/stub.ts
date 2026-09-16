/**
 * Web 层测试的共享替身。
 *
 * 与 CLI 测试同样的隔离约定：`SPLUNK_CONFIG_DIR` 指向不存在的路径，凭据与 URL 全部
 * 由测试显式提供，绝不读写真实的 `~/.splunk-cli`。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { FetchLike, HttpResponseLike } from '../../server/client/http'
import { SplunkClient } from '../../server/client/splunk'
import { loadSettings, type Settings } from '../../server/config/settings'

/** 读取真实 fixture（由抓取脚本从真实实例取得）。 */
export function fixture(name: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`../fixtures/splunk/${name}.json`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/**
 * 隔离的配置。
 *
 * 必须给出一个**绝对**的基地址：`fetch` 是注入的、不会真的发请求，但客户端要先
 * 用 `new URL(base + path)` 拼出 URL —— 基地址为空时连这一步都过不去，
 * health 会（正确地）报成连接失败，用例就分不清"守卫放行"与"探针失败"了。
 */
export function settings(): Settings {
  return loadSettings(
    { host: 'splunk.example', username: 'splunk_user', password: 'placeholder', max_retries: '0' },
    { SPLUNK_CONFIG_DIR: '/nonexistent-for-web-tests' },
    '/nonexistent-web-cwd',
  )
}

/** 一个 JSON 响应。 */
export function jsonResponse(status: number, body: unknown): HttpResponseLike {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    text: async () => text,
  }
}

/**
 * 构造一个离线客户端。
 *
 * 用注入 `fetch` 而不是全局 dispatcher（见 ADR §4.4）——测试之间互不干扰。
 * 路由匹配按 URL 子串判断，够用且让用例一眼看懂"哪个端点返回什么"。
 */
export interface StubRoute {
  /** URL 子串，具体路径必须排在通配前面。 */
  match: string
  /** 可选的请求体子串匹配（用于区分同端点的不同查询，如 timechart / stats）。 */
  bodyIncludes?: string
  response: HttpResponseLike | (() => HttpResponseLike | Promise<HttpResponseLike>)
}

export function offlineClient(routes: StubRoute[]): SplunkClient {
  const fetchImpl: FetchLike = async (url, init) => {
    const body = init.body ?? ''
    for (const route of routes) {
      if (!url.includes(route.match)) continue
      if (route.bodyIncludes !== undefined && !body.includes(route.bodyIncludes)) continue
      return typeof route.response === 'function' ? await route.response() : route.response
    }
    throw new Error(`offlineClient: 没有为 ${url} 配置响应`)
  }
  return new SplunkClient(settings(), {
    fetch: fetchImpl,
    dispatcher: { close: async () => {} },
  })
}

/** 一个对搜索 Job 全流程都给出成功响应的客户端。 */
export function okSearchClient(
  results: Array<Record<string, unknown>> = [{ _time: 'T0', host: 'h1', count: '2' }],
): SplunkClient {
  // ⚠ 顺序即优先级：**具体路径必须排在通配前面**，否则
  // `/services/search/jobs/<sid>` 会被 `/services/search/jobs` 先匹配掉。
  return offlineClient([
    { match: '/services/search/jobs/1700000000.00001/results', response: jsonResponse(200, { results }) },
    { match: '/services/search/jobs/1700000000.00001/messages', response: jsonResponse(200, { messages: [] }) },
    { match: '/services/search/jobs/1700000000.00001', response: jsonResponse(200, fixture('job_done')) },
    { match: '/services/search/jobs', response: jsonResponse(200, { sid: '1700000000.00001' }) },
    { match: '/services/server/info', response: jsonResponse(200, fixture('server_info')) },
    { match: '/services/licenser/pools', response: jsonResponse(200, { entry: [] }) },
    { match: '/services/alerts/fired_alerts', response: jsonResponse(200, fixture('fired_alerts')) },
    { match: '/services/saved/searches', response: jsonResponse(200, fixture('saved_searches')) },
  ])
}
