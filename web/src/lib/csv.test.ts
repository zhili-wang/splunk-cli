import { describe, expect, it } from 'vitest'

import { csvFileName, toCsv } from './csv'

describe('toCsv', () => {
  it('writes a header even when there are no rows', () => {
    expect(toCsv([], ['_time', 'host'])).toBe('_time,host')
  })

  it('writes one line per row, in the column order it was given', () => {
    const rows = [{ host: 'api-01', _time: 'T0', level: 'ERROR' }]

    // The caller's order wins: the file has to match the table the operator sees.
    expect(toCsv(rows, ['_time', 'host', 'level'])).toBe('_time,host,level\r\nT0,api-01,ERROR')
  })

  it('quotes only the cells that need it', () => {
    const rows = [{ plain: 'ok', comma: 'a,b', quote: 'say "hi"', newline: 'a\nb' }]

    expect(toCsv(rows, ['plain', 'comma', 'quote', 'newline'])).toBe(
      'plain,comma,quote,newline\r\nok,"a,b","say ""hi""","a\nb"',
    )
  })

  it('renders missing values as empty cells, not as the string null', () => {
    expect(toCsv([{ a: null, b: undefined }], ['a', 'b'])).toBe('a,b\r\n,')
  })

  it('serializes nested values instead of flattening them into noise', () => {
    // Splunk results are flat in practice, but a stats row can carry a tuple key.
    expect(toCsv([{ key: ['a', 'b'] }], ['key'])).toBe('key\r\n"[""a"",""b""]"')
  })
})

describe('csvFileName', () => {
  it('stamps the file so two exports do not collide', () => {
    expect(csvFileName(new Date(2026, 8, 16, 14, 9, 5))).toBe('splunk-cli-20260916-140905.csv')
  })

  it('zero-pads every part of the stamp', () => {
    expect(csvFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe('splunk-cli-20260102-030405.csv')
  })
})
