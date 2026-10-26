'use client';

export interface BrowserSessionOptions {
  endpoint?: string;
  timeout?: number;
  signal?: AbortSignal;
}

/** Calls the app's POST refresh route. No access/refresh tokens enter JavaScript.
 * Web Locks reduce duplicate tab requests; the shared server store is the
 * authority when locks are unavailable or requests reach different instances.
 */
export async function refreshSession(options: BrowserSessionOptions = {}): Promise<Response> {
  const endpoint = options.endpoint ?? '/auth/session/refresh';
  if (!endpoint.startsWith('/') || endpoint.startsWith('//') || /[\\\u0000-\u0020\u007f#]/.test(endpoint)) throw new TypeError('Use a same-origin refresh path');
  const url = new URL(endpoint, globalThis.location.origin);
  if (url.origin !== globalThis.location.origin || url.pathname.startsWith('//')) throw new TypeError('Use a same-origin refresh path');
  const timeout = options.timeout ?? 10000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30000) throw new TypeError('Refresh timeout must be between 100 and 30000 ms');
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(timeout)]);
  const send = async (): Promise<Response> => fetch(url, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { 'X-Nelcota-Next': '1' }, signal,
  });
  if (navigator.locks) return navigator.locks.request(`nelcota-next-refresh:${url.pathname}`, { signal }, send);
  return send();
}
