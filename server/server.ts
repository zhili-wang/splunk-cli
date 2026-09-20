/**
 * 服务入口。
 *
 * 只做一件事：启动监听。装配全部在 `app.ts` 里，所以测试可以直接拿到 app 而不必
 * 真的监听端口。
 *
 * **绑定地址固定为 `127.0.0.1`，且不提供修改的选项**（ADR §3.4 D1）：面板只服务本机，
 * 凭据留在本进程内存里，开放到局域网会把账号信息一起暴露出去。
 */

import { createServer, type Server } from 'node:http'

import { createApp, type CreateAppOptions } from './app'
import { DEFAULT_HOST, DEFAULT_PORT } from './web/defaults'
import { attachShutdownHandler } from './web/lifecycle'
import { RUNTIME_KEY, WebRuntime } from './web/runtime'

// 常量本体在 `web/defaults.ts`（零依赖的叶子模块）。这里转出去只因本模块是
// 调用方的既有入口，改签名会波及 CLI；新代码请直接从 `web/defaults` 取。
export { DEFAULT_HOST, DEFAULT_PORT }

/** 启动参数。 */
export interface StartServerOptions extends CreateAppOptions {
  /** 监听端口；`0` 表示由内核分配（测试用）。 */
  port?: number
  onListening?: (info: { port: number }) => void
  /**
   * 页面点了「停止服务」时、在**真正关闭之前**调用；最多一次。
   *
   * 回调交给调用方而不是在这里直接写日志：`server/` 这一层不认识 CLI 的输出通道，
   * 该不该打印、打印成什么样，是 `bin/` 的决定。测试也靠它断言"确实收到了请求"。
   */
  onShutdownRequested?: () => void
}

/** 运行中的服务句柄。 */
export interface RunningServer {
  readonly server: Server
  /** 实际监听端口（传 0 时为内核分配的那个）。 */
  readonly port: number
  /** 优雅关闭：先停 HTTP，再释放连接池。 */
  close: () => Promise<void>
}

/**
 * 启动面板服务。
 *
 * @param options 配置、客户端注入与端口。
 */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const app = createApp(options)
  const server = createServer(app)
  const requested = options.port ?? DEFAULT_PORT

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(requested, DEFAULT_HOST, () => {
      server.removeListener('error', onError)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : requested
  options.onListening?.({ port })

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    // 主动断开 keep-alive 连接，否则 close() 会一直等下去。
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const runtime = app.locals[RUNTIME_KEY]
    if (runtime instanceof WebRuntime) await runtime.close()
  }

  // 页面触发的关闭与 SIGTERM 走**同一条**路径、同一个幂等守卫。
  // 这里先查一次 `closed` 而不是直接调 `close()`：`close()` 虽然幂等，
  // 但 `onShutdownRequested` 会跟着重复触发 —— 连点两下就打印两遍。
  attachShutdownHandler(app, async () => {
    if (closed) return
    options.onShutdownRequested?.()
    await close()
  })

  return { server, port, close }
}
