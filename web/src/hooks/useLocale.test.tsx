// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { LOCALE_KEY, resetLocale } from '../lib/i18n'
import { useLocale } from './useLocale'

beforeEach(() => {
  localStorage.clear()
  resetLocale()
  document.documentElement.lang = ''
  document.title = ''
})

afterEach(cleanup)

/** Renders everything the hook exposes, so one render covers all of it. */
function Probe(): JSX.Element {
  const { locale, next, setLocale, toggle, t } = useLocale()
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="next">{next}</span>
      <span data-testid="title">{t('app.title')}</span>
      <span data-testid="events">{t('job.events', { count: 1, value: '1' })}</span>
      <span data-testid="nav">{t('app.nav.overview')}</span>
      <button type="button" onClick={toggle}>
        toggle
      </button>
      <button type="button" onClick={() => setLocale('en-US')}>
        set-en
      </button>
      <button type="button" onClick={() => setLocale('zh-CN')}>
        set-zh
      </button>
    </div>
  )
}

describe('useLocale', () => {
  it('starts in Chinese, which is the default', () => {
    render(<Probe />)

    expect(screen.getByTestId('locale').textContent).toBe('zh-CN')
    expect(screen.getByTestId('title').textContent).toBe('日志面板')
  })

  it('translates through the active locale', () => {
    render(<Probe />)

    expect(screen.getByTestId('nav').textContent).toBe('总览')
    expect(screen.getByTestId('events').textContent).toBe('1 个事件')
  })

  it('names the language a toggle gives you, not the one you are in', () => {
    render(<Probe />)

    expect(screen.getByTestId('next').textContent).toBe('en-US')
  })

  it('switches language, applying it to the document and remembering it', () => {
    render(<Probe />)

    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))

    expect(screen.getByTestId('locale').textContent).toBe('en-US')
    expect(screen.getByTestId('title').textContent).toBe('Log Dashboard')
    expect(screen.getByTestId('nav').textContent).toBe('Overview')
    expect(screen.getByTestId('events').textContent).toBe('1 event')
    expect(document.documentElement.lang).toBe('en-US')
    expect(document.title).toBe('Splunk Log Dashboard')
    expect(localStorage.getItem(LOCALE_KEY)).toBe('en-US')
  })

  it('switches back to Chinese', () => {
    render(<Probe />)

    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))

    expect(screen.getByTestId('locale').textContent).toBe('zh-CN')
    expect(screen.getByTestId('next').textContent).toBe('en-US')
    expect(localStorage.getItem(LOCALE_KEY)).toBe('zh-CN')
  })

  it('applies the language on first mount, not only on change', () => {
    // The attribute has to be right for a page that was merely reopened, where
    // nothing "changed" during this session.
    localStorage.setItem(LOCALE_KEY, 'en-US')
    resetLocale()

    render(<Probe />)

    expect(document.documentElement.lang).toBe('en-US')
    expect(document.title).toBe('Splunk Log Dashboard')
  })

  it('comes back in the chosen language after a remount', () => {
    render(<Probe />)
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))

    cleanup()
    document.documentElement.lang = ''
    document.title = ''
    render(<Probe />)

    expect(screen.getByTestId('locale').textContent).toBe('en-US')
    expect(document.documentElement.lang).toBe('en-US')
  })

  it('sets a language directly, not only by cycling', () => {
    // What a picker with more than two entries would use: name the language
    // rather than stepping through the list to reach it.
    render(<Probe />)

    fireEvent.click(screen.getByRole('button', { name: 'set-en' }))
    expect(screen.getByTestId('locale').textContent).toBe('en-US')
    expect(screen.getByTestId('title').textContent).toBe('Log Dashboard')
    expect(localStorage.getItem(LOCALE_KEY)).toBe('en-US')

    fireEvent.click(screen.getByRole('button', { name: 'set-zh' }))
    expect(screen.getByTestId('locale').textContent).toBe('zh-CN')
    expect(localStorage.getItem(LOCALE_KEY)).toBe('zh-CN')
  })

  it('keeps every consumer in step', () => {
    // The tabs are mounted side by side; two copies of "which language is on"
    // would eventually disagree.
    render(
      <>
        <Probe />
        <Probe />
      </>,
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'toggle' })[0] as HTMLElement)

    expect(screen.getAllByTestId('locale').map((node) => node.textContent)).toEqual([
      'en-US',
      'en-US',
    ])
  })
})
