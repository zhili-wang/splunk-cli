/**
 * 面板生命周期钩子与 `POST /api/shutdown` 的接线。
 *
 * 这里守的是一个**看不见**的错误：关闭抢在响应前面。那样浏览器拿到的是连接重置，
 * 而不是我们刚写出去的那个 200 —— 用户以为失败，反复点一个其实已经生效的按钮，
 * 而服务端这边一切正常，日志里不会有任何东西报错。
 */

import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../../server/app'
import { setLoggerOutput } from '../../server/logger'
import { startServer, type RunningServer } from '../../server/server'
import {
  SHUTDOWN_GRACE_MS,
  attachShutdownHandler,
  onResponseEnd,
  scheduleShutdown,
  shutdownHandlerOf,
  type ResponseEndSource,
} from '../../server/web/lifecycle'
import { okSearchClient, settings } from './stub'

/** 起过的服务，不管用例成功与否都要关掉，否则句柄会漏到下一条用例。 */
const running: RunningServer[] = []

afterEach(async () => {
  for (const server of running.splice(0)) await server.close()
  setLoggerOutput(null)
})

/**
 * 等到条件成立。
 *
 * 预算（4s）远大于需要等的量（一个 150ms 的定时器），所以真超时了就说明
 * 关闭压根没被排上，而不是"机器慢"。
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitUntil 超时')
}

/** 只带 `once` 的假响应，用来把两条分支各走一遍。 */
function fakeResponse(): {
  source: ResponseEndSource
  emit: (event: 'finish' | 'close') => void
} {
  const listeners = new Map<string, Array<() => void>>()
  return {
    source: {
      once: (event, listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
        return undefined
      },
    },
    emit: (event) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener()
    },
  }
}

async function startTestServer(overrides: { onShutdownRequested?: () => void } = {}): Promise<RunningServer> {
  const started = await startServer({
    settings: settings(),
    client: okSearchClient(),
    webDir: null,
    port: 0,
    ...overrides,
  })
  running.push(started)
  return started
}

describe('shutdownHandlerOf / attachShutdownHandler', () => {
  it('没挂钩子时返回 null —— 这是合法状态，不是异常', () => {
    const app = createApp({ settings: settings(), client: okSearchClient(), webDir: null })
    expect(shutdownHandlerOf(app)).toBeNull()
  })

  it('挂上之后能原样取回', () => {
    const app = createApp({ settings: settings(), client: okSearchClient(), webDir: null })
    const handler = (): void => {}
    attachShutdownHandler(app, handler)
    expect(shutdownHandlerOf(app)).toBe(handler)
  })

  it('locals 里是别的类型时也当作没挂，而不是把一个非函数当函数调', () => {
    const app = createApp({ settings: settings(), client: okSearchClient(), webDir: null })
    app.locals['shutdown'] = 'not a function'
    expect(shutdownHandlerOf(app)).toBeNull()
    app.locals['shutdown'] = undefined
    expect(shutdownHandlerOf(app)).toBeNull()
  })
})

describe('onResponseEnd', () => {
  it('finish 先到 → 执行一次', () => {
    const response = fakeResponse()
    let fired = 0
    onResponseEnd(response.source, () => {
      fired += 1
    })

    response.emit('finish')

    expect(fired).toBe(1)
  })

  it('客户端提前断开（close 先到）→ 照样执行', () => {
    // 用户点了「停止服务」然后顺手关掉标签页。请求已经送达并被受理，
    // 他没有把它收回去 —— 只接 `finish` 的话面板就永远不会停。
    const response = fakeResponse()
    let fired = 0
    onResponseEnd(response.source, () => {
      fired += 1
    })

    response.emit('close')

    expect(fired).toBe(1)
  })

  it('两个都到也只执行一次', () => {
    const response = fakeResponse()
    let fired = 0
    onResponseEnd(response.source, () => {
      fired += 1
    })

    response.emit('finish')
    response.emit('close')

    expect(fired).toBe(1)
  })
})

describe('scheduleShutdown', () => {
  it('到点调用钩子', async () => {
    let called = 0
    scheduleShutdown(() => {
      called += 1
    }, 5)

    expect(called).toBe(0)
    await waitUntil(() => called === 1, 1000)
    expect(called).toBe(1)
  })

  it('默认宽限窗口是个正的有限值', () => {
    // 0 会让响应没有冲刷时间，负数会让 setTimeout 立即触发 —— 两者都等于把
    // 这段设计作废。这里只是钉住"有人改成 0 会被发现"。
    expect(SHUTDOWN_GRACE_MS).toBeGreaterThan(0)
    expect(Number.isFinite(SHUTDOWN_GRACE_MS)).toBe(true)
  })

  it('钩子失败时记 error 日志，而不是变成未处理的 rejection', async () => {
    // 静默吞掉会让进程一直活着而用户以为已经停了；不接住则会让整个进程崩掉。
    // 两者都不行，所以走日志。
    const lines: string[] = []
    setLoggerOutput((line) => lines.push(line))

    scheduleShutdown(() => {
      throw new Error('close failed')
    }, 5)

    await waitUntil(() => lines.length > 0, 1000)
    expect(lines.join('\n')).toContain('shutdown failed')
    expect(lines.join('\n')).toContain('close failed')
  })
})

describe('startServer 的关闭接线', () => {
  it('POST /api/shutdown → 通知一次，随后端口不再接受连接', async () => {
    let notified = 0
    const started = await startTestServer({
      onShutdownRequested: () => {
        notified += 1
      },
    })
    const url = `http://127.0.0.1:${started.port}/api/shutdown`

    const response = await fetch(url, { method: 'POST' })

    // 响应**先**到手，而且它是个正经的 200 —— 这就是整个宽限窗口存在的理由。
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, stopping: true })

    await waitUntil(() => !started.server.listening)
    expect(notified).toBe(1)
    await expect(fetch(`http://127.0.0.1:${started.port}/api/health`)).rejects.toThrow()
  })

  it('连点两下只通知一次、只关一次', async () => {
    let notified = 0
    const started = await startTestServer({
      onShutdownRequested: () => {
        notified += 1
      },
    })
    const url = `http://127.0.0.1:${started.port}/api/shutdown`

    // 两个请求都落在宽限窗口之内，都会被受理 —— 用户连点不该关两次。
    const [first, second] = await Promise.all([
      fetch(url, { method: 'POST' }),
      fetch(url, { method: 'POST' }),
    ])
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    await waitUntil(() => !started.server.listening)
    // 再等一段（长于一个宽限窗口），确认没有迟到的第二次关闭。
    await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS * 2))
    expect(notified).toBe(1)
  })

  it('没挂 `onShutdownRequested` 也照样关（回调是可选的）', async () => {
    const started = await startTestServer()
    const response = await fetch(`http://127.0.0.1:${started.port}/api/shutdown`, {
      method: 'POST',
    })
    expect(response.status).toBe(200)
    await waitUntil(() => !started.server.listening)
  })
})
