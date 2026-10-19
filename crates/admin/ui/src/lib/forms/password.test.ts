import { describe, expect, it } from 'vitest'
import { generatePassword, passwordProblem } from './password'

describe('generated password', () => {
  it('has the requested length and only unambiguous characters', () => {
    const password = generatePassword(64)
    expect(password).toHaveLength(64)
    expect(password).toMatch(/^[a-km-zA-HJ-NP-Z2-9_-]+$/)
  })

  it('discards bytes that would cause modulo bias', () => {
    // 59 symbols: bytes ≥ 236 (256 - 256 % 59) are discarded.
    const bytes = [250, 240, 236, 0, 58]
    const random = () => bytes.shift()!
    expect(generatePassword(2, random)).toBe('a_')
  })

  it('is uniform enough', () => {
    const counts = new Map<string, number>()
    for (const c of generatePassword(59 * 400)) counts.set(c, (counts.get(c) ?? 0) + 1)
    expect(counts.size).toBe(59)
    for (const n of counts.values()) expect(n).toBeGreaterThan(250)
  })
})

describe('length rule', () => {
  it('matches the server (counts characters, not bytes)', () => {
    expect(passwordProblem('1234567')).toBe('tooShort')
    expect(passwordProblem('çççççççç')).toBeNull()
    expect(passwordProblem('x'.repeat(257))).toBe('tooLong')
  })
})
