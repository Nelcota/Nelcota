import { describe, expect, it } from 'vitest'
import { match } from './route-match'

describe('route parameters', () => {
  it.each(['%', '%ff', '%E0%A4', '%ED%A0%80'])('rejects malformed encoding %s without breaking navigation', parameter => {
    expect(match('/storage/:bucket', `/storage/${parameter}`)).toBeNull()
  })

  it('decodes valid Unicode and treats encoded separators as part of one parameter', () => {
    expect(match('/tables/:name', '/tables/a%C3%A7%C3%A3o')).toEqual({ name: 'ação' })
    expect(match('/tables/:name', '/tables/a%2Fb')).toEqual({ name: 'a/b' })
    expect(match('/tables/:name', '/users/a')).toBeNull()
    expect(match('/tables/:name', '/tables/a/b')).toBeNull()
  })
})
