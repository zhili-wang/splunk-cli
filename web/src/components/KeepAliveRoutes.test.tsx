// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Link, MemoryRouter } from 'react-router-dom'

import { KeepAliveRoutes } from './KeepAliveRoutes'

afterEach(cleanup)

const FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true } as const

/** A tab with local state, so "kept alive" is observable rather than asserted. */
function Counter({ label }: { label: string }): JSX.Element {
  const [clicks, setClicks] = useState(0)
  return (
    <button type="button" onClick={() => setClicks((value) => value + 1)}>
      {label}:{clicks}
    </button>
  )
}

function Harness({ initial = '/' }: { initial?: string }): JSX.Element {
  return (
    <MemoryRouter initialEntries={[initial]} future={FUTURE}>
      <nav>
        <Link to="/">去 A</Link>
        <Link to="/b">去 B</Link>
        <Link to="/c">去 C</Link>
      </nav>
      <KeepAliveRoutes
        tabs={[
          { path: '/', element: <Counter label="A" /> },
          { path: '/b', element: <Counter label="B" /> },
          { path: '/c', element: <Counter label="C" /> },
        ]}
      />
    </MemoryRouter>
  )
}

/**
 * Inactive tabs carry `aria-hidden="true"`, which is the point — they are out of
 * the accessibility tree. So a query for a live *or* parked tab has to ask for
 * hidden nodes explicitly.
 */
function tab(label: string): HTMLElement | null {
  return screen.queryByRole('button', { name: label, hidden: true })
}

/** The `aria-hidden` wrapper the host puts around a tab's content. */
function wrapperOf(label: string): HTMLElement {
  const button = tab(label)
  if (button === null) throw new Error(`no tab ${label}`)
  const wrapper = button.closest('[aria-hidden]')
  if (wrapper === null) throw new Error(`no wrapper for ${label}`)
  return wrapper as HTMLElement
}

describe('KeepAliveRoutes', () => {
  it('mounts only the tab being looked at', () => {
    render(<Harness />)

    expect(tab('A:0')).not.toBeNull()
    // Mounting the others up front would fire their queries for nothing.
    expect(tab('B:0')).toBeNull()
    expect(tab('C:0')).toBeNull()
  })

  it('keeps a visited tab mounted after switching away', () => {
    render(<Harness />)

    fireEvent.click(tab('A:0') as HTMLElement)
    fireEvent.click(tab('A:1') as HTMLElement)
    expect(tab('A:2')).not.toBeNull()

    fireEvent.click(screen.getByRole('link', { name: '去 B' }))

    // Still in the tree, just hidden — which is what preserves its state.
    expect(tab('A:2')).not.toBeNull()
    expect(wrapperOf('A:2').getAttribute('aria-hidden')).toBe('true')
    expect(wrapperOf('B:0').getAttribute('aria-hidden')).toBe('false')
  })

  it('preserves the state of a tab you come back to', () => {
    render(<Harness />)

    fireEvent.click(tab('A:0') as HTMLElement)
    fireEvent.click(screen.getByRole('link', { name: '去 B' }))
    fireEvent.click(screen.getByRole('link', { name: '去 A' }))

    // The counter survived the round trip; before keep-alive it restarted at 0.
    expect(tab('A:1')).not.toBeNull()
    expect(wrapperOf('A:1').getAttribute('aria-hidden')).toBe('false')
  })

  it('never mounts a tab that was not visited', () => {
    render(<Harness />)

    fireEvent.click(screen.getByRole('link', { name: '去 B' }))
    fireEvent.click(screen.getByRole('link', { name: '去 A' }))

    expect(tab('A:0')).not.toBeNull()
    expect(tab('B:0')).not.toBeNull()
    expect(tab('C:0')).toBeNull()
  })

  it('keeps the declared tab order whatever the visit order', () => {
    render(<Harness initial="/c" />)

    fireEvent.click(screen.getByRole('link', { name: '去 A' }))

    const wrappers = [...document.querySelectorAll('[aria-hidden]')]
    // Order is the declared one (A before C), not the visit order (C before A);
    // the stable key is what lets React move a wrapper without remounting it.
    expect(wrappers.map((node) => node.getAttribute('aria-hidden'))).toEqual(['false', 'true'])
    expect(tab('C:0')).not.toBeNull()
  })

  it('sends an unknown path to the first tab', () => {
    render(<Harness initial="/no-such-tab" />)

    expect(tab('A:0')).not.toBeNull()
    expect(wrapperOf('A:0').getAttribute('aria-hidden')).toBe('false')
  })
})
