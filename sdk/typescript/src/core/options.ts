/** Shared transport configuration; session handling belongs to the auth module. */
import { HttpClient, baseUrl, type FetchLike, type TokenSource } from './http.js';

export interface TransportOptions {
  /** Caller-owned token source, evaluated before each request. */
  accessToken?: TokenSource;
  /** Defaults to the runtime's fetch. */
  fetch?: FetchLike;
  headers?: Record<string, string>;
  /** Per-attempt timeout, including buffered response bodies. Default 30000; 0 disables it. */
  timeout?: number;
  /** Additional attempts for GET/HEAD only. Default 2. */
  retries?: number;
}

export function createHttpClient(url: string | URL, options: TransportOptions = {}, token?: TokenSource): HttpClient {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) throw new TypeError('No fetch available: pass options.fetch');
  return new HttpClient({
    url: baseUrl(url),
    fetch: fetchImpl,
    headers: { ...options.headers },
    timeout: options.timeout ?? 30_000,
    retries: options.retries ?? 2,
    token: options.accessToken ?? token ?? (() => null),
  }, options.accessToken);
}
