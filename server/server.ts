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
import { RUNTIME_KEY, WebRuntime } from './web/runtime'

/** 固定监听地址；刻意不做成可配置项。 */
export const DEFAULT_HOST = '127.0.0.1'

/** 默认端口。 */
export const DEFAULT_PORT = 8765

/** 启动参数。 */
export interface StartServerOptions extends CreateAppOptions {
  /** 监听端口；`0` 表示由内核分配（测试用）。 */
  port?: number
  onListening?: (info: { port: number }) => void
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

  return { server, port, close }
}
