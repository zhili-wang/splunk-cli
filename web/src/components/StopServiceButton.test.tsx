// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { fetchHealth, stopService } from '../api/endpoints'
import { resetServiceState } from '../hooks/useServiceState'
import type { HealthReport } from '../types/api'
import { CONFIRM_TIMEOUT_MS, StopServiceButton } from './StopServiceButton'

vi.mock('../api/endpoints', () => ({ fetchHealth: vi.fn(), stopService: vi.fn() }))

const stopServiceMock = vi.mocked(stopService)
const fetchHealthMock = vi.mocked(fetchHealth)

beforeEach(() => {
  resetServiceState()
  stopServiceMock.mockResolvedValue({ success: true, stopping: true, message: 'bye' })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

function healthy(): HealthReport {
  return { success: true, connection: 'ok', authentication: 'ok', splunk: { version: '9.0.2' } }
}

function armed(): HTMLElement {
  return screen.getByRole('button', { name: '确认停止？' })
}

function plain(): HTMLElement {
  return screen.getByRole('button', { name: '停止服务' })
}

describe('StopServiceButton', () => {
  it('offers the plain button, and the first click only asks', () => {
    // Arming, not stopping: one click must never be enough to end the session.
    render(<StopServiceButton />)

    fireEvent.click(plain())

    expect(armed()).toBeDefined()
    expect(stopServiceMock).not.toHaveBeenCalled()
  })

  it('stops on the second click, and says what it is doing meanwhile', async () => {
    let release!: () => void
    stopServiceMock.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ success: true, stopping: true, message: 'bye' })
      }),
    )
    render(<StopServiceButton />)

    fireEvent.click(plain())
    fireEvent.click(armed())

    expect(stopServiceMock).toHaveBeenCalledTimes(1)
    // The reply has not arrived, so the honest answer is "stopping", not "stopped".
    expect(screen.getByText('正在停止…')).toBeDefined()

    await act(async () => {
      release()
    })

    expect(await screen.findByText('服务已停止')).toBeDefined()
  })

  it('puts itself back after the confirm step goes stale', () => {
    // An armed button that stays armed stops the service on some later,
    // unrelated click — which is precisely the accident the confirm step exists
    // to prevent, so leaving it armed forever would defeat its own purpose.
    vi.useFakeTimers()
    render(<StopServiceButton />)

    fireEvent.click(plain())
    expect(armed()).toBeDefined()

    act(() => {
      vi.advanceTimersByTime(CONFIRM_TIMEOUT_MS)
    })

    expect(plain()).toBeDefined()
    expect(screen.queryByRole('button', { name: '确认停止？' })).toBeNull()
  })

  it('reverts the confirm step when the second click lands, timer and all', async () => {
    render(<StopServiceButton />)

    fireEvent.click(plain())
    fireEvent.click(armed())

    await screen.findByText('服务已停止')
    // Nothing left armed behind the "stopped" line.
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('treats a dropped reply as a successful stop when the service stops answering', async () => {
    // The ambiguous case, and on loopback the common one: the server destroys
    // the socket moments after writing the 200, so the browser can see a
    // network error for a stop that worked perfectly. Reporting failure here
    // would send the user clicking a button whose service is already gone.
    stopServiceMock.mockRejectedValue(new Error('network error'))
    fetchHealthMock.mockRejectedValue(new Error('ECONNREFUSED'))
    render(<StopServiceButton />)

    fireEvent.click(plain())
    fireEvent.click(armed())

    expect(await screen.findByText('服务已停止')).toBeDefined()
    expect(fetchHealthMock).toHaveBeenCalledTimes(1)
  })

  it('reports a real failure when the service is still answering', async () => {
    // The other half of the same ambiguity: a rejected POST with a live service
    // behind it is a genuine failure, and saying "stopped" would leave the user
    // with a dashboard they believe is off.
    stopServiceMock.mockRejectedValue(new Error('500'))
    fetchHealthMock.mockResolvedValue(healthy())
    render(<StopServiceButton />)

    fireEvent.click(plain())
    fireEvent.click(armed())

    expect(await screen.findByText('停止失败')).toBeDefined()
    // Back on offer, so a retry is one click away.
    expect(plain()).toBeDefined()
  })

  it('clears a previous failure when a retry starts', async () => {
    stopServiceMock.mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce({
      success: true,
      stopping: true,
      message: 'bye',
    })
    fetchHealthMock.mockResolvedValue(healthy())
    render(<StopServiceButton />)

    fireEvent.click(plain())
    fireEvent.click(armed())
    await screen.findByText('停止失败')

    fireEvent.click(plain())
    fireEvent.click(armed())

    await waitFor(() => {
      expect(screen.queryByText('停止失败')).toBeNull()
    })
    expect(await screen.findByText('服务已停止')).toBeDefined()
  })

  it('does not probe the health endpoint on the happy path', async () => {
    // The probe exists only to resolve the ambiguity; spending a request on
    // every successful stop would be waste.
    render(<StopServiceButton />)

    fireEvent.click(plain())
    fireEvent.click(armed())

    await screen.findByText('服务已停止')
    expect(fetchHealthMock).not.toHaveBeenCalled()
  })
})
