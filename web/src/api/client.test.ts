import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, getJson, postJson } from './client'

function mockFetch(status: number, body: unknown, contentType = 'application/json'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const text = typeof body === 'string' ? body : JSON.stringify(body)
      return new Response(text, { status, headers: { 'content-type': contentType } })
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('postJson', () => {
  it('sends a JSON body and parses the response', async () => {
    mockFetch(200, { success: true, count: 2 })

    const result = await postJson<{ count: number }>('/api/search', { query: 'index=app' })

    expect(result.count).toBe(2)
    const call = vi.mocked(fetch).mock.calls[0]
    expect(call?.[0]).toBe('/api/search')
    expect(call?.[1]?.method).toBe('POST')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ query: 'index=app' })
  })

  it('raises an ApiError carrying the backend error envelope', async () => {
    mockFetch(422, {
      success: false,
      error: { type: 'SafetyLimitError', message: 'range too wide' },
    })

    await expect(postJson('/api/search', {})).rejects.toMatchObject({
      name: 'ApiError',
      type: 'SafetyLimitError',
      message: 'range too wide',
      status: 422,
    })
  })

  it('raises for a non-JSON error response', async () => {
    // A proxy or a crashed server answers with HTML. The dashboard must say so
    // rather than throw a parse error at the user.
    mockFetch(502, '<html>bad gateway</html>', 'text/html')

    const error = await postJson('/api/search', {}).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(502)
  })

  it('treats an unparseable success body as an error', async () => {
    mockFetch(200, 'not json')

    await expect(postJson('/api/search', {})).rejects.toBeInstanceOf(ApiError)
  })

  it('carries the structured details of a backend error', async () => {
    mockFetch(422, {
      success: false,
      error: {
        type: 'SafetyLimitError',
        message: 'range too wide',
        details: { earliest: '-30d', max_time_range: '7d' },
      },
    })

    const error = await postJson('/api/search', {}).catch((caught: unknown) => caught)

    expect((error as ApiError).details).toEqual({ earliest: '-30d', max_time_range: '7d' })
  })

  it('falls back to the raw body when the error envelope is absent', async () => {
    // A 5xx from something other than the service: the body is JSON but has no
    // `error` key, so the dashboard shows what it got rather than inventing a
    // type name.
    mockFetch(500, { ok: false }, 'text/plain')

    const error = (await postJson('/api/search', {}).catch((caught: unknown) => caught)) as ApiError

    expect(error.type).toBe('UnexpectedResponse')
    expect(error.message).toBe('{"ok":false}')
  })

  it('describes an empty error body by status code alone', async () => {
    mockFetch(503, '', 'text/plain')

    const error = (await postJson('/api/search', {}).catch((caught: unknown) => caught)) as ApiError

    expect(error.message).toBe('服务器返回 HTTP 503')
    expect(error.status).toBe(503)
  })
})

describe('getJson', () => {
  it('issues a GET without a body', async () => {
    mockFetch(200, { success: true, count: 0 })

    const result = await getJson<{ count: number }>('/api/alerts?include_saved=false')

    expect(result.count).toBe(0)
    const call = vi.mocked(fetch).mock.calls[0]
    expect(call?.[0]).toBe('/api/alerts?include_saved=false')
    expect(call?.[1]?.method).toBe('GET')
    expect(call?.[1]?.body).toBeUndefined()
  })

  it('sends the JSON content type even when the caller passes no init', async () => {
    mockFetch(200, {})

    await getJson('/api/health')

    const init = vi.mocked(fetch).mock.calls[0]?.[1]
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json')
  })
})
