import { abortable, isAborted } from "../cancellation.js";
import { NelcotaError, NelcotaUsageError, clientError } from "../client.errors.js";
import { encodeJson, parseJson } from "../json.js";
import { MAX_TIMER_IN_MS } from "../runtime.js";
import { errorFromResponse } from "./errors.js";
import {
  requestHeaders,
  finishAuthentication,
  attemptSignal,
  retryResponse,
  successfulResponse,
  attemptError,
} from "./request.js";
import { backoff, sleep } from "./retry.js";
import type {
  TokenSource,
  HttpOptions,
  RequestSpec,
  HttpResult,
  PreparedRequest,
  Attempt,
} from "./types.js";
export type { FetchLike, TokenSource, HttpOptions, RequestSpec } from "./types.js";
export { errorFromResponse } from "./errors.js";
export { parseRetryAfter } from "./retry.js";

function nonNegativeInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): void {
  if (Number.isSafeInteger(value) === false || value < 0 || value > maximum) {
    throw new NelcotaUsageError(`${name} must be an integer between 0 and ${maximum}`);
  }
}

export class HttpClient {
  readonly url: URL;
  readonly #options: HttpOptions;
  /** The base URL without trailing slashes. */
  readonly #base: string;

  constructor(
    options: HttpOptions,
    readonly accessToken?: TokenSource,
  ) {
    nonNegativeInteger(options.timeout, "timeout", MAX_TIMER_IN_MS);
    nonNegativeInteger(options.retries, "retries");
    this.url = options.url;
    this.#options = options;
    let end = options.url.href.length;
    while (end > 0 && options.url.href[end - 1] === "/") end--;
    this.#base = options.url.href.slice(0, end);
  }

  /** Absolute URL for a path (and query) under the base URL. */
  href(path: string, query?: URLSearchParams): string {
    // Not `size`: Safari < 17 lacks it.
    const search = query != null && query.toString() !== "" ? `?${query}` : "";
    return `${this.#base}${path}${search}`;
  }

