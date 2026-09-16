/**
 * 薄透传路由。
 *
 * 为什么合在一个文件里：这五条路线的形状完全相同（校验请求体 → 调服务 → 原样返回
 * `toPublicDict()`），放在一起能让"它们都只是薄适配"这件事一眼可见。
 * `overview` 不同（它是聚合 + 局部降级），所以单独一个文件。
 *
 * 分层约束（AGENTS.md §3）：本层**只做 HTTP 入参校验与响应包装**，
 * 业务编排在 `server/services/**`；SPL 一律由服务层或校验器生成。
 */

import type { NextFunction, Request, Response } from 'express'

import { AlertsService } from '../../services/alerts'
import { HealthService } from '../../services/health'
import { SearchService } from '../../services/search'
import { StatsService } from '../../services/stats'
import { TimelineService } from '../../services/timeline'
import { overviewRequest, searchRequest, statsRequest, timelineRequest } from '../schemas'
import { runtimeOf } from '../runtime'
import { VERSION } from '../../version'

/** 把处理函数包成"异常一定交给统一错误中间件"的形式。 */
export function route(
  handler: (request: Request, response: Response) => Promise<void> | void,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    try {
      const result = handler(request, response)
      if (result instanceof Promise) result.catch(next)
    } catch (error) {
      next(error)
    }
  }
}

/**
 * `GET /api/health` —— 状态码**永远是 200**。
 *
 * `HealthService` 把探针失败在报告内呈现（`connection: "failed"`）而不是抛错，
 * 这个区别很重要："连不上 Splunk" 是面板必须渲染的一个答案，不是 API 错误。
 * 返回 5xx 会让"连接不通"和"面板坏了"在界面上无法区分。
 * 真正的失败（比如配置非法）仍然抛出，由错误中间件映射。
 */
export async function health(request: Request, response: Response): Promise<void> {
  const includeLicense = request.query['include_license'] !== 'false'
  const report = await runtimeOf(request)
    .service(HealthService)
    .health({ includeLicense })
  response.json(report.toPublicDict())
}

/** `POST /api/search` —— 返回与 `splunk-cli search --json` 完全一致的载荷。 */
export async function search(request: Request, response: Response): Promise<void> {
  const body = searchRequest.parse(request.body)
  const result = await runtimeOf(request)
    .service(SearchService)
    .search(body.query, {
      earliest: body.earliest,
      latest: body.latest,
      limit: body.limit,
    })
  response.json(result.toPublicDict())
}

/** `POST /api/stats`。 */
export async function stats(request: Request, response: Response): Promise<void> {
  const body = statsRequest.parse(request.body)
  const result = await runtimeOf(request)
    .service(StatsService)
    .stats(body.query, {
      by: body.by,
      function: body.function,
      earliest: body.earliest,
      latest: body.latest,
      limit: body.limit,
    })
  response.json(result.toPublicDict())
}

/** `POST /api/timeline`。 */
export async function timeline(request: Request, response: Response): Promise<void> {
  const body = timelineRequest.parse(request.body)
  const result = await runtimeOf(request)
    .service(TimelineService)
    .timeline(body.query, {
      span: body.span,
      earliest: body.earliest,
      latest: body.latest,
      limit: body.limit,
    })
  response.json(result.toPublicDict())
}

/**
 * `GET /api/alerts` —— 结构上只读。
 *
 * 启用/禁用/编辑/删除都没有路由，而且底层端点白名单本来也会拒绝：两道互不依赖的
 * 屏障，没有一道取决于前端是否守规矩。
 */
export async function alerts(request: Request, response: Response): Promise<void> {
  const countParam = request.query['count']
  const count = typeof countParam === 'string' && countParam !== '' ? Number(countParam) : null
  const includeSaved = request.query['include_saved'] === 'true'
  const result = await runtimeOf(request)
    .service(AlertsService)
    .alerts({ count, includeSaved })
  response.json(result.toPublicDict())
}

/** `POST /api/overview` 的请求体解析（供 overview 模块复用）。 */
export function parseOverviewBody(request: Request): ReturnType<typeof overviewRequest.parse> {
  return overviewRequest.parse(request.body)
}

/**
 * `GET /api/version` —— 面板自己这一版的版本号。
 *
 * 唯一一条不读 Splunk 的 API：版本号取自包元数据（`server/version.ts`），和
 * `--version`、User-Agent 同一个来源。页脚显示它，是为了让"页面上跑的是哪一版"
 * 和"`splunk-cli --version` 报的是哪一版"能当场对上——排查时先要排除的就是这个。
 */
export function version(_request: Request, response: Response): void {
  response.json({ name: 'splunk-cli', version: VERSION })
}
