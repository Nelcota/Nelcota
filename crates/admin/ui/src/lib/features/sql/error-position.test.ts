import { describe, expect, it } from 'vitest'
import { errorOffset } from './error-position'

describe('errorOffset', () => {
  it('matches the character position for plain text', () => {
    expect(errorOffset('selec 1', 1)).toBe(0)
    expect(errorOffset('select 1 frm x', 10)).toBe(9)
  })

  it('counts an emoji before the error as one character', () => {
    const code = '-- 🚀\nselec 1'
    // Postgres reports `selec` at character 6; the emoji takes two UTF-16
    // units, so it starts at unit 6, not 5 (which would be the newline).
    expect(errorOffset(code, 6)).toBe(6)
    expect(code.slice(errorOffset(code, 6) ?? 0)).toBe('selec 1')
  })

  it('accepts the position just past the end and refuses anything else', () => {
    expect(errorOffset('ab', 3)).toBe(2)
    expect(errorOffset('ab', 4)).toBeNull()
    expect(errorOffset('ab', 0)).toBeNull()
    expect(errorOffset('ab', 1.5)).toBeNull()
  })
})
