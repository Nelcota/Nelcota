import { describe, expect, it, vi } from 'vitest'
import { dateText } from './date'

describe('date labels', () => {
  it.each([null, undefined, '', NaN, Infinity, -Infinity, Number.MAX_VALUE])('does not format a missing or invalid instant %s', value => {
    const format = vi.fn(() => 'unexpected')
    expect(dateText(value, format)).toBe('—')
    expect(format).not.toHaveBeenCalled()
  })

  it.each(['not-a-date', 'Infinity', '2026-99-99'])('preserves invalid text %s for inspection', value => {
    const format = vi.fn(() => 'unexpected')
    expect(dateText(value, format)).toBe(value)
    expect(format).not.toHaveBeenCalled()
  })

  it('formats valid ISO instants and epoch zero with the caller locale', () => {
    const formatter = new Intl.DateTimeFormat('en', { dateStyle: 'short', timeZone: 'UTC' })
    expect(dateText('2026-10-12T10:30:00Z', formatter.format)).toBe('10/12/26')
    expect(dateText(0, formatter.format)).toBe('1/1/70')
  })
})
