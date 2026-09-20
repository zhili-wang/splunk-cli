/**
 * 停止编排。
 *
 * 两条不可动摇的规则，本套测试就是围着它们建的：
 *
 *   1. **绝不升级到 SIGKILL。** 停不掉就如实说停不掉。强杀进程会跳过它自己的清理
 *      （注销名册、释放端口、冲刷日志），把一个"没停掉"换成"停得不明不白"。
 *   2. **成功以"端口不再应答"为准，不以"信号发出去了"为准。** 信号送达不等于对方
 *      听懂了：旧版本可能不认这个信号，进程可能已经僵死。发完信号就宣布成功，
 *      是这类工具最常见的谎言。
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DiscoveredServer, VersionProbe } from '../../server/web/discovery'
import { requestShutdown, stopServers } from '../../server/web/stopper'

let servers: Server[] = []

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  servers = []
})

function target(pid: number, port: number): DiscoveredServer {
  return { pid, port, source: 'registry' }
}

/** 探针按脚本依次回答，用完就停在最后一个回答上。 */
function scripted(...answers: boolean[]): VersionProbe {
  let index = 0
  return vi.fn(async (): Promise<boolean> => {
    const answer = answers[Math.min(index, answers.length - 1)]
    index += 1
    return answer ?? false
  })
}

/** 测试用的小超时：真实计时，但足够快。 */
const FAST = { timeoutMs: 200, pollIntervalMs: 1 }

describe('stopServers · 优雅路径', () => {
  it('先走 HTTP，端口安静下来即为成功', async () => {
    const probe = scripted(false)
    const shutdown = vi.fn(async (): Promise<boolean> => true)
    const signal = vi.fn()

    const results = await stopServers([target(4242, 8765)], {
      ...FAST,
      probe,
      requestShutdown: shutdown,
      signal,
    })

    expect(results).toEqual([{ pid: 4242, port: 8765, outcome: 'stopped' }])
    expect(shutdown).toHaveBeenCalledWith(8765)
    // 优雅路径成功就不该再发信号——那会让对方多做一次无谓的关闭。
    expect(signal).not.toHaveBeenCalled()
  })

  it('HTTP 通道不通时退到 SIGTERM', async () => {
    // 最常见的原因：那个进程是旧版本，压根没有 /api/shutdown 这条路由。
    const probe = scripted(false)
    const shutdown = vi.fn(async (): Promise<boolean> => false)
    const signal = vi.fn()

    const results = await stopServers([target(4242, 8765)], {
      ...FAST,
      probe,
      requestShutdown: shutdown,
      signal,
    })

    expect(results).toEqual([{ pid: 4242, port: 8765, outcome: 'stopped' }])
    expect(signal).toHaveBeenCalledWith(4242, 'SIGTERM')
  })

  it('HTTP 应答了但服务没停，仍然退到 SIGTERM', async () => {
    // 关闭请求被受理了，却卡在某个环节（比如一条不肯断开的连接）。
    // "应答了 200"不是停止的证据，端口安静下来才是。
    // 探针只在信号发出后才转静，因此这次停止只能是信号带来的。
    let signalled = false
    const probe = vi.fn(async () => !signalled)
    const shutdown = vi.fn(async (): Promise<boolean> => true)
    const signal = vi.fn(() => {
      signalled = true
    })

    const results = await stopServers([target(4242, 8765)], {
      ...FAST,
      timeoutMs: 20,
      probe,
      requestShutdown: shutdown,
      signal,
    })

    expect(results).toEqual([{ pid: 4242, port: 8765, outcome: 'stopped' }])
    expect(signal).toHaveBeenCalledWith(4242, 'SIGTERM')
  })

  it('轮询等待，而不是探一次就下结论', async () => {
    // 服务端在应答 200 之后还要过一小段时间才真正释放端口。
    const probe = scripted(true, true, true, false)

    const results = await stopServers([target(4242, 8765)], {
      ...FAST,
      probe,
      requestShutdown: vi.fn(async (): Promise<boolean> => true),
      signal: vi.fn(),
    })

    expect(results).toEqual([{ pid: 4242, port: 8765, outcome: 'stopped' }])
    expect(vi.mocked(probe).mock.calls.length).toBeGreaterThanOrEqual(4)
  })
})

