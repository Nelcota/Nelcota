// Minimal SPA router based at /admin (history API).
const BASE = '/admin'

function current(): string {
  const path = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : '/'
  return path === '' ? '/' : path
}

export const route = $state({ path: current(), query: new URLSearchParams(location.search), revision: 0 })

interface NavigationGuard {
  blocked: () => boolean
  request: (proceed: () => void) => void
}
const guards = new Set<NavigationGuard>()

export function beforeNavigate(guard: NavigationGuard): () => void {
  guards.add(guard)
  return () => { guards.delete(guard) }
}

function requestNavigation(action: () => void, accepted = new Set<NavigationGuard>()) {
  for (const guard of guards) {
    if (accepted.has(guard) || !guard.blocked()) continue
    guard.request(() => requestNavigation(action, new Set([...accepted, guard])))
    return
  }
  action()
}

// Tag our entries so cancelling Back/Forward restores the original entry,
// rather than pushing duplicates or destroying the forward history.
const INDEX = 'nelcotaNavigationIndex'
function entryIndex(): number | null {
  const state: unknown = history.state
  if (!state || typeof state !== 'object' || !(INDEX in state)) return null
  const value = state[INDEX]
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}
function entryState(index: number) {
  const state: unknown = history.state
  return { ...(state && typeof state === 'object' ? state : {}), [INDEX]: index }
}
let index = entryIndex() ?? 0
history.replaceState(entryState(index), '')
let savedUrl = location.href
let savedState: unknown = history.state
let restoring: { delta: number; targetIndex: number; targetUrl: string } | null = null
let approvedPop: { index: number; url: string } | null = null

export function navigate(to: string, replace = false) {
  const url = BASE + (to.startsWith('/') ? to : `/${to}`)
  requestNavigation(() => {
    // SSO can replace the initial entry's state before the first navigation.
    if (entryIndex() === null) history.replaceState(entryState(index), '')
    if (!replace) index++
    history[replace ? 'replaceState' : 'pushState'](entryState(index), '', url)
    sync()
  })
}

function sync() {
  // Returning to the same URL creates a new navigation context as well.
  route.revision++
  route.path = current()
  route.query = new URLSearchParams(location.search)
  savedUrl = location.href
  savedState = history.state
}

addEventListener('popstate', () => {
  const targetIndex = entryIndex()
  if (restoring) {
    // Native hash entries copy history.state without increasing our index.
    // Traverse those too, counting actual steps back to the current draft.
    if (targetIndex !== index || location.href !== savedUrl) {
      const step = Math.sign(restoring.delta)
      restoring.delta += step
      history.go(-step)
      return
    }
    const { delta, targetIndex: destination, targetUrl } = restoring
    restoring = null
    requestNavigation(() => { approvedPop = { index: destination, url: targetUrl }; history.go(delta) })
    return
  }
  if (targetIndex !== null && approvedPop?.index === targetIndex && approvedPop.url === location.href) {
    approvedPop = null
    index = targetIndex
    sync()
    return
  }
  approvedPop = null
  if (![...guards].some(guard => guard.blocked())) {
    index = targetIndex ?? index
    sync()
    return
  }
  if (targetIndex !== null && targetIndex !== index) {
    restoring = { delta: targetIndex - index, targetIndex, targetUrl: location.href }
    history.go(index - targetIndex)
    return
  }
  // An untagged/hash entry cannot be traversed by index. Keep the current
  // URL/draft until confirmation, then create a tagged navigation context.
  const targetUrl = location.href
  history.replaceState(savedState, '', savedUrl)
  requestNavigation(() => {
    index++
    history.pushState(entryState(index), '', targetUrl)
    sync()
  })
})

addEventListener('beforeunload', event => {
  if (![...guards].some(guard => guard.blocked())) return
  event.preventDefault()
})

// Internal links (<a href="/admin/...">) navigate without reloading the page.
addEventListener('click', (event) => {
  const anchor = (event.target as HTMLElement).closest('a')
  if (
    !anchor ||
    anchor.target ||
    anchor.getAttribute('href')?.startsWith('#') ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.shiftKey
  )
    return
  const url = new URL(anchor.href, location.href)
  if (url.origin !== location.origin || !url.pathname.startsWith(BASE + '/')) return
  if (url.pathname.startsWith(BASE + '/api')) return
  event.preventDefault()
  navigate(url.pathname.slice(BASE.length) + url.search)
})

// Route matching is pure (testable outside the browser): it lives in route-match.
export { match } from './route-match'

export const href = (path: string) => BASE + path
