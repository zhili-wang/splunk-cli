// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { downloadCsv } from './csv'

/** jsdom ships without blob URLs, so the tests put them there and take them away. */
const globals = URL as unknown as Record<string, unknown>
let created: ReturnType<typeof vi.fn>
let revoked: ReturnType<typeof vi.fn>

beforeEach(() => {
  created = vi.fn(() => 'blob:test')
  revoked = vi.fn()
  globals['createObjectURL'] = created
  globals['revokeObjectURL'] = revoked
})

afterEach(() => {
  delete globals['createObjectURL']
  delete globals['revokeObjectURL']
  vi.restoreAllMocks()
})

describe('downloadCsv', () => {
  it('clicks a download link for the blob and cleans both up', () => {
    const clicked: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this)
    })

    expect(downloadCsv('splunk-cli.csv', 'a,b')).toBe(true)

    expect(created).toHaveBeenCalledTimes(1)
    expect(revoked).toHaveBeenCalledWith('blob:test')
    expect(clicked).toHaveLength(1)
    expect(clicked[0]?.download).toBe('splunk-cli.csv')
    expect(clicked[0]?.href).toContain('blob:test')
    // The link must not be left behind in the document.
    expect(document.querySelectorAll('a[download]')).toHaveLength(0)
  })

  it('says nothing happened when the browser cannot make blob URLs', () => {
    // The caller can then avoid claiming a file was saved.
    // Shadow the global with `undefined` rather than deleting it: the host
    // (Node) does expose `URL.createObjectURL`, so deleting the own property
    // would fall through to an implementation that rejects a jsdom `Blob`.
    globals['createObjectURL'] = undefined

    expect(downloadCsv('splunk-cli.csv', 'a,b')).toBe(false)
    expect(revoked).not.toHaveBeenCalled()
  })
})
