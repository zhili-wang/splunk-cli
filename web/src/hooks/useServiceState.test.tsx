// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

import {
  markRunning,
  markStopped,
  markStopping,
  resetServiceState,
  useServiceState,
} from './useServiceState'

// The store is module-level by design, so it outlives a test file's cases unless
// it is put back. Without this, one case's "stopped" leaks into the next one's
// fresh mount — which is exactly the kind of cross-test bleed that makes a suite
// pass while the product is broken.
beforeEach(resetServiceState)
afterEach(cleanup)

function Probe(): JSX.Element {
  return <span data-testid="state">{useServiceState()}</span>
}

function shown(): string | null {
  return screen.getByTestId('state').textContent
}

describe('useServiceState', () => {
  it('starts running: a page that loaded is being served, by definition', () => {
    render(<Probe />)

    expect(shown()).toBe('running')
  })

  it('follows the store from stopping to stopped', () => {
    render(<Probe />)

    act(() => markStopping())
    expect(shown()).toBe('stopping')

    act(() => markStopped())
    expect(shown()).toBe('stopped')
  })

  it('goes back to running when a stop turns out not to have taken', () => {
    render(<Probe />)

    act(() => markStopping())
    act(() => markStopping())
    // The same signal twice is not two transitions; it must still be "stopping"
    // rather than having drifted anywhere.
    expect(shown()).toBe('stopping')

    act(() => markRunning())
    expect(shown()).toBe('running')
  })

  it('reaches every subscriber, not just the first', () => {
    // The footer button and the header badge read this store independently, and
    // a store that notified only one of them would leave the badge saying
    // "not connected" about a service the user just switched off.
    render(<Probe />)
    render(<Probe />)

    act(() => markStopped())

    expect(screen.getAllByTestId('state').map((node) => node.textContent)).toEqual([
      'stopped',
      'stopped',
    ])
  })

  it('drops a subscriber on unmount', () => {
    const { unmount } = render(<Probe />)
    unmount()

    // Notifying a detached tree is a no-op, but the listener must also be gone:
    // a leaked listener keeps the whole unmounted tree alive.
    act(() => markStopped())

    expect(screen.queryAllByTestId('state')).toHaveLength(0)
  })
})
