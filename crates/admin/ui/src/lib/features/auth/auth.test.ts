import { afterEach, expect, it, vi } from 'vitest'
import { api } from '$lib/transport/api'
import { profile } from '$lib/features/profile/profile.svelte'
import { clearQuerySession } from '$lib/resources/query-client'
import { logout } from './auth'
import { session } from '$lib/resources/session.svelte'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); clearQuerySession() })

it('does not clear a new session when a previous logout finishes late', async () => {
  session.email = 'old@example.com'
  let finish!: (value: unknown) => void
  vi.spyOn(api, 'post').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const pending = logout()
  clearQuerySession()
  session.email = 'new@example.com'
  session.expired = false
  profile.avatar = 42
  finish({ ok: true })
  await pending
  expect(session.email).toBe('new@example.com')
  expect(session.expired).toBe(false)
  expect(profile.avatar).toBe(42)
  expect(profile.loaded).toBe(true)
})

it('returns to the login screen when logout fails in the current session', async () => {
  session.email = 'old@example.com'
  session.expired = true
  profile.avatar = 42
  vi.spyOn(api, 'post').mockRejectedValue(new Error('network failed'))
  await logout()
  expect(session.email).toBeNull()
  expect(session.expired).toBe(false)
  expect(profile.avatar).toBeNull()
  expect(profile.loaded).toBe(false)
})
