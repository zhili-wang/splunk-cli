/**
 * Every colour is a CSS variable, so one class name serves both themes.
 *
 * The alternative — `dark:` variants on every element — would have meant
 * touching every component twice and keeping the two lists in step. Here the
 * palette is declared once in `src/styles/index.css`, dark under `:root` and
 * light under `[data-theme='light']`, and the utility classes never change.
 */
const varColor = (name) => `rgb(var(${name}) / <alpha-value>)`

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // A terminal-adjacent palette: the dashboard is a log tool, and the
        // surfaces should read like one rather than like a generic admin panel.
        ink: {
          950: varColor('--ink-950'),
          900: varColor('--ink-900'),
          850: varColor('--ink-850'),
          800: varColor('--ink-800'),
          700: varColor('--ink-700'),
          600: varColor('--ink-600'),
        },
        signal: {
          ok: varColor('--signal-ok'),
          warn: varColor('--signal-warn'),
          bad: varColor('--signal-bad'),
          info: varColor('--signal-info'),
          muted: varColor('--signal-muted'),
        },
        accent: {
          DEFAULT: varColor('--accent'),
          soft: varColor('--accent-soft'),
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      boxShadow: {
        // Theme-dependent: a near-black glow reads as dirt on a light panel.
        panel: 'var(--panel-shadow)',
      },
    },
  },
  plugins: [],
}
