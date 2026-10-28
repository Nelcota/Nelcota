import { describe, expect, it } from 'vitest'
import { quoteIfNeeded } from './ident'

describe('SQL identifiers', () => {
  it('quotes only when needed', () => {
    expect(quoteIfNeeded('user_id')).toBe('user_id')
    expect(quoteIfNeeded('Owner')).toBe('"Owner"')
    expect(quoteIfNeeded('owner id')).toBe('"owner id"')
    // Reserved keywords are quoted: a bare `user` would mean current_user.
    expect(quoteIfNeeded('user')).toBe('"user"')
    expect(quoteIfNeeded('order')).toBe('"order"')
    expect(quoteIfNeeded('users')).toBe('users')
  })
})
