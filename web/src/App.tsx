import { NavLink } from 'react-router-dom'

import { fetchVersion } from './api/endpoints'
import { ConnectionStatus } from './components/ConnectionStatus'
import { KeepAliveRoutes } from './components/KeepAliveRoutes'
import { LocaleToggle } from './components/LocaleToggle'
import { ThemeToggle } from './components/ThemeToggle'
import { useAsync } from './hooks/useAsync'
import { useLocale } from './hooks/useLocale'
import type { MessageKey } from './lib/i18n'
import { Alerts } from './pages/Alerts'
import { Dashboard } from './pages/Dashboard'
import { Search } from './pages/Search'

interface NavItem {
  readonly to: string
  /** The text lives in `src/locales`; the key is checked against the catalog. */
  readonly labelKey: MessageKey
  readonly element: JSX.Element
}

/**
 * Navigation and tabs in one list on purpose: two parallel arrays is exactly how
 * a nav link and its route drift apart.
 */
const NAV = [
  { to: '/', labelKey: 'app.nav.overview', element: <Dashboard /> },
  { to: '/search', labelKey: 'app.nav.search', element: <Search /> },
  { to: '/alerts', labelKey: 'app.nav.alerts', element: <Alerts /> },
] as const satisfies readonly NavItem[]

export default function App(): JSX.Element {
  const { t } = useLocale()
  // Asked once: the process serves one build for its whole lifetime.
  const version = useAsync(fetchVersion, [])

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 border-b border-ink-800 bg-ink-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-6 px-6 py-3">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold tracking-tight">Splunk</span>
            <span className="text-base font-light text-signal-muted">{t('app.title')}</span>
          </div>

          <nav className="flex items-center gap-1 text-sm" aria-label={t('app.nav.label')}>
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  [
                    'rounded-md px-3 py-1.5 transition-colors',
                    isActive
                      ? 'bg-ink-800 text-[color:var(--text-primary)]'
                      : 'text-signal-muted hover:bg-ink-850 hover:text-[color:var(--text-primary)]',
                  ].join(' ')
                }
              >
                {t(item.labelKey)}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <ConnectionStatus />
            <LocaleToggle />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1400px] flex-1 px-6 py-6">
        <KeepAliveRoutes tabs={NAV.map((item) => ({ path: item.to, element: item.element }))} />
      </main>

      {/* Pinned to the bottom the way the header is pinned to the top: it is a
          standing statement about the tool, not the last line of its output. */}
      <footer className="sticky bottom-0 z-10 border-t border-ink-800 bg-ink-950/90 px-6 py-3 text-xs text-signal-muted backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-3">
          <span>{t('app.footer.readonly')}</span>
          {/* Which build is running: the first thing a bug report needs, and the
              one fact that cannot be read off the page anywhere else. Absent
              rather than wrong when the call fails. */}
          {version.data !== null ? (
            <span className="tnum ml-auto" title={t('app.footer.version')}>
              {version.data.name} v{version.data.version}
            </span>
          ) : null}
        </div>
      </footer>
    </div>
  )
}
