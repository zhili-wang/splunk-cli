/**
 * 面板进程的生命周期钩子。
 *
 * 与 `runtime.ts` 分开，因为管的是两件事：`WebRuntime` 管 **Splunk 连接池**，
 * 这里管 **这个进程该不该继续活着**。混在一起会让"关连接池"和"关进程"看起来是
 * 同一个动作，而它们其实各有各的失败模式。
 *
 * 为什么钩子是「先挂载、后触发」而不是 `createApp` 直接收一个参数：服务器句柄要到
 * `listen` 成功之后才存在，而路由必须在 `createApp` 里就注册好。所以 app 先拿到一个
 * 空槽位，`startServer` 稍后把 `close` 填进去。
 *
 * 槽位为空是**合法状态**，不是 bug：测试直接 `createApp()` 走 supertest、
 * 或者将来有人把 app 嵌进别的宿主时就是这个样子。这时路由如实拒绝（503），
 * 而不是假装成功。
 */

import type { Express } from 'express'

import { SplunkError } from '../errors'
import { error as logError } from '../logger'

/** 钩子在 `app.locals` 上的键。 */
export const SHUTDOWN_KEY = 'shutdown'

/** 关闭处理函数的形状：可以同步返回，也可以返回 Promise。 */
export type ShutdownHandler = () => Promise<void> | void

/**
 * 响应冲刷窗口（毫秒）。
 *
 * **这不是节流，是给响应一个到达浏览器的窗口。**
 *
 * `RunningServer.close()` 会调 `server.closeAllConnections()` 主动断开所有连接
 * —— 不这样做，页面上那个 30 秒的健康轮询挂着的 keep-alive 连接会让 `close()`
 * 一直等下去，用户点了「停止服务」却要等半分钟才真的停。
 *
 * 但这样一来，如果我们关得比响应早，浏览器看到的是**连接重置**而不是刚写出去的
 * 那个 200：服务明明停成功了，页面却报网络错误，用户以为失败，于是再点一次、
 * 再刷新一次 —— 全是徒劳。回环 RTT 通常不到 0.1ms，150ms 是三个数量级的余量。
 */
export const SHUTDOWN_GRACE_MS = 150

/** 这个应用没有可供页面触发的关闭钩子。 */
export class ServiceNotStoppableError extends SplunkError {
  override readonly errorType: string = 'ServiceNotStoppable'

  constructor(message: string) {
    super(message)
    this.name = 'ServiceNotStoppableError'
  }
}

/**
 * 把关闭钩子挂到应用上。
 *
 * 后挂的覆盖先挂的（`startServer` 只会挂一次；覆盖语义是为了让测试能改）。
 *
 * @param app 目标应用。
 * @param handler 真正执行关闭的函数。
 */
export function attachShutdownHandler(app: Express, handler: ShutdownHandler): void {
  app.locals[SHUTDOWN_KEY] = handler
}

/**
 * 取出挂在本应用上的关闭钩子。
 *
 * @param app 任何带 `locals` 的对象（`request.app` 即可）。
 * @returns 钩子；没有挂载时返回 `null` —— 调用方据此决定是拒绝还是继续。
 */
export function shutdownHandlerOf(app: { locals: Record<string, unknown> }): ShutdownHandler | null {
  const handler = app.locals[SHUTDOWN_KEY]
  return typeof handler === 'function' ? (handler as ShutdownHandler) : null
}

/**
 * 延迟触发关闭。
 *
 * 在 `SHUTDOWN_GRACE_MS` 之后调用钩子。关闭本身失败不能静默吞掉 —— 那个进程会
 * 一直活着而用户以为已经停了，所以记一条 error 日志（stdout 是机器载荷，日志走 stderr）。
 *
 * @param handler 关闭钩子。
 * @param graceMs 冲刷窗口；测试传 0 以免真的等。
 */
export function scheduleShutdown(handler: ShutdownHandler, graceMs = SHUTDOWN_GRACE_MS): void {
  setTimeout(() => {
    void Promise.resolve()
      .then(() => handler())
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        logError('web', `shutdown failed: ${message}`)
      })
  }, graceMs)
}

/** `onResponseEnd` 需要的最小响应接口（真实的是 `express.Response`）。 */
export interface ResponseEndSource {
  once(event: 'finish' | 'close', listener: () => void): unknown
}

/**
 * 在响应尘埃落定之后**只跑一次** `fire`。
 *
 * 两个事件都要接，且只认先到的那个：
 *   - `finish` —— 响应正常写完了；
 *   - `close`  —— 连接被提前掐断（用户点了停止就顺手关掉标签页）。
 *
 * 只接 `finish` 的话，第二种情况下面板**永远不会停**。这是错的：请求已经送达并被受理，
 * 用户并没有把它收回去，凭"没读到我回的 200"就不停是说不过去的。
 *
 * 抽成独立函数是为了能测 —— 埋在路由里的话，这两条分支只能靠真发请求去碰运气。
 *
 * @param response 目标响应。
 * @param fire 落定后要跑的动作。
 */
export function onResponseEnd(response: ResponseEndSource, fire: () => void): void {
  let done = false
  const run = (): void => {
    if (done) return
    done = true
    fire()
  }
  response.once('finish', run)
  response.once('close', run)
}
