/**
 * 应用装配。
 *
 * `createApp` 是**唯一**把运行时、守卫与路由接在一起的地方。它把配置作为参数接收，
 * 这样测试可以注入离线客户端，而生产只加载一次真实配置。
 */

import compression from 'compression'
import express, { type Express } from 'express'

import { loadSettings, type Settings } from './config/settings'
import type { SplunkClient } from './client/splunk'
import { errorHandler } from './web/errors'
import { overview } from './web/routes/overview.routes'
import { route } from './web/routes/route'
import { shutdown } from './web/routes/shutdown.routes'
import { alerts, health, search, stats, timeline, version } from './web/routes/thin.routes'
import { RUNTIME_KEY, WebRuntime } from './web/runtime'
import { originGuard } from './web/security'
import { installStaticRoutes, resolveWebDir } from './web/static'

/** 所有 API 路由共用的前缀。 */
export const API_PREFIX = '/api'

/** 请求体大小上限：显式声明，不留"魔法默认值"。 */
export const MAX_BODY_SIZE = '256kb'

/** 构造面板应用的参数。 */
export interface CreateAppOptions {
  /** 连接配置；省略时从环境加载。 */
  settings?: Settings
  /** 预构造的客户端（测试用）。 */
  client?: SplunkClient
  /** 注入前端构建目录（测试用）；省略时自动探测。 */
  webDir?: string | null
}

/**
 * 构建面板应用。
 *
 * 注意 `loadSettings()` 只拒绝**非法**取值（畸形 URL、越界超时），并不要求凭据齐全
 * ——未配置的服务照样能启动，并通过 `/api/health` 把自己如实报告出来。
 * 是否"没凭据就拒绝服务"是调用方的决定，不是这里的。
 */
export function createApp(options: CreateAppOptions = {}): Express {
  const settings = options.settings ?? loadSettings()
  const app = express()

  app.disable('x-powered-by')
  app.locals[RUNTIME_KEY] = new WebRuntime(
    settings,
    options.client !== undefined ? { client: options.client } : {},
  )

  // 顺序即契约：
  //   守卫 → gzip → JSON 解析 → 路由 → 静态 → SPA fallback → 404/405 → 错误处理
  // 守卫放在最前，敌意的 Host 在进入任何路由或 body 解析之前就被拒绝。
  app.use(originGuard)
  app.use(compression())
  app.use(express.json({ limit: MAX_BODY_SIZE }))

  app.get(`${API_PREFIX}/health`, route(health))
  app.post(`${API_PREFIX}/search`, route(search))
  app.post(`${API_PREFIX}/stats`, route(stats))
  app.post(`${API_PREFIX}/timeline`, route(timeline))
  app.get(`${API_PREFIX}/alerts`, route(alerts))
  app.get(`${API_PREFIX}/version`, route(version))
  app.post(`${API_PREFIX}/overview`, route(overview))
  // 唯一一条不读 Splunk 的 POST：它关的是这个进程，不是任何 Splunk 资源。
  app.post(`${API_PREFIX}/shutdown`, route(shutdown))

  // 最后挂载：SPA fallback 绝不能遮蔽任何 API 路由。
  installStaticRoutes(app, options.webDir === undefined ? resolveWebDir() : options.webDir)

  app.use(errorHandler)
  return app
}
