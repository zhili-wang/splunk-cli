/**
 * `POST /api/overview` —— 一次往返拿到整个首屏。
 *
 * 面板首屏需要一条时间线 + 两个分布。分开取意味着三套 loading 与三套错误状态要设计，
 * 所以在这里聚合并并发执行，且**各自独立失败**。
 */

import type { Request, Response } from 'express'

import { errorPayload } from '../../errors'
import { StatsService } from '../../services/stats'
import { TimelineService } from '../../services/timeline'
import { overviewRequest } from '../schemas'
import { runtimeOf } from '../runtime'

/** 请求没指定时使用的分桶宽度。 */
export const DEFAULT_SPAN = '5m'

/** 把一个降级的子查询渲染成稳定的 error 对象。 */
function failure(error: unknown): Record<string, unknown> {
  return errorPayload(error)['error']
}

/**
 * 返回时间线、两个分布与派生指标。
 *
 * 某个分布失败**只降级它自己**：对应面板与指标变成 `null`，错误记进 `errors`。
 * 时间线失败则整体 `success: false`——它就是首屏本身。
 */
export async function overview(request: Request, response: Response): Promise<void> {
  const body = overviewRequest.parse(request.body)
  const runtime = runtimeOf(request)
  const timelineService = runtime.service(TimelineService)
  const statsService = runtime.service(StatsService)

  const span = body.span !== null && body.span !== undefined && body.span !== '' ? body.span : DEFAULT_SPAN
  // 先解析（并校验）一次时间范围，再花掉三个查询：超出上限的窗口在这里就被拒绝，
  // 并以 422 经统一错误中间件透出。
  const timeRange = timelineService.resolveTimeRange(body.earliest, body.latest)

  const settled = await Promise.allSettled([
    timelineService.timeline(body.query, {
      span,
      earliest: body.earliest,
      latest: body.latest,
    }),
    statsService.stats(body.query, { by: 'service', earliest: body.earliest, latest: body.latest }),
    statsService.stats(body.query, { by: 'host', earliest: body.earliest, latest: body.latest }),
  ])
  const [timelineOutcome, serviceOutcome, hostOutcome] = settled

  const errors: Record<string, unknown> = {}
  const panels: Record<string, Record<string, unknown> | null> = {}
  const pairs: Array<[string, PromiseSettledResult<{ toPublicDict(): Record<string, unknown> }> | undefined]> = [
    ['timeline', timelineOutcome],
    ['by_service', serviceOutcome],
    ['by_host', hostOutcome],
  ]
  for (const [name, outcome] of pairs) {
    if (outcome === undefined || outcome.status === 'rejected') {
      errors[name] = failure(outcome === undefined ? new Error('missing outcome') : outcome.reason)
      panels[name] = null
    } else {
      panels[name] = outcome.value.toPublicDict()
    }
  }

  const timelinePanel = panels['timeline'] ?? null
  const servicePanel = panels['by_service'] ?? null
  const hostPanel = panels['by_host'] ?? null

  // null 表示"没能查出来"，0 表示"确实没有"。
  const metrics: Record<string, number | null> = {
    events: null,
    hosts: null,
    services: null,
    buckets: null,
  }
  if (timelinePanel !== null) {
    metrics['events'] = Number(timelinePanel['total'] ?? 0)
    metrics['buckets'] = Number(timelinePanel['count'] ?? 0)
  }
  if (servicePanel !== null) metrics['services'] = Number(servicePanel['count'] ?? 0)
  if (hostPanel !== null) metrics['hosts'] = Number(hostPanel['count'] ?? 0)

  response.json({
    // 没有时间线就没有可用的首屏，所以整体是失败——即使部分子查询成功了。
    // `partial` 如实报告"有区块缺失"。
    success: timelinePanel !== null,
    partial: Object.keys(errors).length > 0,
    query: body.query,
    time_range: timeRange.toPublicDict(),
    metrics,
    timeline: timelinePanel,
    by_service: servicePanel,
    by_host: hostPanel,
    errors,
  })
}
