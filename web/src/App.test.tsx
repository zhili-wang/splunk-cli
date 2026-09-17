// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { fetchAlerts, fetchHealth, fetchOverview, fetchVersion } from './api/endpoints'
import { LOCALE_KEY, resetLocale } from './lib/i18n'
import zhCN from './locales/zh-CN.json'
import App from './App'

vi.mock('./api/endpoints', () => ({
  fetchHealth: vi.fn(),
  fetchOverview: vi.fn(),
  fetchSearch: vi.fn(),
  fetchTimeline: vi.fn(),
  fetchAlerts: vi.fn(),
  fetchVersion: vi.fn(),
}))

beforeEach(() => {
  // The locale is module state, like the theme: a test that switches it would
  // otherwise decide what the next one renders.
  localStorage.clear()
  resetLocale()
  // Never-resolving probes keep the shell test focused on what App itself
  // renders; each page renders its own loading state.
  vi.mocked(fetchHealth).mockReturnValue(new Promise(() => {}))
  vi.mocked(fetchOverview).mockReturnValue(new Promise(() => {}))
  vi.mocked(fetchVersion).mockResolvedValue({ name: 'splunk-cli', version: '9.9.9' })
  vi.mocked(fetchAlerts).mockResolvedValue({
    success: true,
    source: 'splunk',
    count: 0,
    alerts: [],
    truncated: false,
  })
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  localStorage.clear()
  resetLocale()
  document.documentElement.lang = ''
  document.title = ''
})

function renderAt(path: string): void {
  render(
    <MemoryRouter
      initialEntries={[path]}
      // Opt in to the v7 behaviours now so the tests do not print deprecation
      // noise; the app itself still ships the v6 defaults.
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <App />
    </MemoryRouter>,
  )
}

/** Every dotted path in the Chinese catalog, which is the one keys derive from. */
function catalogKeys(node: unknown, prefix = '', out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(prefix)
    return out
  }
  if (typeof node !== 'object' || node === null) return out
  for (const [key, value] of Object.entries(node)) {
    catalogKeys(value, prefix === '' ? key : `${prefix}.${key}`, out)
  }
  return out
}

describe('App', () => {
  it('renders the shell: title, navigation, connection badge and footer', () => {
    renderAt('/')

    expect(screen.getByText('Splunk')).toBeDefined()
    expect(screen.getByText('日志面板')).toBeDefined()
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeDefined()
    expect(screen.getByRole('link', { name: '总览' })).toBeDefined()
    expect(screen.getByRole('link', { name: '查询' })).toBeDefined()
    expect(screen.getByRole('link', { name: '告警' })).toBeDefined()
    expect(screen.getByText(/只读。所有查询都通过与 CLI 相同的服务层执行。/)).toBeDefined()
    expect(screen.getByText('正在检查 Splunk…')).toBeDefined()
  })

  it('shows which build is running in the footer', async () => {
    renderAt('/')

    expect(await screen.findByText('splunk-cli v9.9.9')).toBeDefined()
  })

  it('keeps the footer statement when the version cannot be read', async () => {
    // The statement is the point of the footer; the version is a bonus. A
    // failed lookup must not blank the line or render a placeholder version.
    vi.mocked(fetchVersion).mockRejectedValue(new Error('offline'))

    renderAt('/')

    expect(
      await screen.findByText(/只读。所有查询都通过与 CLI 相同的服务层执行。/),
    ).toBeDefined()
    expect(screen.queryByText(/v9\.9\.9/)).toBeNull()
  })

  it('marks only the current route as active', () => {
    renderAt('/search')

    expect(screen.getByRole('link', { name: '查询' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: '总览' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByRole('link', { name: '告警' }).getAttribute('aria-current')).toBeNull()
  })

  it('renders the dashboard at the root route', () => {
    renderAt('/')

    // The query box starts empty, so the dashboard waits to be asked.
    expect(screen.getByText(/输入查询条件后开始/)).toBeDefined()
  })

  it('renders the search page', () => {
    renderAt('/search')

    expect(screen.getByText('执行查询以查看原始事件。')).toBeDefined()
  })

  it('renders the alerts page', async () => {
    renderAt('/alerts')

    expect(await screen.findByText('暂无告警触发。')).toBeDefined()
  })

  it('redirects an unknown route to the dashboard', () => {
    renderAt('/no-such-page')

    expect(screen.getByText(/输入查询条件后开始/)).toBeDefined()
  })

  it('never renders a message key verbatim', () => {
    // `translate` returns the key itself when a message is missing, so a key map
    // rendered without `t()` puts `theme.dark` on the button instead of 夜间.
    // That shipped once. Asserting the accessible name did not catch it, because
    // the name is built from a separate, correctly translated string.
    renderAt('/')

    const text = document.body.textContent ?? ''
    for (const key of catalogKeys(zhCN)) {
      expect(text, key).not.toContain(key)
    }
  })

  it('renders the whole shell in the language that was chosen', () => {
    // The end-to-end proof: the catalog, the store, the hook, the formatters and
    // every component that calls them have to agree for this to read as English.
    // Asserting the page body as well as the chrome, because the two are
    // translated by different layers.
    localStorage.setItem(LOCALE_KEY, 'en-US')
    resetLocale()

    renderAt('/')

    expect(screen.getByText('Log Dashboard')).toBeDefined()
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeDefined()
    expect(screen.getByRole('link', { name: 'Overview' })).toBeDefined()
    expect(screen.getByRole('link', { name: 'Search' })).toBeDefined()
    expect(screen.getByRole('link', { name: 'Alerts' })).toBeDefined()
    expect(screen.getByText(/Read-only\./)).toBeDefined()
    expect(screen.getByText('Checking Splunk…')).toBeDefined()
    expect(screen.getByText(/Enter a query to begin/)).toBeDefined()
    expect(document.documentElement.lang).toBe('en-US')
    expect(document.title).toBe('Splunk Log Dashboard')
  })

  it('switches the whole page from the header, chrome and body together', () => {
    renderAt('/')

    fireEvent.click(screen.getByRole('button', { name: '切换到 English' }))

    expect(screen.getByText('Log Dashboard')).toBeDefined()
    expect(screen.getByRole('link', { name: 'Overview' })).toBeDefined()
    expect(screen.getByText(/Read-only\./)).toBeDefined()
    expect(screen.getByText(/Enter a query to begin/)).toBeDefined()
    expect(screen.queryByText(/输入查询条件后开始/)).toBeNull()
  })
})
