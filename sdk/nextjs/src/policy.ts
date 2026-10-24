import { SessionError } from './errors.js';

export function trustedUrl(value: string, development: boolean, originOnly = false): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new SessionError('configuration', 'Invalid application or API URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(development && local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || (originOnly && url.pathname !== '/')) {
    throw new SessionError('configuration', 'Use HTTPS URLs without credentials, queries or fragments; insecure development is loopback-only');
  }
  return url;
}

/** Only local, canonical paths. Never reflect an untrusted absolute redirect. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return '/';
  let decoded = value;
  for (let count = 0; count < 3; count++) {
    if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(decoded)) return '/';
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch { return '/'; }
  }
  // Reject residual encodings rather than leaving a fourth decoder a redirect.
  if (/%[0-9a-f]{2}/i.test(decoded)) return '/';
  const url = new URL(value, 'https://return.invalid');
  if (url.origin !== 'https://return.invalid' || url.pathname.startsWith('//')) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}

export function requireMutation(headers: Pick<Headers, 'get'>, method: string, origin: string): void {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || headers.get('origin') !== origin || headers.get('sec-fetch-site') === 'cross-site') {
    throw new SessionError('csrf', 'This operation requires a same-origin unsafe request');
  }
}
