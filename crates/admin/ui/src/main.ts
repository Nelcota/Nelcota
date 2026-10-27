import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { i18n, loadLocale } from '$lib/i18n/index.svelte'
import { route } from '$lib/navigation/router.svelte'
import { prefetchSignedInPanel, wasSignedIn } from '$lib/shell/prefetch'
import { CATALOG_RETRY_DELAYS_MS, planStartup, retry } from '$lib/shell/startup'
import { takeHandoffToken } from '$lib/features/projects/projects'
import { api } from '$lib/transport/api'

// Startup runs its network work side by side: the language, the session check
// and, for a browser that was signed in, the panel's code.
// Not a top-level await: lazy chunks import shared code from the entry, and
// the bundler splits that code out of an entry that awaits at the top level.
async function start() {
  const controller = document.querySelector('meta[name=nelcota-updates-controller]')?.getAttribute('content') === '1'
  const handoffToken = controller ? null : takeHandoffToken()
  const plan = planStartup({ controller, handoffToken, signedInBefore: wasSignedIn() })
  const sessionCheck = plan.checkSession ? startSessionCheck() : null
  if (plan.prefetchPanel) prefetchSignedInPanel(route.path)
  // Every text goes through `t()`, which reads the loaded catalog synchronously.
  try {
    await retry(() => loadLocale(i18n.locale), CATALOG_RETRY_DELAYS_MS)
  } catch (error) {
    console.error(`Could not download the ${i18n.locale} texts`, error)
    showStartupFailure()
    return
  }
  const target = document.getElementById('app')
  if (target === null) throw new Error('Missing #app element in index.html')
  mount(App, { target, props: { controller, handoffToken, sessionCheck } })
}

function startSessionCheck() {
  const check = api.get<{ email: string }>('/session')
  // Marks an early failure as handled: App.svelte awaits this same promise
  // once mounted and shows the login or the offline screen.
  check.catch(() => undefined)
  return check
}

/** index.html's bilingual fallback: without texts the panel cannot render. */
function showStartupFailure() {
  const failure = document.getElementById('startup-failure')
  if (failure === null) throw new Error('Missing #startup-failure element in index.html')
  failure.hidden = false
  document.getElementById('startup-retry')?.addEventListener('click', () => window.location.reload())
}

start().catch((error: unknown) => {
  console.error('The panel failed to start', error)
})
