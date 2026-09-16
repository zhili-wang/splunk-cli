// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { resetTheme } from '../hooks/useTheme'
import { THEME_KEY } from '../lib/theme'
import { ThemeToggle } from './ThemeToggle'

beforeEach(() => {
  localStorage.clear()
  resetTheme()
  delete document.documentElement.dataset['theme']
})

afterEach(cleanup)

describe('ThemeToggle', () => {
  it('starts in dark mode, which is the default', () => {
    render(<ThemeToggle />)

    // The label names the mode a click gives you, not the one you are in.
    expect(screen.getByRole('button', { name: '切换到日间模式' })).toBeDefined()
  })

  it('switches to light, applies it to the document and remembers it', () => {
    render(<ThemeToggle />)

    fireEvent.click(screen.getByRole('button', { name: '切换到日间模式' }))

    expect(document.documentElement.dataset['theme']).toBe('light')
    expect(localStorage.getItem(THEME_KEY)).toBe('light')
    expect(screen.getByRole('button', { name: '切换到夜间模式' })).toBeDefined()
  })

  it('switches back to dark', () => {
    render(<ThemeToggle />)

    fireEvent.click(screen.getByRole('button', { name: '切换到日间模式' }))
    fireEvent.click(screen.getByRole('button', { name: '切换到夜间模式' }))

    expect(document.documentElement.dataset['theme']).toBe('dark')
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
  })

  it('comes back in the chosen mode after a remount', () => {
    render(<ThemeToggle />)
    fireEvent.click(screen.getByRole('button', { name: '切换到日间模式' }))

    cleanup()
    delete document.documentElement.dataset['theme']
    render(<ThemeToggle />)

    // The stored preference survived, and the attribute is re-applied on mount
    // even though nothing "changed".
    expect(document.documentElement.dataset['theme']).toBe('light')
    expect(screen.getByRole('button', { name: '切换到夜间模式' })).toBeDefined()
  })

  it('keeps every instance of the toggle in step', () => {
    render(
      <>
        <ThemeToggle />
        <ThemeToggle />
      </>,
    )

    fireEvent.click(screen.getAllByRole('button', { name: '切换到日间模式' })[0] as HTMLElement)

    expect(screen.getAllByRole('button', { name: '切换到夜间模式' })).toHaveLength(2)
  })
})
