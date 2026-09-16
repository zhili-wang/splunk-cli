import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  fetchAlerts,
  fetchHealth,
  fetchOverview,
  fetchSearch,
  fetchStats,
  fetchTimeline,
  fetchVersion,
} from './endpoints'

function mockFetch(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  )
}

/** The path and init of the single request a test made. */
function lastCall(): [string, RequestInit | undefined] {
  const call = vi.mocked(fetch).mock.calls.at(-1)
  return [String(call?.[0]), call?.[1]]
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchHealth', () => {
  it('does not ask the backend to probe the license pools', async () => {
    // The badge polls this every 30s. `/api/health` defaults to
    // include_license=true, which costs a second backend call and lets a
    // license-only failure surface as a failed health probe -- making a
    // reachable Splunk read as offline. No component renders `license`, so the
    // poll must opt out explicitly rather than rely on the API default.
    mockFetch({ connection: 'ok', authentication: 'ok' })

    await fetchHealth()

    expect(lastCall()[0]).toBe('/api/health?include_license=false')
  })
})

describe('POST endpoints', () => {
  it('posts the overview arguments verbatim, including a custom span', async () => {
    mockFetch({ success: true, partial: false })

    await fetchOverview({ query: 'index=app', earliest: '-6h', latest: 'now', span: '15m' })

    const [path, init] = lastCall()
    expect(path).toBe('/api/overview')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      query: 'index=app',
      earliest: '-6h',
      latest: 'now',
      span: '15m',
    })
  })

  it('posts a search request and returns the parsed body', async () => {
    mockFetch({ success: true, count: 1, truncated: false, results: [{ host: 'api-01' }] })

    const result = await fetchSearch({ query: 'index=app', earliest: '-1h', latest: 'now', limit: 50 })

    expect(result.results).toEqual([{ host: 'api-01' }])
    const [path, init] = lastCall()
    expect(path).toBe('/api/search')
    expect(JSON.parse(String(init?.body))).toEqual({
      query: 'index=app',
      earliest: '-1h',
      latest: 'now',
      limit: 50,
    })
  })

  it('posts a stats request with its grouping arguments', async () => {
    mockFetch({ success: true, rows: [] })

    await fetchStats({ query: 'index=app', by: 'service', function: 'count', limit: 10 })

    const [path, init] = lastCall()
    expect(path).toBe('/api/stats')
    expect(JSON.parse(String(init?.body))).toEqual({
      query: 'index=app',
      by: 'service',
      function: 'count',
      limit: 10,
    })
  })

  it('posts a timeline request with its span', async () => {
    mockFetch({ success: true, timeline: [] })

    await fetchTimeline({ query: 'index=app', earliest: '-1h', latest: 'now', span: '5m' })

    const [path, init] = lastCall()
    expect(path).toBe('/api/timeline')
    expect(JSON.parse(String(init?.body))).toEqual({
      query: 'index=app',
      earliest: '-1h',
      latest: 'now',
      span: '5m',
    })
  })
})

describe('fetchAlerts', () => {
  it('defaults to fired alerts only', async () => {
    // Saved searches are a second, permission-gated read. The dashboard never
    // renders them, so the default must not request them.
    mockFetch({ success: true, alerts: [] })

    await fetchAlerts()

    const [path, init] = lastCall()
    expect(path).toBe('/api/alerts?include_saved=false')
    expect(init?.method).toBe('GET')
  })

  it('sends the serialized boolean Splunk expects when asked for saved searches', async () => {
    mockFetch({ success: true, alerts: [] })

    await fetchAlerts(true)

    expect(lastCall()[0]).toBe('/api/alerts?include_saved=true')
  })
})

describe('fetchVersion', () => {
  it('reads the local build identity in one GET', async () => {
    mockFetch({ name: 'splunk-cli', version: '1.2.3' })

    await expect(fetchVersion()).resolves.toEqual({ name: 'splunk-cli', version: '1.2.3' })

    const [path, init] = lastCall()
    expect(path).toBe('/api/version')
    expect(init?.method ?? 'GET').toBe('GET')
  })
})