describe('stopServers · 停不掉的时候', () => {
  it('服务始终不应答停止时，如实报告失败', async () => {
    const signal = vi.fn()

    const results = await stopServers([target(4242, 8765)], {
      ...FAST,
      timeoutMs: 20,
      probe: scripted(true),
      requestShutdown: vi.fn(async (): Promise<boolean> => true),
      signal,
    })

    expect(results).toEqual([
      { pid: 4242, port: 8765, outcome: 'failed', reason: 'still-running' },
    ])
  })

  it('失败时绝不升级到 SIGKILL', async () => {
    // 强杀会跳过对方自己的清理。宁可留一个用户看得见、能自己处理的进程，
    // 也不要一个"看起来没了"的进程。
    const signal = vi.fn()

    await stopServers([target(4242, 8765)], {
      ...FAST,
      timeoutMs: 20,
      probe: scripted(true),
      requestShutdown: vi.fn(async (): Promise<boolean> => true),
      signal,
    })

    expect(signal.mock.calls.map((call) => call[1])).toEqual(['SIGTERM'])
    expect(signal.mock.calls.map((call) => call[1])).not.toContain('SIGKILL')
  })

  it('没有权限发信号时如实报告，而不是假装停过', async () => {
    const signal = vi.fn(() => {
      const error = new Error('kill EPERM') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    })

    const results = await stopServers([target(4242, 8765)], {
      ...FAST,
      probe: scripted(true),
      requestShutdown: vi.fn(async (): Promise<boolean> => false),
      signal,
    })

    expect(results).toEqual([
      { pid: 4242, port: 8765, outcome: 'failed', reason: 'permission-denied' },
    ])
  })

  it('进程已经不存在时视为已停止', async () => {
    // ESRCH：信号还没发出去进程就没了。它确实停了，这不是失败。
    const signal = vi.fn(() => {
      const error = new Error('kill ESRCH') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    })

    const results = await stopServers([target(4242, 8765)], {
      ...FAST,
      probe: scripted(false),
      requestShutdown: vi.fn(async (): Promise<boolean> => false),
      signal,
    })

    expect(results).toEqual([{ pid: 4242, port: 8765, outcome: 'stopped' }])
  })

  it('发信号时遇到别的错误也如实报告，不吞掉', async () => {
    const signal = vi.fn(() => {
      throw new Error('something unexpected')
    })

    const results = await stopServers([target(4242, 8765)], {
      ...FAST,
      probe: scripted(true),
      requestShutdown: vi.fn(async (): Promise<boolean> => false),
      signal,
    })

    expect(results).toEqual([
      { pid: 4242, port: 8765, outcome: 'failed', reason: 'signal-failed' },
    ])
  })
})

describe('stopServers · 多个服务', () => {
  it('每个服务独立处理，一个失败不影响另一个', async () => {
    // 8765 停得掉，8846 停不掉。两者各自如实报告——
    // 一个卡住的进程不该让用户失去停掉其余服务的机会。
    const probe = vi.fn(async (port: number) => port === 8846)
    const shutdown = vi.fn(async (): Promise<boolean> => true)
    const signal = vi.fn()

    const results = await stopServers([target(4242, 8765), target(5353, 8846)], {
      ...FAST,
      timeoutMs: 20,
      probe,
      requestShutdown: shutdown,
      signal,
    })

    expect(results).toEqual([
      { pid: 4242, port: 8765, outcome: 'stopped' },
      { pid: 5353, port: 8846, outcome: 'failed', reason: 'still-running' },
    ])
  })

  it('没有服务时返回空列表', async () => {
    await expect(stopServers([], FAST)).resolves.toEqual([])
  })
})

describe('requestShutdown', () => {
  /** 起一个记录方法、并按给定状态码应答的假面板。 */
  async function panel(status: number, body: string): Promise<{ port: number; hits: string[] }> {
    const hits: string[] = []
    const server = createServer((request, response) => {
      hits.push(`${request.method ?? '?'} ${request.url ?? '?'}`)
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(body)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    return { port: (server.address() as AddressInfo).port, hits }
  }

  it('用 POST 请求 /api/shutdown', async () => {
    // 方法和路径都是契约：GET 必须永远不触发关闭，否则一次探测就能关掉面板。
    const fake = await panel(200, JSON.stringify({ success: true, stopping: true }))

    await expect(requestShutdown(fake.port)).resolves.toBe(true)
    expect(fake.hits).toEqual(['POST /api/shutdown'])
  })

  it('旧版本返回 404 时是 false，交给 SIGTERM 兜底', async () => {
    const fake = await panel(404, JSON.stringify({ detail: 'Not Found' }))

    await expect(requestShutdown(fake.port)).resolves.toBe(false)
  })

  it('没人监听时是 false，而不是抛错', async () => {
    const fake = await panel(200, '{}')
    await expect(requestShutdown(fake.port)).resolves.toBe(false)
  })

  it('应答了但不是我们的成功格式时是 false', async () => {
    const fake = await panel(200, JSON.stringify({ success: false }))

    await expect(requestShutdown(fake.port)).resolves.toBe(false)
  })
})
