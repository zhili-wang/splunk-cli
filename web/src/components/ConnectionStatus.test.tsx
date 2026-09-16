// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

import { fetchHealth } from '../api/endpoints'
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
