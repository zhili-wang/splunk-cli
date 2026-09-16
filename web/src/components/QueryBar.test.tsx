// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { resetQueryHistory } from '../hooks/useQueryHistory'
import { QueryBar } from './QueryBar'

beforeEach(() => {
  localStorage.clear()
  resetQueryHistory()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** A host that owns the query state, the way a page does. */
function Harness({ onSubmit }: { onSubmit?: (query: string) => void } = {}): JSX.Element {
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  return (
    <>
      <QueryBar
        query={query}
        onQuery={setQuery}
        onSubmit={(value) => {
          setSubmitted(value)
          onSubmit?.(value)
        }}
        loading={false}
      />
      <p data-testid="submitted">{submitted}</p>
    </>
  )
}

async function run(query: string): Promise<void> {
  fireEvent.change(screen.getByLabelText('查询语句（SPL）'), { target: { value: query } })
  fireEvent.click(screen.getByRole('button', { name: '查询' }))
  await waitFor(() => {
    expect(screen.getByTestId('submitted').textContent).toBe(query)
  })
}

function toggleHistory(): void {
  fireEvent.click(screen.getByRole('button', { name: /历史查询/ }))
}

describe('QueryBar', () => {
  it('is a plain query box until the history is asked for', () => {
    render(<Harness />)

    expect(screen.getByLabelText('查询语句（SPL）')).toBeDefined()
    expect(screen.getByRole('button', { name: /历史查询/ })).toBeDefined()
    // Collapsed by default: the list would otherwise cover the results.
    expect(screen.queryByRole('list', { name: '查询历史' })).toBeNull()
  })

  it('says the history is empty rather than showing nothing', () => {
    render(<Harness />)

    toggleHistory()

    expect(screen.getByText('还没有查询记录。')).toBeDefined()
    // Nothing to clear yet, so no clear action either.
    expect(screen.queryByRole('button', { name: '清空' })).toBeNull()
  })

  it('remembers a query and offers it again', async () => {
    render(<Harness />)

    await run('index=app level=ERROR')
    toggleHistory()

    expect(screen.getByRole('button', { name: 'index=app level=ERROR' })).toBeDefined()
    expect(screen.getByRole('button', { name: '清空' })).toBeDefined()
  })

  it('re-runs a remembered query when it is picked', async () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)

    await run('index=app')
    onSubmit.mockClear()
    toggleHistory()

    fireEvent.click(screen.getByRole('button', { name: 'index=app' }))

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith('index=app')
    })
    // Picking a query also puts it back in the box.
    expect((screen.getByLabelText('查询语句（SPL）') as HTMLInputElement).value).toBe('index=app')
  })

  it('keeps the newest query at the top', async () => {
    render(<Harness />)

    await run('first=1')
    await run('second=2')
    toggleHistory()

    const items = [...screen.getByRole('list', { name: '查询历史' }).querySelectorAll('li')]
    expect(items.map((item) => item.textContent)).toEqual([
      'second=2×',
      'first=1×',
    ])
  })

  it('deletes a single entry', async () => {
    render(<Harness />)

    await run('first=1')
    await run('second=2')
    toggleHistory()

    fireEvent.click(screen.getByRole('button', { name: '删除记录 first=1' }))

    expect(screen.queryByRole('button', { name: 'first=1' })).toBeNull()
    expect(screen.getByRole('button', { name: 'second=2' })).toBeDefined()
  })

  it('clears the whole history', async () => {
    render(<Harness />)

    await run('first=1')
    await run('second=2')
    toggleHistory()

    fireEvent.click(screen.getByRole('button', { name: '清空' }))

    expect(screen.getByText('还没有查询记录。')).toBeDefined()
    expect(screen.queryByRole('button', { name: '清空' })).toBeNull()
  })

  it('does not remember an empty submission', async () => {
    render(<Harness />)

    // The submit button is disabled while the box is empty, so nothing can be
    // remembered; the list stays empty rather than filling with blanks.
    expect((screen.getByRole('button', { name: '查询' }) as HTMLButtonElement).disabled).toBe(true)

    toggleHistory()
    expect(screen.getByText('还没有查询记录。')).toBeDefined()
  })

  it('shares one history between every query box on the page', async () => {
    // The tabs stay mounted side by side, so two boxes are on screen at once —
    // and they must not drift apart.
    render(
      <>
        <Harness />
        <Harness />
      </>,
    )

    fireEvent.change(screen.getAllByLabelText('查询语句（SPL）')[0] as HTMLElement, {
      target: { value: 'index=tomcat' },
    })
    fireEvent.click(screen.getAllByRole('button', { name: '查询' })[0] as HTMLElement)

    // The first box remembered it; the second box is already offering it.
    await waitFor(() => {
      expect(screen.getAllByTestId('submitted')[0]?.textContent).toBe('index=tomcat')
    })
    fireEvent.click(screen.getAllByRole('button', { name: /历史查询/ })[1] as HTMLElement)

    expect(screen.getByRole('button', { name: 'index=tomcat' })).toBeDefined()
  })

  it('keeps the history across a remount', async () => {
    render(<Harness />)

    await run('index=nginx')
    cleanup()
    render(<Harness />)
    toggleHistory()

    expect(screen.getByRole('button', { name: 'index=nginx' })).toBeDefined()
  })
})
