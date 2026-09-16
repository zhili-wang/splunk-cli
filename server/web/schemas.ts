/**
 * 请求体模型。
 *
 * **上限刻意不在这里校验**：上限归 `SafetyPolicy` 管，超限请求由服务层以
 * `SafetyLimitError` 拒绝，面板原样透出。在请求模型里重复一遍上限会制造第二个、
 * 会漂移的真相来源，而且契约比 CLI 更弱。
 */

import { z } from 'zod'

/** `POST /api/search` 的请求体。 */
export const searchRequest = z.strictObject({
  query: z.string().min(1, 'String should have at least 1 character'),
  earliest: z.string().nullish(),
  latest: z.string().nullish(),
  limit: z.number().int().min(1, 'Input should be greater than or equal to 1').nullish(),
})

/** `POST /api/stats` 的请求体。 */
export const statsRequest = z.strictObject({
  query: z.string().min(1, 'String should have at least 1 character'),
  by: z.string().nullish(),
  function: z.string().default('count'),
  earliest: z.string().nullish(),
  latest: z.string().nullish(),
  limit: z.number().int().min(1, 'Input should be greater than or equal to 1').nullish(),
})

/** `POST /api/timeline` 的请求体。 */
export const timelineRequest = z.strictObject({
  query: z.string().min(1, 'String should have at least 1 character'),
  span: z.string().default('5m'),
  earliest: z.string().nullish(),
  latest: z.string().nullish(),
  limit: z.number().int().min(1, 'Input should be greater than or equal to 1').nullish(),
})

/** `POST /api/overview` 的请求体。 */
export const overviewRequest = z.strictObject({
  query: z.string().min(1, 'String should have at least 1 character'),
  earliest: z.string().nullish(),
  latest: z.string().nullish(),
  span: z.string().nullish(),
})

/** 已校验的请求体类型。 */
export type SearchRequest = z.infer<typeof searchRequest>
export type StatsRequest = z.infer<typeof statsRequest>
export type TimelineRequest = z.infer<typeof timelineRequest>
export type OverviewRequest = z.infer<typeof overviewRequest>
