/**
 * `POST /api/shutdown` —— 让页面把服务停掉。
 *
 * 这是面板唯一一条**不读 Splunk 的 POST**，也是唯一一条不返回 Splunk 数据的端点。
 * 它不改动任何 Splunk 状态：只让这个进程体面地退出（先停 HTTP、再释放连接池），
 * 走的是 `dashboard` 命令收到 SIGTERM 时**同一条** `RunningServer.close()`。
 * 因此 AGENTS.md §3「不新增写端点」不被违反 —— 那条约束的是"绝不写 Splunk"。
 *
 * 请求的合法性由 `originGuard` 保证：非回环的 `Origin` 在进入这里之前就被 403 掉了，
 * 所以"访问一个恶意网页顺手把你的面板关掉"这条路是堵死的。刻意**不加令牌** ——
 * 本机上的进程本来就能直接 kill 掉这个服务，令牌不扩大防御面，只增加复杂度。
 * （前提是面板只服务本机，见 ADR §3.4 D1；若将来有人把它反代到公网，这个前提就不成立了。）
 */

import type { Request, Response } from 'express'

import { ServiceNotStoppableError, onResponseEnd, scheduleShutdown, shutdownHandlerOf } from '../lifecycle'

/**
 * 应答 `{"success": true}`，**然后**关闭。
 *
 * 顺序不能反：先关会让浏览器看到连接重置而不是这个 200，用户会以为失败，
 * 反复点击一个其实已经生效的按钮。见 `SHUTDOWN_GRACE_MS` 的注释。
 */
export function shutdown(request: Request, response: Response): void {
  const handler = shutdownHandlerOf(request.app)
  if (handler === null) {
    throw new ServiceNotStoppableError(
      'this dashboard process is not running under a stoppable server, so the page cannot ' +
        'shut it down. Stop it the way you started it (Ctrl-C in the terminal).',
    )
  }

  response.json({
    success: true,
    stopping: true,
    message: 'the dashboard is shutting down; this page will stop working',
  })

  // 响应落定之后才关；`finish` 与 `close` 取先到的那个（见 `onResponseEnd`）。
  onResponseEnd(response, () => {
    scheduleShutdown(handler)
  })
}
