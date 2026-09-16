// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { fetchAlerts, fetchHealth, fetchOverview, fetchVersion } from './api/endpoints'
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
})
