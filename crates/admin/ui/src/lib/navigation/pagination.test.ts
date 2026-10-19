import { describe, expect, it } from 'vitest'
import { parsePage } from './pagination'

describe('URL pagination', () => {
  it.each([null, '', 'NaN', 'Infinity', '-Infinity', '-1', '1.5', '1abc', '1e3', '0x10', '9'.repeat(400), '9007199254740992'])('rejects invalid page %s', value => {
    expect(parsePage(value)).toBe(0)
  })

  it.each([['0', 0], ['25', 25], ['0002', 2], ['9007199254740991', Number.MAX_SAFE_INTEGER]])('reads complete page %s', (value, expected) => {
    expect(parsePage(value)).toBe(expected)
  })
})
