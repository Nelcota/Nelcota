import type { NelcotaError } from "../client.errors.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type TokenSource = () => Promise<string | null> | string | null;

export interface HttpOptions {
  url: URL;
  fetch: FetchLike;
  headers: Readonly<Record<string, string>>;
  /** Default timeout per attempt, in ms. `0` disables it. */
  timeout: number;
  /** Retries for idempotent requests on 429/503 and network errors. */
  retries: number;
  token: TokenSource;
}

export interface RequestSpec {
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: URLSearchParams | undefined;
  /** A plain value is sent as JSON; a `BodyInit` as is. */
  json?: unknown;
  body?: BodyInit | null | undefined;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  /** Per-request timeout in ms (`0` disables it). */
  timeout?: number | undefined;
  /** `true` requires a source token; `false` omits auth; a string pins a token. */
  auth?: boolean | string | undefined;
  /** Internal response-shape check, after decoding and before publication. */
  validate?: (value: unknown) => boolean;
}

export type HttpResult<T> =
  | { data: T; error: null; response: Response }
  | { data: null; error: NelcotaError; response: Response | null };

export interface PreparedRequest {
  body: BodyInit | null | undefined;
  headers: Headers;
  timeoutInMs: number;
}

export interface Attempt extends PreparedRequest {
  attempt: number;
  retries: number;
  href: string;
  streaming: boolean;
}
