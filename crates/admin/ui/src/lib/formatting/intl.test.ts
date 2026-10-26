import { describe, expect, it } from 'vitest'
import { dateTimeFormat, numberFormat, pluralRules } from './intl'

describe('cached Intl formatters', () => {
  it('reuses one formatter for the same locale and options', () => {
    expect(dateTimeFormat('en', { dateStyle: 'short' })).toBe(dateTimeFormat('en', { dateStyle: 'short' }))
    expect(numberFormat('pt-BR')).toBe(numberFormat('pt-BR'))
    expect(pluralRules('en')).toBe(pluralRules('en'))
  })

  it('keeps different locales apart', () => {
    expect(numberFormat('en').format(1234.5)).toBe('1,234.5')
    expect(numberFormat('pt-BR').format(1234.5)).toBe('1.234,5')
    expect(numberFormat('en')).not.toBe(numberFormat('pt-BR'))
  })

  it('keeps different options apart', () => {
    const instant = new Date(Date.UTC(2026, 9, 6, 22, 26, 15))
    const dateOnly = dateTimeFormat('en', { dateStyle: 'short', timeZone: 'UTC' })
    const withTime = dateTimeFormat('en', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'UTC' })
    expect(dateOnly.format(instant)).toBe('10/6/26')
    expect(withTime.format(instant)).toBe('10/6/26, 10:26:15 PM')
    expect(dateTimeFormat('en', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' })).not.toBe(dateOnly)
    expect(numberFormat('en', { maximumFractionDigits: 0 }).format(1.6)).toBe('2')
    expect(numberFormat('en').format(1.6)).toBe('1.6')
  })

  it('does not mix formatter kinds that share a locale and options', () => {
    expect(dateTimeFormat('en')).toBeInstanceOf(Intl.DateTimeFormat)
    expect(numberFormat('en')).toBeInstanceOf(Intl.NumberFormat)
    expect(pluralRules('en')).toBeInstanceOf(Intl.PluralRules)
  })

  it('treats an undefined option like an absent one, as Intl does', () => {
    expect(dateTimeFormat('en', { timeZone: undefined })).toBe(dateTimeFormat('en'))
  })

  it('stays bounded when callers pass many distinct options', () => {
    const first = numberFormat('en', { minimumIntegerDigits: 1 })
    for (const locale of ['en', 'pt-BR', 'de', 'fr', 'es']) {
      for (let digits = 0; digits <= 20; digits++) numberFormat(locale, { maximumFractionDigits: digits })
    }
    const again = numberFormat('en', { minimumIntegerDigits: 1 })
    expect(again).not.toBe(first)
    expect(again.format(5)).toBe('5')
  })
})
