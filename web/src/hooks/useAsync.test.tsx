// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ApiError } from '../api/client'
import { useAsync } from './useAsync'

afterEach(() => {
  // RTL only auto-registers cleanup when `globals: true`; this project uses
  // explicit imports, so unmounting (and clearing ConnectionStatus-style
  // timers) is the test file's job.
  cleanup()
})

interface ProbeProps {
  load: () => Promise<string>
}

function Probe({ load }: ProbeProps): JSX.Element {
  const { data, error, loading, reload } = useAsync(load, [])
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="data">{data ?? 'none'}</span>
      <span data-testid="error">
        {error === null ? 'none' : `${error.type}|${error.message}|${error.status}`}
      </span>
      <button type="button" onClick={reload}>
        reload
      </button>
    </div>
  )
}

describe('useAsync', () => {
  it('starts loading with no data, then reports the resolved value', async () => {
    const load = vi.fn(async () => 'value')

    render(<Probe load={load} />)

    expect(screen.getByTestId('loading').textContent).toBe('true')
    expect(screen.getByTestId('data').textContent).toBe('none')
    expect(screen.getByTestId('error').textContent).toBe('none')

    await waitFor(() => {
      expect(screen.getByTestId('data').textContent).toBe('value')
    })
    expect(screen.getByTestId('loading').textContent).toBe('false')
  })

  it('keeps an ApiError intact so the note can name the backend failure', async () => {
    const load = vi.fn(async () => {
      throw new ApiError('SafetyLimitError', 'range too wide', 422)
    })

    render(<Probe load={load} />)

    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('SafetyLimitError|range too wide|422')
    })
    expect(screen.getByTestId('data').textContent).toBe('none')
    expect(screen.getByTestId('loading').textContent).toBe('false')
  })

  it('wraps an unexpected throwable in an ApiError instead of crashing', async () => {
    // A rejected non-Error (a string, a DOMException) must still reach the UI
    // as something renderable, with status 0 because there was no response.
    const load = vi.fn(async () => {
      throw 'boom'
    })

    render(<Probe load={load} />)

    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('UnexpectedResponse|boom|0')
    })
  })

  it('clears a previous error when a reload succeeds', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('SplunkTimeoutError', 'timed out', 504))
      .mockResolvedValueOnce('recovered')

    render(<Probe load={load} />)

    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toContain('SplunkTimeoutError')
    })

    fireEvent.click(screen.getByRole('button', { name: 'reload' }))

    await waitFor(() => {
      expect(screen.getByTestId('data').textContent).toBe('recovered')
    })
    expect(screen.getByTestId('error').textContent).toBe('none')
  })

  it('ignores a slow earlier request that resolves after a newer one', async () => {
    // Two loads race (deps changed while the first was in flight). The older
    // response must not overwrite the newer one -- otherwise the dashboard
    // shows the answer to a query the user already replaced.
    const resolvers: Array<(value: string) => void> = []
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve)
        }),
    )

    render(<Probe load={load} />)
    expect(resolvers).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'reload' }))
    await waitFor(() => {
      expect(resolvers).toHaveLength(2)
    })

    resolvers[1]?.('newer')
    await waitFor(() => {
      expect(screen.getByTestId('data').textContent).toBe('newer')
    })

    // The stale response arrives last and must be dropped.
    resolvers[0]?.('older')
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false')
    })
    expect(screen.getByTestId('data').textContent).toBe('newer')
  })

  it('ignores a stale rejection so it cannot blank out fresh data', async () => {
    const resolvers: Array<{ resolve: (value: string) => void; reject: (reason: unknown) => void }> = []
    const load = vi.fn(
      () =>
        new Promise<string>((resolve, reject) => {
          resolvers.push({ resolve, reject })
        }),
    )

    render(<Probe load={load} />)
    fireEvent.click(screen.getByRole('button', { name: 'reload' }))
    await waitFor(() => {
      expect(resolvers).toHaveLength(2)
    })

    resolvers[1]?.resolve('newer')
    await waitFor(() => {
      expect(screen.getByTestId('data').textContent).toBe('newer')
    })

    resolvers[0]?.reject(new ApiError('SplunkConnectionError', 'stale failure', 0))
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false')
    })
    expect(screen.getByTestId('data').textContent).toBe('newer')
    expect(screen.getByTestId('error').textContent).toBe('none')
  })
})
