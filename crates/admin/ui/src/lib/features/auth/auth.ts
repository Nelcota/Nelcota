// Session actions used in more than one place (sidebar, command palette).
import { api } from '$lib/transport/api'
import { profile } from '$lib/features/profile/profile.svelte'
import { querySession } from '$lib/resources/query-client'
import { session } from '$lib/resources/session.svelte'

export async function logout() {
  // Even if the request fails, the panel returns to the login screen.
  const pending = api.post('/logout'), started = querySession()
  await pending.catch(() => {})
  if (started !== querySession()) return
  session.email = null
  session.expired = false
  profile.avatar = null
  profile.loaded = false
}