  /**
   * Sends the request and returns the response when it is 2xx/3xx, or a
   * `NelcotaError` otherwise. Never throws for HTTP or network failures.
   */
  async #request<T>(
    spec: RequestSpec,
    read: (response: Response) => Promise<T>,
  ): Promise<HttpResult<T>> {
    const timeoutInMs = this.#timeout(spec);
    if (isAborted(spec.signal)) {
      return {
        data: null,
        response: null,
        error: clientError("aborted", "The request was aborted"),
      };
    }
    if (spec.json !== undefined && spec.body !== undefined)
      throw new NelcotaUsageError("A request has either json or body, not both");
    const body = spec.json === undefined ? spec.body : encodeJson(spec.json);
    const headers = requestHeaders(this.#options.headers, spec.headers);
    const authentication = this.#authenticate(spec, headers);
    const authenticationError =
      authentication instanceof Promise ? await authentication : authentication;
    if (authenticationError !== null)
      return { data: null, response: null, error: authenticationError };
    if (isAborted(spec.signal)) {
      return {
        data: null,
        response: null,
        error: clientError("aborted", "The request was aborted"),
      };
    }
    if (spec.json !== undefined) {
      headers.set("content-type", "application/json");
    }

    return await this.#retry(spec, { body, headers, timeoutInMs }, read);
  }

  /** The request's timeout; the default was validated by the constructor. */
  #timeout(spec: RequestSpec): number {
    if (spec.timeout === undefined) return this.#options.timeout;
    nonNegativeInteger(spec.timeout, "timeout", MAX_TIMER_IN_MS);
    return spec.timeout;
  }

  #authenticate(
    spec: RequestSpec,
    headers: Headers,
  ): NelcotaError | null | Promise<NelcotaError | null> {
    if (spec.auth === false) headers.delete("authorization");
    if (spec.auth === false || typeof spec.auth === "string") {
      const token = typeof spec.auth === "string" ? spec.auth : null;
      return finishAuthentication(spec.auth, headers, token);
    }
    return this.#authenticateFromSource(spec, headers);
  }

  async #authenticateFromSource(spec: RequestSpec, headers: Headers): Promise<NelcotaError | null> {
    let token: string | null;
    try {
      const result = await abortable(Promise.resolve(this.#options.token()), spec.signal);
      if (result.error != null) return result.error;
      token = result.data;
    } catch (error) {
      if (error instanceof NelcotaError) return error;
      throw error;
    }
    if (isAborted(spec.signal)) return clientError("aborted", "The request was aborted");
    return finishAuthentication(spec.auth, headers, token);
  }

  async #retry<T>(
    spec: RequestSpec,
    prepared: PreparedRequest,
    read: (response: Response) => Promise<T>,
  ): Promise<HttpResult<T>> {
    const retries = spec.method === "GET" || spec.method === "HEAD" ? this.#options.retries : 0;
    const href = this.href(spec.path, spec.query);
    const streaming =
      typeof ReadableStream !== "undefined" && prepared.body instanceof ReadableStream;
    for (let attempt = 0; ; attempt++) {
      // oxlint-disable-next-line no-await-in-loop -- An HTTP retry depends on the preceding failure and must respect its backoff before sending.
      const outcome = await this.#attempt(
        spec,
        { ...prepared, attempt, retries, href, streaming },
        read,
      );
      if ("retry" in outcome === false) return outcome;
      try {
        // oxlint-disable-next-line no-await-in-loop -- An HTTP retry depends on the preceding failure and must respect its backoff before sending.
        await sleep(backoff(attempt, outcome.retry.retryAfter), spec.signal);
      } catch (cause) {
        return {
          data: null,
          response: null,
          error: clientError("aborted", "The request was aborted", cause),
        };
      }
    }
  }

  async #attempt<T>(
    spec: RequestSpec,
    attempt: Attempt,
    read: (response: Response) => Promise<T>,
  ): Promise<HttpResult<T> | { retry: NelcotaError }> {
    const { signal, timer } = attemptSignal(spec.signal, attempt.timeoutInMs);
    const init: RequestInit & { duplex?: "half" } = {
      method: spec.method,
      headers: attempt.headers,
      body: attempt.body ?? null,
      redirect: "follow",
    };
    if (signal != null) init.signal = signal;
    if (attempt.streaming) init.duplex = "half";
    // Set once a successful status arrived: a later failure reads the body.
    let reading = false;
    try {
      const response = await this.#options.fetch(attempt.href, init);
      if (successfulResponse(response)) {
        reading = true;
        return { data: await read(response), response, error: null };
      }
      const failure = await errorFromResponse(response);
      if (retryResponse(response.status, failure, attempt)) return { retry: failure };
      return { data: null, response: null, error: failure };
    } catch (cause) {
      const failure = attemptError(cause, {
        signal,
        requested: spec.signal,
        timeoutInMs: attempt.timeoutInMs,
        reading,
      });
      if (
        cause instanceof NelcotaError ||
        isAborted(spec.signal) ||
        attempt.attempt >= attempt.retries
      )
        return { data: null, response: null, error: failure };
      return { retry: failure };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Raw streaming response. Later body reads belong to the caller. */
  async send(
    spec: RequestSpec,
  ): Promise<{ response: Response; error: null } | { response: null; error: NelcotaError }> {
    const result = await this.#request(spec, (response) => Promise.resolve(response));
    return result.error != null
      ? { response: null, error: result.error }
      : { response: result.data, error: null };
  }

  /** `send` plus JSON decoding; 204 and empty bodies give `null`. */
  async json<T>(spec: RequestSpec): Promise<HttpResult<T>> {
    return await this.#request(spec, async (response) => {
      const text = spec.method === "HEAD" ? "" : await response.text();
      try {
        const value = text === "" ? null : parseJson(text);
        if (spec.validate?.(value) === false) throw new Error("Invalid response shape");
        return value as T;
      } catch (cause) {
        throw new NelcotaError({
          status: response.status,
          code: "invalid_response",
          message: "The server answered with invalid JSON data",
          cause,
        });
      }
    });
  }

  /** Buffered download with the same failure and retry contract as JSON. */
  async blob(
    spec: RequestSpec,
  ): Promise<{ data: Blob; error: null } | { data: null; error: NelcotaError }> {
    const result = await this.#request(spec, (response) => response.blob());
    return result.error != null
      ? { data: null, error: result.error }
      : { data: result.data, error: null };
  }
}

/** Validates the base URL: http(s), no credentials, query or fragment. */
export function baseUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new NelcotaUsageError(`Invalid Nelcota URL: ${String(input)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new NelcotaUsageError("The Nelcota URL must be http or https");
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.href.includes("?") ||
    url.href.includes("#")
  ) {
    throw new NelcotaUsageError("The Nelcota URL cannot carry credentials, a query or a fragment");
  }
  return url;
}
