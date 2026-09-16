/**
 * A minimal async-state hook.
 *
 * Server state here is fetched on demand, never cached across navigations —
 * Splunk data goes stale in seconds, so a cache would only make the dashboard
 * lie about the present.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError } from '../api/client'

export interface AsyncState<T> {
  data: T | null
  error: ApiError | null
  loading: boolean
  reload: () => void
}

export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const generation = useRef(0)

  useEffect(() => {
    const current = ++generation.current
    setLoading(true)

    load()
      .then((value) => {
        // A slower earlier request must never overwrite a newer result.
        if (current !== generation.current) return
        setData(value)
        setError(null)
      })
      .catch((caught: unknown) => {
        if (current !== generation.current) return
        setData(null)
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError('UnexpectedResponse', String(caught), 0),
        )
      })
      .finally(() => {
        if (current === generation.current) setLoading(false)
      })
    // load is intentionally excluded: callers pass an inline closure, and the
    // deps array is what decides when to refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const reload = useCallback(() => setNonce((value) => value + 1), [])

  return { data, error, loading, reload }
}
