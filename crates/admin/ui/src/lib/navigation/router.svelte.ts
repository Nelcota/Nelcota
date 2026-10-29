// Minimal SPA router based at /admin (history API).
const BASE = "/admin";

function current(): string {
  const path = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : "/";
  return path === "" ? "/" : path;
}

export const route = $state({
  path: current(),
  query: new URLSearchParams(location.search),
  revision: 0,
});

interface NavigationGuard {
  blocked: () => boolean;
  request: (proceed: () => void) => void;
}
const guards = new Set<NavigationGuard>();

export function beforeNavigate(guard: NavigationGuard): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

function requestNavigation(action: () => void, accepted = new Set<NavigationGuard>()) {
  for (const guard of guards) {
    if (accepted.has(guard) || guard.blocked() === false) continue;
    guard.request(() => requestNavigation(action, new Set([...accepted, guard])));
    return;
  }
  action();
}

// Tag our entries so cancelling Back/Forward restores the original entry,
// rather than pushing duplicates or destroying the forward history.
const INDEX = "nelcotaNavigationIndex";
function entryIndex(): number | null {
  const state: unknown = history.state;
  if (state === null || typeof state !== "object" || INDEX in state === false) return null;
  const value = state[INDEX];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
function entryState(index: number) {
  const state: unknown = history.state;
  return { ...(state !== null && typeof state === "object" ? state : {}), [INDEX]: index };
}
let index = entryIndex() ?? 0;
history.replaceState(entryState(index), "");
let savedUrl = location.href;
let savedState: unknown = history.state;
let restoring: { delta: number; targetIndex: number; targetUrl: string } | null = null;
let approvedPop: { index: number; url: string } | null = null;

export function navigate(to: string, replace = false) {
  const url = BASE + (to.startsWith("/") ? to : `/${to}`);
  requestNavigation(() => {
    // SSO can replace the initial entry's state before the first navigation.
    if (entryIndex() === null) history.replaceState(entryState(index), "");
    if (replace === false) index++;
    history[replace ? "replaceState" : "pushState"](entryState(index), "", url);
    sync();
  });
}

const withoutHash = (url: string) => url.split("#", 1)[0];

function sync() {
  // Returning to the same URL creates a new navigation context as well.
  route.revision++;
  route.path = current();
  route.query = new URLSearchParams(location.search);
  savedUrl = location.href;
  savedState = history.state;
}

function restorePendingPop(targetIndex: number | null): boolean {
  if (restoring === null) return false;
  // Native hash entries retain our index; count each real step back to the draft.
  if (targetIndex !== index || location.href !== savedUrl) {
    const step = Math.sign(restoring.delta);
    restoring.delta += step;
    history.go(-step);
    return true;
  }
  const { delta, targetIndex: destination, targetUrl } = restoring;
  restoring = null;
  requestNavigation(() => {
    approvedPop = { index: destination, url: targetUrl };
    history.go(delta);
  });
  return true;
}
function acceptApprovedPop(targetIndex: number | null): boolean {
  if (
    targetIndex === null ||
    approvedPop?.index !== targetIndex ||
    approvedPop.url !== location.href
  )
    return false;
  approvedPop = null;
  index = targetIndex;
  sync();
  return true;
}
function syncPublicPop(targetIndex: number | null): void {
  index = targetIndex ?? index;
  if (withoutHash(location.href) === withoutHash(savedUrl)) {
    savedUrl = location.href;
    savedState = history.state;
    return;
  }
  sync();
}
function blockUntrackedPop(): void {
  const targetUrl = location.href;
  history.replaceState(savedState, "", savedUrl);
  requestNavigation(() => {
    index++;
    history.pushState(entryState(index), "", targetUrl);
    sync();
  });
}
addEventListener("popstate", () => {
  const targetIndex = entryIndex();
  if (restorePendingPop(targetIndex)) return;
  if (acceptApprovedPop(targetIndex)) return;
  approvedPop = null;
  if ([...guards].some((guard) => guard.blocked()) === false) {
    syncPublicPop(targetIndex);
    return;
  }
  if (targetIndex !== null && targetIndex !== index) {
    restoring = { delta: targetIndex - index, targetIndex, targetUrl: location.href };
    history.go(index - targetIndex);
    return;
  }
  blockUntrackedPop();
});

addEventListener("beforeunload", (event) => {
  if ([...guards].some((guard) => guard.blocked()) === false) return;
  event.preventDefault();
});

// Internal links (<a href="/admin/...">) navigate without reloading the page.
function plainClick(event: MouseEvent): boolean {
  return (
    event.defaultPrevented === false &&
    event.button === 0 &&
    event.metaKey === false &&
    event.ctrlKey === false &&
    event.altKey === false &&
    event.shiftKey === false
  );
}
function navigationAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  if (target instanceof Element === false) return null;
  const anchor = target.closest("a");
  if (anchor instanceof HTMLAnchorElement === false) return null;
  if (anchor.target !== "" || anchor.getAttribute("href")?.startsWith("#") === true) return null;
  return anchor;
}
addEventListener("click", (event) => {
  if (plainClick(event) === false) return;
  const anchor = navigationAnchor(event.target);
  if (anchor === null) return;
  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith(BASE + "/") === false) return;
  if (url.pathname.startsWith(BASE + "/api")) return;
  event.preventDefault();
  navigate(url.pathname.slice(BASE.length) + url.search);
});

// Route matching is pure (testable outside the browser): it lives in route-match.

export const href = (path: string) => BASE + path;
