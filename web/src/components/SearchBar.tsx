import { type FormEvent } from 'react'

import { useLocale } from '../hooks/useLocale'

interface Props {
  query: string
  onQuery: (query: string) => void
  onSubmit: () => void
  loading: boolean
}

export function SearchBar({ query, onQuery, onSubmit, loading }: Props): JSX.Element {
  const { t } = useLocale()

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    onSubmit()
  }

  return (
    <form onSubmit={submit} className="flex items-stretch gap-2">
      <input
        aria-label={t('query.label')}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        placeholder="index=app level=ERROR"
        spellCheck={false}
        className="tnum flex-1 rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-sm outline-none transition-colors focus:border-accent"
      />
      <button
        type="submit"
        disabled={loading || query.trim() === ''}
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
      >
        {loading ? t('query.submitting') : t('query.submit')}
      </button>
    </form>
  )
}
