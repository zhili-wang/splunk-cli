// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { LOCALE_KEY, resetLocale } from '../lib/i18n'
import { LocaleToggle } from './LocaleToggle'

beforeEach(() => {
  localStorage.clear()
  resetLocale()
  document.documentElement.lang = ''
  document.title = ''
})

afterEach(cleanup)

describe('LocaleToggle', () => {
  it('offers English, because Chinese is what the visitor already has', () => {
    render(<LocaleToggle />)

    // The label names the language a click gives you, not the one you are in.
    expect(screen.getByRole('button', { name: '切换到 English' })).toBeDefined()
  })

  it('names the language in its own language, so it is readable either way round', () => {
    render(<LocaleToggle />)

    expect(screen.getByRole('button', { name: '切换到 English' }).textContent).toContain('English')
  })

  it('switches to English, applying it to the document and remembering it', () => {
    render(<LocaleToggle />)

    fireEvent.click(screen.getByRole('button', { name: '切换到 English' }))

    expect(document.documentElement.lang).toBe('en-US')
    expect(document.title).toBe('Splunk Log Dashboard')
    expect(localStorage.getItem(LOCALE_KEY)).toBe('en-US')
    expect(screen.getByRole('button', { name: 'Switch to 中文' })).toBeDefined()
  })

  it('switches back to Chinese, and offers English again', () => {
    render(<LocaleToggle />)

    fireEvent.click(screen.getByRole('button', { name: '切换到 English' }))
    fireEvent.click(screen.getByRole('button', { name: 'Switch to 中文' }))

    expect(document.documentElement.lang).toBe('zh-CN')
    expect(localStorage.getItem(LOCALE_KEY)).toBe('zh-CN')
    expect(screen.getByRole('button', { name: '切换到 English' })).toBeDefined()
  })

  it('shows the target language, not the current one', () => {
    // A button reading "中文" while the page is already Chinese is a guessing game.
    render(<LocaleToggle />)
    expect(screen.getByRole('button', { name: '切换到 English' }).textContent).toContain('English')

    fireEvent.click(screen.getByRole('button', { name: '切换到 English' }))

    expect(screen.getByRole('button', { name: 'Switch to 中文' }).textContent).toContain('中文')
  })

  it('comes back offering the same language after a remount', () => {
    render(<LocaleToggle />)
    fireEvent.click(screen.getByRole('button', { name: '切换到 English' }))

    cleanup()
    document.documentElement.lang = ''
    document.title = ''
    render(<LocaleToggle />)

    expect(screen.getByRole('button', { name: 'Switch to 中文' })).toBeDefined()
  })
})
