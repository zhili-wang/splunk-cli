/**
 * 回环端口身份探针。
 *
 * `stop-web` 要往别人的进程发信号，所以"这确实是我们的面板"必须先被证实。
 * 判据只有一个：该端口上 `GET /api/version` 回的是**我们的**形状。
 *
 * 用真实的本地 HTTP 服务端驱动，而不是 mock——这个模块的意义就是"真的连一下"，
 * mock 掉它等于什么都没测。
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { probeVersion } from '../../server/web/probe'

let servers: Server[] = []

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  servers = []
})

/** 起一个只应答 `/api/version` 的极简服务端，返回它的端口。 */
async function serve(
  handler: (request: { url?: string }, response: import('node:http').ServerResponse) => void,
): Promise<number> {
  const server = createServer(handler as never)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return (server.address() as AddressInfo).port
}

/** 一个确定没人在听的端口：先占住再放开。 */
async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

function json(response: import('node:http').ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(body)
}

describe('probeVersion', () => {
  it('认出我们自己的面板', async () => {
    const port = await serve((_request, response) => {
      json(response, 200, JSON.stringify({ name: 'splunk-cli', version: '0.1.0' }))
    })

    await expect(probeVersion(port)).resolves.toBe(true)
  })

  it('只认 /api/version 这个路径', async () => {
    // 首页也是 200，但它不构成身份证明——任何一个网页都可能是 200。
    const port = await serve((request, response) => {
      if (request.url === '/api/version') {
        json(response, 200, JSON.stringify({ name: 'splunk-cli', version: '0.1.0' }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html></html>')
    })

    await expect(probeVersion(port)).resolves.toBe(true)
  })

  it('别人家的服务不是我们的', async () => {
    // 端口号会被复用给毫不相干的程序。这正是名册里那条 pid 记录最危险的地方。
    const port = await serve((_request, response) => {
      json(response, 200, JSON.stringify({ name: 'someone-else', version: '3.0' }))
    })

    await expect(probeVersion(port)).resolves.toBe(false)
  })

  it('同名但版本字段不是字符串也不算', async () => {
    const port = await serve((_request, response) => {
      json(response, 200, JSON.stringify({ name: 'splunk-cli', version: 1 }))
    })

    await expect(probeVersion(port)).resolves.toBe(false)
  })

  it('响应不是 JSON 时返回 false，而不是抛错', async () => {
    const port = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html>hello</html>')
    })

    await expect(probeVersion(port)).resolves.toBe(false)
  })

  it('404 不算', async () => {
    // 旧版本的 dashboard 没有 /api/version 之外的路由，但**有**这个；
    // 真返回 404 说明那不是我们的服务端。
    const port = await serve((_request, response) => {
      json(response, 404, JSON.stringify({ detail: 'Not Found' }))
    })

    await expect(probeVersion(port)).resolves.toBe(false)
  })

  it('没人监听时返回 false，而不是让命令失败', async () => {
    await expect(probeVersion(await unusedPort())).resolves.toBe(false)
  })

  it('连上了但不回包时按超时处理', async () => {
    // 挂死的进程比明明白白的拒绝更常见：内核还在接受连接，但没人应答。
    // 没有超时的话，stop-web 会在这里永远等下去。
    const port = await serve(() => {
      // 故意什么都不回。
    })

    await expect(probeVersion(port, 50)).resolves.toBe(false)
  })
})
