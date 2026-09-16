// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { SearchBar } from './SearchBar'

afterEach(cleanup)

function setup(query = 'index=app', loading = false): {
  onQuery: ReturnType<typeof vi.fn>
  onSubmit: ReturnType<typeof vi.fn>
  container: HTMLElement
} {
  const onQuery = vi.fn()
  const onSubmit = vi.fn()
  const { container } = render(
    <SearchBar query={query} onQuery={onQuery} onSubmit={onSubmit} loading={loading} />,
  )
  return { onQuery, onSubmit, container }
}

describe('SearchBar', () => {
  it('shows the current query and the documented placeholder', () => {
    setup('index=app level=ERROR')

    const input = screen.getByLabelText('查询语句（SPL）')
    expect((input as HTMLInputElement).value).toBe('index=app level=ERROR')
    expect((input as HTMLInputElement).placeholder).toBe('index=app level=ERROR')
  })

  it('reports every keystroke to the caller', () => {
    const { onQuery } = setup('index=app')

    fireEvent.change(screen.getByLabelText('查询语句（SPL）'), {
      target: { value: 'index=web' },
    })

    expect(onQuery).toHaveBeenCalledWith('index=web')
  })

  it('submits the form instead of reloading the page', () => {
    const { onSubmit, container } = setup()

    const form = container.querySelector('form')
    expect(form).not.toBeNull()
    fireEvent.submit(form as HTMLFormElement)

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('submits on the button too', () => {
    const { onSubmit } = setup()

    fireEvent.click(screen.getByRole('button', { name: '查询' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('disables the button and relabels it while a query is running', () => {
    setup('index=app', true)

    const button = screen.getByRole('button', { name: '查询中…' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('refuses to submit a blank or whitespace-only query', () => {
    setup('   ')

    const button = screen.getByRole('button', { name: '查询' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('enables submission once the query has content', () => {
    setup('index=app')

    const button = screen.getByRole('button', { name: '查询' })
    expect((button as HTMLButtonElement).disabled).toBe(false)
  })
})
