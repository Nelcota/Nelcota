const MAX_IPV4_OCTET = 255;

// Whether the server answers, for the dot on the project chip. Checked once a
// minute and whenever the window regains focus or the network comes back, so
// a stopped server shows before the next page load fails.
const INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 5000;
const TIMEOUT_MS = 10_000;

export const health = $state<{ status: "checking" | "online" | "offline" }>({ status: "checking" });

let started = false;
let controller: AbortController | undefined;
let lastCheck = -Infinity;

async function check() {
  if (navigator.onLine === false) {
    markOffline();
    return;
  }
  if (shouldCheck() === false) return;
  lastCheck = performance.now();
  const request = (controller = new AbortController());
  const timer = setTimeout(() => {
    if (controller !== request) return;
    controller = undefined;
    request.abort();
    health.status = "offline";
  }, TIMEOUT_MS);
  try {
    const res = await fetch("/health", { cache: "no-store", signal: request.signal });
    if (controller !== request || request.signal.aborted) return;
    health.status = res.ok ? "online" : "offline";
  } catch {
    if (controller === request) health.status = "offline";
  } finally {
    clearTimeout(timer);
    if (controller === request) controller = undefined;
  }
}

function shouldCheck(): boolean {
  return (
    controller == null &&
    document.visibilityState !== "hidden" &&
    performance.now() - lastCheck >= MIN_INTERVAL_MS
  );
}

function markOffline() {
  controller?.abort();
  controller = undefined;
  lastCheck = -Infinity;
  health.status = "offline";
}

/** Starts the checks (once per page load); returns nothing to stop, they live with the panel. */
export function watchHealth() {
  if (started) return;
  started = true;
  const refresh = () => {
    void check();
  };
  refresh();
  setInterval(refresh, INTERVAL_MS);
  window.addEventListener("focus", refresh);
  window.addEventListener("online", refresh);
  window.addEventListener("offline", markOffline);
}

/** "local" for this machine, else the host the panel is served from. */
export function environment(
  hostname = location.hostname,
): { local: true } | { local: false; host: string } {
  const loopback =
    /^127(?:\.\d{1,3}){3}$/.test(hostname) &&
    hostname.split(".").every((part) => Number(part) <= MAX_IPV4_OCTET);
  const local =
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    loopback ||
    hostname.endsWith(".localhost");
  return local ? { local: true } : { local: false, host: hostname };
}
