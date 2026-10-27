import { describe, expect, it } from 'vitest'
import { handoffDestination } from './projects'
import { ApiError } from '$lib/transport/api-error'

describe('handoffDestination', () => {
  it('follows a handoff on the project\'s own origin', () => {
    expect(handoffDestination('https://shop.example.com/admin/#sso=abc.def', 'https://shop.example.com')).toBe('https://shop.example.com/admin/#sso=abc.def')
  })

  it.each([
    'https://evil.example.net/admin/#sso=abc',
    'http://shop.example.com/admin/#sso=abc',
    'https://shop.example.com:8443/admin/#sso=abc',
    'javascript:alert(1)',
    'not a url',
  ])('refuses %s, which would carry the token elsewhere', url => {
    expect(() => handoffDestination(url, 'https://shop.example.com')).toThrow(ApiError)
  })
})
