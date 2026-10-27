import { describe, expect, it } from 'vitest'
import { pageAfterEmpty, parsePage } from './pagination'

describe('URL pagination', () => {
  it.each([null, '', 'NaN', 'Infinity', '-Infinity', '-1', '1.5', '1abc', '1e3', '0x10', '9'.repeat(400), '9007199254740992'])('rejects invalid page %s', value => {
    expect(parsePage(value)).toBe(0)
  })

  it.each([['0', 0], ['25', 25], ['0002', 2], ['9007199254740991', Number.MAX_SAFE_INTEGER]])('reads complete page %s', (value, expected) => {
    expect(parsePage(value)).toBe(expected)
  })
})

describe('pageAfterEmpty', () => {
  it('keeps the first page: an empty first page is an empty table', () => {
    expect(pageAfterEmpty(0, 50, 0, true)).toBeNull()
  })

  it('jumps to the last page when the total is exact', () => {
    expect(pageAfterEmpty(2, 50, 100, true)).toBe(1)
    // A stale link far past the end goes straight to the last page.
    expect(pageAfterEmpty(99, 50, 120, true)).toBe(2)
    expect(pageAfterEmpty(3, 50, 0, true)).toBe(0)
  })

  it('steps back one page when the total is estimated or unknown', () => {
    expect(pageAfterEmpty(3, 50, 1000, false)).toBe(2)
    expect(pageAfterEmpty(1, 50, null, false)).toBe(0)
  })
})
