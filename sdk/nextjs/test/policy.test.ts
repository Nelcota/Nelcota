import { describe, expect, it } from 'vitest';
import { requireMutation, safeReturnTo, trustedUrl } from '../src/policy.js';

describe('redirect and origin policy', () => {
  it.each(['https://evil.test', '//evil.test', '///evil.test', '/\\evil.test', '/%5cevil.test', '/%2f%2fevil.test', '/%252f%252fevil.test', '/%0aLocation:evil', '/.//evil.test', '/%2e%2e//evil.test', '/%zz', '/%2525252fevil.test'])('refuses unsafe return target %s', path => {
    expect(safeReturnTo(path)).toBe('/');
  });
  it.each(['/notes', '/notes?tab=mine', '/search?q=hello%20world', '/dashboard#settings'])('retains safe local target %s', path => {
    expect(safeReturnTo(path)).toBe(path);
  });
  it('does not trust Host or forwarded headers as CSRF authority', () => {
    for (const headers of [new Headers(), new Headers({ origin: 'https://evil.test', host: 'app.test' }), new Headers({ origin: 'https://app.test', 'sec-fetch-site': 'cross-site' }), new Headers({ 'x-forwarded-host': 'app.test' })]) {
      expect(() => requireMutation(headers, 'POST', 'https://app.test')).toThrow();
    }
    expect(() => requireMutation(new Headers({ origin: 'https://app.test' }), 'GET', 'https://app.test')).toThrow();
    expect(() => requireMutation(new Headers({ origin: 'https://app.test' }), 'POST', 'https://app.test')).not.toThrow();
  });
  it('restricts insecure URLs to explicit local development', () => {
    for (const url of ['http://app.test', 'https://user:password@app.test', 'https://app.test/?key=secret', 'https://app.test/#secret']) expect(() => trustedUrl(url, false)).toThrow();
    expect(() => trustedUrl('http://127.0.0.1:3000', true)).not.toThrow();
    expect(() => trustedUrl('http://remote.test', true)).toThrow();
  });
});
