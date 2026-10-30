import { isAborted } from "../cancellation.js";
import { NelcotaError, NelcotaUsageError, clientError } from "../client.errors.js";
import { assertTokenAllowed } from "../jwt.js";
import { SECOND_IN_MS } from "../time.js";
import { HTTP_STATUS } from "./errors.js";
import { MAX_RETRY_WAIT_MS } from "./retry.js";
import type { RequestSpec, Attempt } from "./types.js";

const BEARER_PREFIX = "bearer ";

export function requestHeaders(
  defaults: Readonly<Record<string, string>>,
  extra: RequestSpec["headers"],
): Headers {
  try {
    const headers = new Headers(defaults);
    for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
    return headers;
  } catch {
    throw new NelcotaUsageError("Invalid HTTP header name or value");
  }
}

function attachToken(headers: Headers, token: string | null): void {
  if (token === null || token === "") return;
  assertTokenAllowed(token);
  try {
    headers.set("authorization", `Bearer ${token}`);
  } catch {
    throw new NelcotaUsageError("Invalid access token header");
  }
}

export function finishAuthentication(
  auth: RequestSpec["auth"],
  headers: Headers,
  token: string | null,
): NelcotaError | null {
  attachToken(headers, token);
  if (auth === true && (token == null || token === ""))
    return clientError("session_missing", "Not signed in");
  const bearer = headers.get("authorization");
  if (bearer?.toLowerCase().startsWith(BEARER_PREFIX) === true)
    assertTokenAllowed(bearer.slice(BEARER_PREFIX.length));
  return null;
}

export function attemptSignal(
  requested: AbortSignal | undefined,
  timeoutInMs: number,
): { signal: AbortSignal | undefined; timer: ReturnType<typeof setTimeout> | undefined } {
  const signals: AbortSignal[] = [];
  if (requested != null) signals.push(requested);
  const deadline = new AbortController();
  const timer =
    timeoutInMs > 0
      ? setTimeout(
          () => deadline.abort(new DOMException("Attempt timed out", "TimeoutError")),
          timeoutInMs,
        )
      : undefined;
  if (timeoutInMs > 0) signals.push(deadline.signal);
  return { signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0], timer };
}

export function retryResponse(status: number, failure: NelcotaError, attempt: Attempt): boolean {
  return (
    (status === HTTP_STATUS.tooManyRequests || status === HTTP_STATUS.unavailable) &&
    attempt.attempt < attempt.retries &&
    (failure.retryAfter ?? 0) * SECOND_IN_MS <= MAX_RETRY_WAIT_MS
  );
}

export function successfulResponse(response: Response): boolean {
  return (
    response.ok ||
    (response.status >= HTTP_STATUS.redirectStart && response.status < HTTP_STATUS.clientErrorStart)
  );
}

function timedOut(cause: unknown, signal: AbortSignal | undefined): boolean {
  const reason: unknown = signal?.reason;
  return (
    (signal?.aborted === true &&
      reason instanceof DOMException &&
      reason.name === "TimeoutError") ||
    (cause instanceof DOMException && cause.name === "TimeoutError")
  );
}

export function attemptError(
  cause: unknown,
  {
    signal,
    requested,
    timeoutInMs,
    reading = false,
  }: {
    signal: AbortSignal | undefined;
    requested: AbortSignal | undefined;
    timeoutInMs: number;
    /** The status arrived and the failure happened while reading the body. */
    reading?: boolean;
  },
): NelcotaError {
  if (cause instanceof NelcotaError) return cause;
  if (isAborted(requested)) return clientError("aborted", "The request was aborted", cause);
  if (timedOut(cause, signal))
    return clientError("timeout", `No response within ${timeoutInMs} ms`, cause);
  // The server answered (a write may have committed); only its body was lost.
  if (reading) return clientError("response_body_error", "The response could not be read", cause);
  return clientError("network_error", "The server could not be reached", cause);
}
