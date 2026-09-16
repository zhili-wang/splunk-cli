import { describe, expect, it } from 'vitest'

import { pageWindow, parsePageNumber } from './pagination'

describe('pageWindow', () => {
  it('offers the ends and the neighbours, with a gap where pages are skipped', () => {
    expect(pageWindow(5, 10)).toEqual([0, 'gap', 4, 5, 6, 'gap', 9])
  })

  it('does not put a gap next to an end', () => {
    expect(pageWindow(0, 10)).toEqual([0, 1, 'gap', 9])
    expect(pageWindow(9, 10)).toEqual([0, 'gap', 8, 9])
  })

  it('does not repeat a page that the window already reaches', () => {
    // `0` is pushed first; the loop must not push it again.
    expect(pageWindow(0, 3)).toEqual([0, 1, 2])
    expect(pageWindow(1, 3)).toEqual([0, 1, 2])
  })

  it('lists every page when they all fit', () => {
    expect(pageWindow(1, 4)).toEqual([0, 1, 2, 3])
  })

  it('handles a single page and an empty set', () => {
    expect(pageWindow(0, 1)).toEqual([0])
    expect(pageWindow(0, 0)).toEqual([])
  })

  it('widens with the span', () => {
    expect(pageWindow(10, 21, 2)).toEqual([0, 'gap', 8, 9, 10, 11, 12, 'gap', 20])
  })
})

describe('parsePageNumber', () => {
  it('converts a typed page number to a 0-based index', () => {
    expect(parsePageNumber('1', 10)).toBe(0)
    expect(parsePageNumber('100', 100)).toBe(99)
    expect(parsePageNumber('  7  ', 10)).toBe(6)
  })

  it('refuses anything out of range instead of clamping', () => {
    expect(parsePageNumber('0', 10)).toBeNull()
    expect(parsePageNumber('11', 10)).toBeNull()
    expect(parsePageNumber('-3', 10)).toBeNull()
  })

  it('refuses input that is not a page number', () => {
    expect(parsePageNumber('', 10)).toBeNull()
    expect(parsePageNumber('abc', 10)).toBeNull()
    expect(parsePageNumber('1.5', 10)).toBeNull()
    expect(parsePageNumber('1e2', 10)).toBeNull()
  })
})
