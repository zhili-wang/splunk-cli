/**
 * The language switch.
 *
 * The label names the language a click **gives you**, not the one you are in —
 * the same rule as the theme switch, and for the same reason: a button reading
 * "中文" while the page is already Chinese is a guessing game.
 *
 * Each language is named in its own script, so the one you need is readable
 * without already being able to read the one you have. That name is the whole
 * label: the globe says which kind of control this is, and nothing more. An
 * earlier pass drew a character from the target's own alphabet (「文」 for
 * Chinese, 「A」 for English) in imitation of the theme switch — but that is a
 * puzzle rather than a clue, and it repeats the word beside it.
 */

import { useLocale } from '../hooks/useLocale'
import type { Locale, MessageKey } from '../lib/i18n'

/** How each language names itself. Identical in both catalogs, by design. */
const NAME: Readonly<Record<Locale, MessageKey>> = {
  'zh-CN': 'locale.name.zh',
  'en-US': 'locale.name.en',
}

/**
 * The globe, drawn rather than typed.
 *
 * A `🌐` emoji paints itself in its own colours and ignores `color`, so it could
 * not be white on the dark theme and black on the light one. An inline SVG
 * strokes with `currentColor` and follows the button's text colour, exactly like
 * the `☀` / `☾` beside it.
 */
function GlobeIcon(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      className="inline-block h-3 w-3 align-[-0.125em]"
    >
      <circle cx="8" cy="8" r="6.25" />
      <ellipse cx="8" cy="8" rx="2.75" ry="6.25" />
      <path d="M1.75 8h12.5" />
    </svg>
  )
}

export function LocaleToggle(): JSX.Element {
  const { next, toggle, t } = useLocale()
  const name = t(NAME[next])
  const label = t('locale.switch', { name })

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className="rounded-md border border-ink-700 px-2.5 py-1.5 text-xs text-signal-muted transition-colors hover:border-ink-600 hover:text-[color:var(--text-primary)]"
    >
      <GlobeIcon /> {name}
    </button>
  )
}
