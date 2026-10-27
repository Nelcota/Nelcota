// Session actions used in more than one place (sidebar, command palette).
import { api } from '$lib/transport/api'
import { profile } from '$lib/features/profile/profile.svelte'
import { querySession } from '$lib/resources/query-client'
import { session } from '$lib/resources/session.svelte'
import { sqlStore } from '$lib/features/sql/sql-store.svelte'

export async function logout() {
  // Even if the request fails, the panel returns to the login screen.
  const pending = api.post('/logout'), started = querySession()
  await pending.catch(() => {})
  // A newer sign-in keeps its session. A read that got 401 while logging out
  // also moves the epoch, but must not leave "your session expired" behind.
  if (started !== querySession() && session.email) return
  session.email = null
  session.expired = false
  sqlStore.forgetSession()
  profile.avatar = null
  profile.loaded = false
}
