// Startup prefetch of the signed-in panel. Without it, startup is a chain:
// session check → shell code → page code → page data. When this browser was
// signed in last time, main.ts starts the shell and the current page
// downloading while the language and the session load; App.svelte and
// AuthenticatedShell.svelte then reuse the same modules. Nothing renders
// early. A browser without that hint (a first visit, after signing out) keeps
// the plain order, so the login never pays for panel code (D54).
import { readText, remove, write } from '$lib/browser/local-storage'
import { loadPage, pageFor } from './pages'

const SIGNED_IN_KEY = 'nelcota.signedIn'

/** Was this browser signed in when the panel last checked? Only a hint: the session check decides. */
export function wasSignedIn(): boolean {
  return readText(SIGNED_IN_KEY, '') === '1'
}

/** Kept in step with the session: set once one is confirmed, cleared on sign-out or expiry. */
export function rememberSignedIn(signedIn: boolean) {
  if (signedIn) {
    write(SIGNED_IN_KEY, '1')
    return
  }
  remove(SIGNED_IN_KEY)
}

function warmUp(load: () => Promise<unknown>) {
  load().catch((error: unknown) => {
    // The real import repeats the request and shows the failure to the user.
    console.warn('Startup prefetch failed; the panel retries when it needs the module', error)
  })
}

/** Starts downloading the shell and the page at `routePath` without rendering them. */
export function prefetchSignedInPanel(routePath: string) {
  warmUp(() => import('$lib/shell/AuthenticatedShell.svelte'))
  const page = pageFor(routePath)
  if (page === null) return
  warmUp(() => loadPage(page.load))
}
