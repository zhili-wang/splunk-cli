/**
 * The theme switch.
 *
 * The label names the mode a click **gives you**, not the one you are in — a
 * button reading "夜间" while the screen is already dark is a guessing game.
 */

import { useLocale } from '../hooks/useLocale'
import { useTheme } from '../hooks/useTheme'
import type { MessageKey } from '../lib/i18n'
import type { Theme } from '../lib/theme'

/** The text lives in `src/locales`; the key is checked against the catalog. */
const LABEL: Readonly<Record<Theme, MessageKey>> = { dark: 'theme.dark', light: 'theme.light' }

export function ThemeToggle(): JSX.Element {
  const { next, toggle } = useTheme()
  const { t } = useLocale()
  const label = t('theme.switch', { mode: t(LABEL[next]) })

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className="rounded-md border border-ink-700 px-2.5 py-1.5 text-xs text-signal-muted transition-colors hover:border-ink-600 hover:text-[color:var(--text-primary)]"
    >
      <span aria-hidden="true">{next === 'light' ? '☀' : '☾'}</span> {t(LABEL[next])}
    </button>
  )
}
