// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

import { fetchHealth } from '../api/endpoints'
import {
  markRunning,
  markStopped,
  markStopping,
  resetServiceState,
} from '../hooks/useServiceState'
import type { HealthReport } from '../types/api'
import { ConnectionStatus } from './ConnectionStatus'

vi.mock('../api/endpoints', () => ({ fetchHealth: vi.fn() }))

const fetchHealthMock = vi.mocked(fetchHealth)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

function healthy(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    success: true,
    connection: 'ok',
    authentication: 'ok',
    latency_ms: 12.34,
    splunk: { version: '9.0.2' },
    ...overrides,
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

/** Let the promise chain inside the probe resolve. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('ConnectionStatus', () => {
  it('reports progress before the first probe answers', () => {
    fetchHealthMock.mockReturnValue(new Promise(() => {}))

    render(<ConnectionStatus />)

    expect(screen.getByText('正在检查 Splunk…')).toBeDefined()
  })

  it('reports a healthy connection with the server version and latency', async () => {
    fetchHealthMock.mockResolvedValue(healthy())

    render(<ConnectionStatus />)

    await screen.findByText('已连接')
    expect(screen.getByText('12ms')).toBeDefined()
    expect(screen.getByTitle('Splunk 9.0.2')).toBeDefined()
  })

  it('omits latency when the backend did not measure it', async () => {
    // `latency_ms` is optional in the contract; the badge must not print
    // "undefinedms" or a fabricated 0.
    fetchHealthMock.mockResolvedValue({
      success: true,
      connection: 'ok',
      authentication: 'ok',
      splunk: { version: '9.0.2' },
    })

    render(<ConnectionStatus />)

    await screen.findByText('已连接')
    expect(screen.queryByText(/ms$/)).toBeNull()
  })

  it('still reports a healthy connection when the server block is absent', async () => {
    // `splunk` is dropped whenever the server reports nothing, so
    // the version hint must degrade to a bare "Splunk", not "Splunk undefined".
    fetchHealthMock.mockResolvedValue({
      success: true,
      connection: 'ok',
      authentication: 'ok',
    })

    render(<ConnectionStatus />)

    await screen.findByText('已连接')
    expect(screen.getByTitle('Splunk')).toBeDefined()
  })

  it('reports a failed authentication as not connected', async () => {
    // Reachable but unauthenticated is still unusable: the badge must not say
    // "connected" for a server the dashboard cannot read.
    fetchHealthMock.mockResolvedValue(
      healthy({
        authentication: 'failed',
        error: { type: 'SplunkAuthenticationError', message: 'invalid credentials' },
      }),
    )

    render(<ConnectionStatus />)

    await screen.findByText('未连接')
    expect(screen.getByTitle('invalid credentials')).toBeDefined()
  })

  it('reports a failed probe as not connected without inventing a message', async () => {
    fetchHealthMock.mockRejectedValue(new Error('ECONNREFUSED'))

    const { container } = render(<ConnectionStatus />)

    await screen.findByText('未连接')
    expect(container.querySelector('[title=""]')).not.toBeNull()
  })

  it('re-probes on its polling interval and clears it on unmount', async () => {
    fetchHealthMock.mockResolvedValue(healthy())
    const setIntervalSpy = vi.spyOn(window, 'setInterval')
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval')

    const { unmount } = render(<ConnectionStatus />)
    await screen.findByText('已连接')

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000)
    expect(fetchHealthMock).toHaveBeenCalledTimes(1)

    const tick = setIntervalSpy.mock.calls[0]?.[0] as (() => void) | undefined
    await act(async () => {
      tick?.()
    })
    await waitFor(() => {
      expect(fetchHealthMock).toHaveBeenCalledTimes(2)
    })

    unmount()
    expect(clearIntervalSpy).toHaveBeenCalled()
  })

  it('ignores a probe that answers after unmount', async () => {
    // The request is in flight when the user navigates away. A late `setState`
    // would touch a dead tree, so the effect's `active` flag must drop it.
    const probe = deferred<HealthReport>()
    fetchHealthMock.mockReturnValue(probe.promise)

    const { container, unmount } = render(<ConnectionStatus />)
    unmount()

    probe.resolve(healthy())
    await settle()

    // The detached tree is left exactly as it was: the late answer is dropped.
    expect(container.innerHTML).toBe('')
  })

  it('ignores a rejection that arrives after unmount', async () => {
    const probe = deferred<HealthReport>()
    fetchHealthMock.mockReturnValue(probe.promise)

    const { container, unmount } = render(<ConnectionStatus />)
    unmount()

    probe.reject(new Error('boom'))
    await settle()

    expect(container.innerHTML).toBe('')
  })
})

describe('ConnectionStatus · while the service is being stopped', () => {
  beforeEach(resetServiceState)

  it('says the service is stopping, not that Splunk is unreachable', async () => {
    // A red "not connected" would blame Splunk for something the user just did
    // on purpose. The probe cannot distinguish the two — every request fails
    // once the server is gone — so the store has to.
    fetchHealthMock.mockResolvedValue(healthy())
    render(<ConnectionStatus />)
    await screen.findByText('已连接')

    act(() => markStopping())

    expect(screen.getByText('正在停止…')).toBeDefined()
    expect(screen.queryByText('未连接')).toBeNull()
  })

  it('says stopped once it has stopped', async () => {
    fetchHealthMock.mockResolvedValue(healthy())
    render(<ConnectionStatus />)
    await screen.findByText('已连接')

    act(() => markStopped())

    expect(screen.getByText('已停止')).toBeDefined()
    expect(screen.queryByText('未连接')).toBeNull()
  })

  it('drops the latency it measured, which describes a server that is gone', async () => {
    fetchHealthMock.mockResolvedValue(healthy())
    render(<ConnectionStatus />)
    await screen.findByText('12ms')

    act(() => markStopped())

    expect(screen.queryByText('12ms')).toBeNull()
    expect(screen.queryByTitle('Splunk 9.0.2')).toBeNull()
  })

  it('stops polling, because every probe from here can only fail', async () => {
    fetchHealthMock.mockResolvedValue(healthy())
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval')
    render(<ConnectionStatus />)
    await screen.findByText('已连接')
    expect(fetchHealthMock).toHaveBeenCalledTimes(1)
    // The healthy state's own interval is not what this case is about.
    clearIntervalSpy.mockClear()

    act(() => markStopping())

    // The interval driving the poll goes with the effect that owned it...
    expect(clearIntervalSpy).toHaveBeenCalled()
    // ...and no new probe was sent, now or on the next tick.
    expect(fetchHealthMock).toHaveBeenCalledTimes(1)
  })

  it('an already-leaving service never probes at all', () => {
    markStopped()
    const setIntervalSpy = vi.spyOn(window, 'setInterval')

    render(<ConnectionStatus />)

    expect(fetchHealthMock).not.toHaveBeenCalled()
    expect(setIntervalSpy).not.toHaveBeenCalled()
    expect(screen.getByText('已停止')).toBeDefined()
  })

  it('resumes polling when a stop that failed puts the service back', async () => {
    // The store can go back to `running` (the button probes health to find out,
    // and a live answer means the stop did not take). Going quiet permanently
    // would freeze the badge on a dashboard that is very much still up.
    markStopped()
    fetchHealthMock.mockResolvedValue(healthy())
    render(<ConnectionStatus />)
    expect(fetchHealthMock).not.toHaveBeenCalled()

    act(() => markRunning())

    await screen.findByText('已连接')
  })
})
