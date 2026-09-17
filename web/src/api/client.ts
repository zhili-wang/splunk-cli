/**
 * The one place the dashboard talks to the backend.
 *
 * Every request is same-origin: the page is served by the same FastAPI process
 * that answers /api, so there is no CORS negotiation and no credential to
 * attach. The browser never holds a Splunk password or session token.
 */

import { getLocale, translate } from '../lib/i18n'
import type { ErrorDetail } from '../types/api'

/** A failure the dashboard can render without guessing. */
export class ApiError extends Error {
  readonly type: string
  readonly status: number
  readonly details: Record<string, unknown> | undefined

  constructor(type: string, message: string, status: number, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.type = type
    this.status = status
    this.details = details
  }
}

interface Envelope {
  success?: boolean
  error?: ErrorDetail
}

function parseError(status: number, text: string): ApiError {
  try {
    const body = JSON.parse(text) as Envelope
    if (body.error !== undefined) {
      return new ApiError(
        body.error.type,
        body.error.message,
        status,
        body.error.details,
      )
    }
  } catch {
    // Not JSON: a proxy or a crashed server. Fall through to the generic case.
  }
  const trimmed = text.trim().slice(0, 300)
  return new ApiError(
    'UnexpectedResponse',
    trimmed === '' ? translate(getLocale(), 'api.httpError', { status }) : trimmed,
    status,
  )
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })

  const text = await response.text()

  if (!response.ok) {
    throw parseError(response.status, text)
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError(
      'UnexpectedResponse',
      translate(getLocale(), 'api.malformedJson'),
      response.status,
    )
  }
}

/** POST a JSON body and parse the JSON response. */
export function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

/** GET a path and parse the JSON response. */
export function getJson<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' })
}
