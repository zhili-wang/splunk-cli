// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { ApiError } from '../api/client'
import { ErrorNote } from './ErrorNote'

afterEach(cleanup)

describe('ErrorNote', () => {
  it('names the error type and shows the backend message verbatim', () => {
    render(
      <ErrorNote
        error={new ApiError('SafetyLimitError', '时间范围超过上限 7d', 422)}
      />,
    )

    expect(screen.getByRole('alert')).toBeDefined()
    expect(screen.getByText('SafetyLimitError')).toBeDefined()
    expect(screen.getByText('时间范围超过上限 7d')).toBeDefined()
  })

  it('renders the structured details a caller can branch on', () => {
    const { container } = render(
      <ErrorNote
        error={
          new ApiError('SafetyLimitError', 'range too wide', 422, {
            earliest: '-30d',
            max_time_range: '7d',
          })
        }
      />,
    )

    const pre = container.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre?.textContent).toContain('"max_time_range": "7d"')
  })

  it('accepts a plain ErrorDetail, not only an ApiError instance', () => {
    // Overview sub-panel failures arrive as decoded JSON, not as thrown errors.
    render(<ErrorNote error={{ type: 'SplunkQueryError', message: 'search failed' }} />)

    expect(screen.getByText('SplunkQueryError')).toBeDefined()
    expect(screen.getByText('search failed')).toBeDefined()
  })

  it('omits the details block when the backend sent none', () => {
    const { container } = render(
      <ErrorNote error={{ type: 'SplunkQueryError', message: 'search failed' }} />,
    )

    expect(container.querySelector('pre')).toBeNull()
  })

  it('hides details when rendered compactly', () => {
    const { container } = render(
      <ErrorNote compact error={new ApiError('SplunkQueryError', 'x', 500, { sid: '1' })} />,
    )

    expect(container.querySelector('pre')).toBeNull()
    expect(screen.getByText('x')).toBeDefined()
  })
})
