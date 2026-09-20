/**
 * 停止编排：把"发现到的服务"变成"真的停掉了"。
 *
 * 两条规则贯穿始终：
 *
 *   1. **绝不升级到 SIGKILL。** 停不掉就如实说停不掉。强杀跳过对方自己的清理
 *      （注销名册、释放端口、冲刷日志），把"没停掉"换成"停得不明不白"。
 *   2. **成功以"端口不再应答"为准。** 信号送达不等于对方听懂了；应答了 200
 *      也不等于它已经走了。只有回环端口上再也探不到我们的服务，才算停掉。
 *
 * 停止的阶梯：`POST /api/shutdown`（最优雅）→ `SIGTERM`（旧版本没有那条路由，
 * 但认信号）→ 超时后如实报告失败。
 */

import { request } from 'node:http'

import type { DiscoveredServer, VersionProbe } from './discovery'
import { probeVersion } from './probe'

/** 面板上的"停止服务"按钮用的同一个端点。方法必须是 POST。 */
export const SHUTDOWN_PATH = '/api/shutdown'

/** 单次关闭请求的超时。要够覆盖服务端 150ms 的响应冲刷窗口。 */
export const SHUTDOWN_REQUEST_TIMEOUT_MS = 1000

/** 每一级阶梯等待对方停下来的时长。 */
export const SHUTDOWN_TIMEOUT_MS = 5000

/** 等待期间的轮询间隔。 */
export const POLL_INTERVAL_MS = 100

/** 失败原因。 */
export type StopReason = 'permission-denied' | 'still-running' | 'signal-failed'

/**
 * 单个服务的停止结果。
 *
 * 写成可辨识联合，而不是 `outcome` 加一个可选 `reason`：后者允许"停掉了却带着
 * 原因"和"失败了却没有原因"这两种无意义的状态存在，每个读取方都得自己补兜底值。
 * 类型把话说完，调用方就不必猜。
 */
export type StopResult =
  | { readonly pid: number; readonly port: number; readonly outcome: 'stopped' }
  | {
      readonly pid: number
      readonly port: number
      readonly outcome: 'failed'
      /** 失败原因，供调用方如实渲染。 */
      readonly reason: StopReason
    }

/** 请求某个端口上的面板自行关闭。返回它是否受理。 */
export type ShutdownClient = (port: number) => Promise<boolean>

/** 发信号。注入以便测试，默认走 `process.kill`。 */
export type SignalSender = (pid: number, signal: NodeJS.Signals) => void

/** `stopServers` 的可注入依赖。 */
export interface StopOptions {
  /** 判断端口上是否仍有我们的服务在应答；默认连真实端口。 */
  readonly probe?: VersionProbe
  /** 关闭请求客户端；默认发真实的 POST。 */
  readonly requestShutdown?: ShutdownClient
  /** 信号发送器；默认 `process.kill`。 */
  readonly signal?: SignalSender
  /** 每一级阶梯的等待上限；默认 {@link SHUTDOWN_TIMEOUT_MS}。 */
  readonly timeoutMs?: number
  /** 等待期间的轮询间隔；默认 {@link POLL_INTERVAL_MS}。 */
  readonly pollIntervalMs?: number
}

/**
 * 停止给定的服务，逐个独立处理。
 *
 * 一个服务停不掉不会影响其余服务，也不会让本函数抛错——调用方拿到的是逐条的
 * 结果，自行决定退出码。
 *
 * @param servers 已由 {@link discoverServers} 确认身份的服务。
 * @param options 可注入依赖与超时。
 */
export async function stopServers(
  servers: readonly DiscoveredServer[],
  options: StopOptions = {},
): Promise<StopResult[]> {
  const results: StopResult[] = []
  for (const server of servers) {
    results.push(await stopServer(server, options))
  }
  return results
}

async function stopServer(server: DiscoveredServer, options: StopOptions): Promise<StopResult> {
  const {
    probe = probeVersion,
    requestShutdown: shutdown = requestShutdown,
    signal = process.kill,
    timeoutMs = SHUTDOWN_TIMEOUT_MS,
    pollIntervalMs = POLL_INTERVAL_MS,
  } = options

  const { pid, port } = server
  const stopped = (): StopResult => ({ pid, port, outcome: 'stopped' })
  const failed = (reason: StopReason): StopResult => ({ pid, port, outcome: 'failed', reason })

  // 第一级：请它自己体面地关闭。
  if (await shutdown(port)) {
    if (await waitUntilQuiet(port, probe, timeoutMs, pollIntervalMs)) return stopped()
  }

  // 第二级：信号。旧版本没有 /api/shutdown 路由，但认得 SIGTERM，
  // 走的仍然是同一条优雅关闭路径。
  try {
    signal(pid, 'SIGTERM')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // 信号还没发出去进程就没了——它确实停了。
    if (code === 'ESRCH') return stopped()
    return failed(code === 'EPERM' ? 'permission-denied' : 'signal-failed')
  }

  return (await waitUntilQuiet(port, probe, timeoutMs, pollIntervalMs))
    ? stopped()
    : // 到此为止。绝不追加 SIGKILL。
      failed('still-running')
}

/**
 * 轮询到端口上再也探不到我们的服务为止。
 *
 * @returns 是否在超时前安静下来。
 */
async function waitUntilQuiet(
  port: number,
  probe: VersionProbe,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    if (!(await probe(port))) return true
    if (Date.now() >= deadline) return false
    await delay(pollIntervalMs)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 请求某个端口上的面板自行关闭。
 *
 * **任何失败都返回 `false`，绝不抛错**：调用方对"没有这条路由"和"连不上"
 * 的处理完全一样——退到 SIGTERM。
 *
 * @param port 目标端口。
 * @param timeoutMs 超时；默认 {@link SHUTDOWN_REQUEST_TIMEOUT_MS}。
 */
export async function requestShutdown(
  port: number,
  timeoutMs = SHUTDOWN_REQUEST_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const call = request(
      {
        host: '127.0.0.1',
        port,
        path: SHUTDOWN_PATH,
        method: 'POST',
        timeout: timeoutMs,
        headers: { 'content-type': 'application/json', 'content-length': '0' },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          resolve(false)
          return
        }

        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
        })
        response.on('end', () => resolve(accepted(body)))
        response.on('error', () => resolve(false))
      },
    )

    call.on('timeout', () => {
      call.destroy()
      resolve(false)
    })
    call.on('error', () => resolve(false))
    call.end()
  })
}

/** 响应体是否表示"关闭已被受理"。 */
function accepted(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null) return false
    return (parsed as Record<string, unknown>)['success'] === true
  } catch {
    return false
  }
}
