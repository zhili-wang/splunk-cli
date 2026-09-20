/**
 * 回环端口身份探针。
 *
 * `stop-web` 要往别人的进程发信号，所以"这确实是我们的面板"必须先被证实。
 * 唯一的判据是：该端口上 `GET /api/version` 回的是**我们的**形状。
 *
 * 只读、幂等、无副作用——探测本身绝不会惊动被探的服务。这与页面上的"停止服务"
 * 用 `GET` 做版本探测是同一个理由。
 */

import { request } from 'node:http'

import { DEFAULT_HOST } from './defaults'

/** 探针超时。够本机回环应答，又不至于让 `stop-web` 在挂死的进程上卡住。 */
export const PROBE_TIMEOUT_MS = 1000

/** `/api/version` 必须回这个名字才算我们。 */
const SERVICE_NAME = 'splunk-cli'

/**
 * 探测某端口上是不是我们的面板。
 *
 * **任何失败都返回 `false`，绝不抛错**：探测的用途是"排除可疑目标"，
 * 一个连不上的端口和不属于我们的端口，在决策上是同一件事。
 *
 * @param port 要探测的端口。
 * @param timeoutMs 超时；默认 {@link PROBE_TIMEOUT_MS}。
 */
export async function probeVersion(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const call = request(
      {
        host: DEFAULT_HOST,
        port,
        path: '/api/version',
        method: 'GET',
        timeout: timeoutMs,
      },
      (response) => {
        if (response.statusCode !== 200) {
          // 必须把响应体读掉，否则连接不会释放。
          response.resume()
          resolve(false)
          return
        }

        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
        })
        response.on('end', () => resolve(looksLikeOurs(body)))
        response.on('error', () => resolve(false))
      },
    )

    // 超时先于 'error' 到达；此时主动销毁连接，让挂死的对端不再占着套接字。
    call.on('timeout', () => {
      call.destroy()
      resolve(false)
    })
    call.on('error', () => resolve(false))
    call.end()
  })
}

/** 响应体是否是我们的身份格式。 */
function looksLikeOurs(body: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return false
  }

  if (typeof parsed !== 'object' || parsed === null) return false

  const document = parsed as Record<string, unknown>
  return document['name'] === SERVICE_NAME && typeof document['version'] === 'string'
}
