import { describe, expect, it } from 'vitest'
import { commandScore, normalizedScore, normalizeSearchText } from './search'

describe('palette search', () => {
  it('does not match scattered letters (the fuzzy search problem)', () => {
    expect(commandScore('page Our Data Records', 'orders')).toBe(0)
    expect(commandScore('table orders', 'orders')).toBeGreaterThan(0)
  })

  it('ignores accents and case', () => {
    expect(commandScore('page Visão geral', 'VISAO')).toBeGreaterThan(0)
    expect(commandScore('table cafe_orders', 'café')).toBeGreaterThan(0)
  })

  it('every term has to appear, in any order', () => {
    expect(commandScore('query orders by status', 'status orders')).toBeGreaterThan(0)
    expect(commandScore('query orders by status', 'status customers')).toBe(0)
  })

  it('start of a word ranks above the middle of a word', () => {
    const start = commandScore('table orders', 'ord')
    const middle = commandScore('table items_reorders', 'orders')
    expect(start).toBeGreaterThan(middle)
    expect(commandScore('table items_order', 'order')).toBe(1)
  })

  it('an empty search shows everything; keywords count too', () => {
    expect(commandScore('anything', '  ')).toBe(1)
    expect(commandScore('action sign out', 'logout', ['logout'])).toBeGreaterThan(0)
  })

  it('scores a cached normalized haystack like the raw text', () => {
    const haystack = normalizeSearchText('Caixa de Entrada e Configuração do E-mail')
    expect(haystack).toBe('caixa de entrada e configuracao do e-mail')
    for (const search of ['CONFIGURAÇÃO', 'entrada caixa', 'trada', 'senha', '  ']) {
      expect(normalizedScore(haystack, search)).toBe(commandScore('Caixa de Entrada e Configuração do E-mail', search))
    }
  })
})
