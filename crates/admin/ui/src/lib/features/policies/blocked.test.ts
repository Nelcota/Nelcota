import { describe, expect, it } from 'vitest'
import { blockReason, blockTarget } from './blocked'
import type { DeniedRequest } from '$lib/contracts/types'

const request = (patch: Partial<DeniedRequest>): DeniedRequest => ({
  at: '2026-10-09T12:00:00Z',
  method: 'GET',
  path: '/rest/v1/todos',
  status: 401,
  code: 'db_error',
  message: 'permission denied for table todos (42501)',
  role: 'anon',
  user_id: null,
  email: null,
  ...patch,
})

describe('why a request was refused', () => {
  it('a role without GRANT, per role', () => {
    expect(blockReason(request({}))).toBe('grantAnon')
    expect(blockReason(request({ role: 'authenticated', status: 403 }))).toBe('grantUser')
  })

  it('a write that a policy refused', () => {
    const message = 'new row violates row-level security policy for table "todos" (42501)'
    expect(blockReason(request({ role: 'authenticated', status: 403, message }))).toBe('rls')
  })

  it('a file refused by the bucket rules', () => {
    const message = 'new row violates row-level security policy for table "objects" (42501)'
    expect(blockReason(request({ path: '/storage/v1/object/docs/a.txt', method: 'POST', message }))).toBe('files')
  })

  it('a bad token and too many attempts', () => {
    expect(blockReason(request({ role: 'invalid_token', code: 'invalid_token', message: 'invalid or expired token' }))).toBe('token')
    expect(blockReason(request({ status: 429, code: 'rate_limited', message: 'too many attempts' }))).toBe('rateLimited')
    expect(blockReason(request({ status: 403, code: 'forbidden', message: 'nope' }))).toBe('other')
  })

  it('names the table, function or bucket', () => {
    expect(blockTarget('/rest/v1/todos')).toEqual({ kind: 'table', name: 'todos' })
    expect(blockTarget('/rest/v1/rpc/cart_total')).toEqual({ kind: 'function', name: 'cart_total' })
    expect(blockTarget('/rest/v1/order%20items')).toEqual({ kind: 'table', name: 'order items' })
    expect(blockTarget('/storage/v1/object/avatars/u1/me.png')).toEqual({ kind: 'bucket', name: 'avatars' })
    expect(blockTarget('/storage/v1/object/sign/docs/a.pdf')).toEqual({ kind: 'bucket', name: 'docs' })
    expect(blockTarget('/auth/v1/user')).toBeNull()
  })
})
