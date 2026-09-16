/**
 * The theme switch.
 *
 * The label names the mode a click **gives you**, not the one you are in — a
 * button reading "夜间" while the screen is already dark is a guessing game.
 */

import { useTheme } from '../hooks/useTheme'
import type { Theme } from '../lib/theme'

const LABEL: Readonly<Record<Theme, string>> = { dark: '夜间', light: '日间' }

export function ThemeToggle(): JSX.Element {
  const { next, toggle } = useTheme()
  const label = `切换到${LABEL[next]}模式`

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className="rounded-md border border-ink-700 px-2.5 py-1.5 text-xs text-signal-muted transition-colors hover:border-ink-600 hover:text-[color:var(--text-primary)]"
    >
      <span aria-hidden="true">{next === 'light' ? '☀' : '☾'}</span> {LABEL[next]}
    </button>
  )
}
