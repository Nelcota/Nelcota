import { responseContract } from "$lib/contracts/responses";
import { t } from "$lib/i18n/index.svelte";
import {
  clearQuerySession,
  invalidateReads,
  queryRead,
  querySession,
} from "$lib/resources/query-client";
// Panel API client (/admin/api). The session lives in an HttpOnly cookie.
import { session } from "$lib/resources/session.svelte";

import { ApiError, httpError, errorFromBody } from "./api-error";
import { HTTP_STATUS } from "./http-status";
import { readBody } from "./read-body";
export { ApiError, httpError } from "./api-error";

let authentication = Promise.resolve();
const REQUEST_TIMEOUT_MS = 60_000;
const MIGRATION_TIMEOUT_MS = 660_000;

async function request<T>(
  method: string,
  path: string,
  { body, signal }: { body?: unknown; signal?: AbortSignal | undefined } = {},
): Promise<T> {
  const encoded =
    body === undefined
      ? undefined
      : JSON.stringify(body, (_key, original: unknown) => {
          const value = original instanceof Number ? original.valueOf() : original;
          if (typeof value === "number" && Number.isFinite(value) === false)
            throw new Error(t("common.invalidNumber"));
          return value;
        });
  // Synchronously, before the first await, like uploadFile: a caller such as
  // logout() reads the session right after starting the request and must see
  // the new one, and a request belongs to the session it was started in.
  const changesSession = ["/login", "/logout", "/sso"].includes(path);
  if (changesSession) clearQuerySession();
  const started = querySession();
  await loadContractFirst(method, path);
  const send = () =>
    sendRequest<T>(method, path, { encoded, hasBody: body !== undefined, signal, started });
  if (changesSession === false) return await send();
  // Epoch checks cannot undo Set-Cookie. Finish earlier authentication
  // responses before sending another request that replaces the same cookie.
  const pending = authentication.then(send);
  authentication = pending.then(
    () => {},
    () => {},
  );
  return await pending;
}

async function sendRequest<T>(
  method: string,
  path: string,
  {
    encoded,
    hasBody,
    signal,
    started,
  }: {
    encoded: string | undefined;
    hasBody: boolean;
    signal: AbortSignal | undefined;
    started: number;
  },
): Promise<T> {
  requireSession(started);
  const controller = new AbortController();
  const deadline = new DOMException("Request deadline exceeded", "TimeoutError");
  const abort = () => controller.abort(signal?.reason);
  const timeoutMs =
    method === "POST" && path === "/migrations/apply" ? MIGRATION_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(deadline), timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted === true) abort();
    controller.signal.throwIfAborted();
    const res = await fetch(`/admin/api${path}`, {
      method,
      signal: controller.signal,
      credentials: "same-origin",
      headers: hasBody ? { "content-type": "application/json" } : {},
      body: encoded,
    });
    const result = await parseResponse<T>(res, path, {
      method: method,
      started: started,
      signal: controller.signal,
    });
    requireSession(started);
    return result;
  } catch (error) {
    if (controller.signal.reason !== deadline) throw error;
    throw timeoutError(method, started);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function timeoutError(method: string, started: number): ApiError {
  const reading = method === "GET" || method === "HEAD";
  // A missing response cannot prove a write was rolled back.
  if (reading === false && started === querySession()) invalidateReads();
  const code = reading ? "request_timeout" : "write_timeout";
  return new ApiError(t(`errors.${code}`), HTTP_STATUS.gatewayTimeout, { code });
}

/**
 * Downloads the response's validator before the request is sent: a failed
 * download then fails the request before any side effect, rather than turning
 * a committed write (a secret shown once) into an error after the fact.
 * parseResponse's own lookup then resolves from the loaded module.
 */
async function loadContractFirst(method: string, path: string) {
  await responseContract(method, path);
}

/** Sends a file as the raw request body (storage uploads). */
export async function uploadFile<T>(
  path: string,
  file: File,
  onprogress?: (loaded: number, total: number) => void,
): Promise<T> {
  const started = querySession();
  const [{ upload }] = await Promise.all([import("./upload"), loadContractFirst("POST", path)]);
  requireSession(started);
  // request() re-checks the session after parseResponse; uploads have no such
  // wrapper, so a response finished under another session is dropped here.
  const parse = async (response: Response) => {
    const result = await parseResponse<T>(response, path, { method: "POST", started: started });
    requireSession(started);
    return result;
  };
  try {
    return await upload(path, file, { parse: parse, progress: onprogress });
  } catch (error) {
    // A response aborted at the XHR budget never reaches parseResponse.
    if (error instanceof ApiError) expireSession(error.status, path, started);
    throw error;
  }
}

export function expireSession(status: number, path = "", started = querySession()) {
  if (started !== querySession() || status !== HTTP_STATUS.unauthorized || path === "/login")
    return;
  clearQuerySession();
  if (session.email != null && session.email !== "") session.expired = true;
  session.email = null;
}

function requireSession(started: number) {
  if (started !== querySession()) throw new DOMException("Session changed", "AbortError");
}

function decodePanelBody(text: string): { data: unknown; json: boolean } {
  let data: unknown = null;
  let json = true;
  try {
    data = text !== "" ? JSON.parse(text) : null;
  } catch {
    json = false;
    data = { error: text };
  }
  return { data, json };
}

function throwResponseError(
  res: Response,
  path: string,
  { started, data, json }: { started: number; data: unknown; json: boolean },
): never {
  expireSession(res.status, path, started);
  // Not our JSON error (e.g. a reverse proxy's HTML 502 page): never show
  // the raw body, say what happened in the user's language instead.
  if (json === false) throw httpError(res.status);
  throw errorFromBody(res.status, data);
}

export async function parseResponse<T>(
  res: Response,
  path: string,
  {
    method,
    started = querySession(),
    signal,
  }: { method: string; started?: number | undefined; signal?: AbortSignal | undefined },
): Promise<T> {
  if (started !== querySession()) {
    void res.body?.cancel().catch(() => {});
    requireSession(started);
  }
  // Successful headers can follow a committed write even when decoding its
  // body fails. Refresh reads before parsing or validating that response.
  if (committedWrite(started, res, method)) invalidateReads();
  // Error pages are metadata; a proxy cannot force the panel to buffer its body.
  // Only errors have a byte cap; both body paths honor the request deadline.
  const body = await readBody(
    res,
    res.ok ? Number.MAX_SAFE_INTEGER : ERROR_RESPONSE_MAX_BYTES,
    signal,
  );
  const text = await (body === null ? "" : body.text());
  signal?.throwIfAborted();
  requireSession(started);
  const { data, json } = decodePanelBody(text);
  if (res.ok === false) throwResponseError(res, path, { started, data, json });
  // A 200 that isn't JSON is someone else's page (an auth proxy's sign-in
  // form after a redirect), not this API answering.
  if (json === false)
    throw new ApiError(t("common.invalidResponse"), HTTP_STATUS.badGateway, {
      code: "invalid_response",
    });
  const validate = await responseContract(method, path);
  requireResponseContract(data, validate);
  return data as T;
}

function committedWrite(started: number, response: Response, method: string): boolean {
  return started === querySession() && response.ok && method !== "GET" && method !== "HEAD";
}
function requireResponseContract(
  data: unknown,
  validate: Awaited<ReturnType<typeof responseContract>>,
): void {
  if (validate != null && Boolean(validate(data)) === false)
    throw new ApiError(t("common.invalidResponse"), HTTP_STATUS.badGateway, {
      code: "invalid_response",
    });
}

export const api = {
  get: <T>(path: string, options: { signal?: AbortSignal; freshForMs?: number } = {}) =>
    path === "/session"
      ? request<T>("GET", path, { body: undefined, signal: options.signal })
      : queryRead(
          { path: path, account: session.email },
          (signal) => request<T>("GET", path, { body: undefined, signal: signal }),
          { signal: options.signal, freshForMs: options.freshForMs ?? 0 },
        ),
  post: <T>(path: string, body: unknown = {}, options: { signal?: AbortSignal } = {}) =>
    request<T>("POST", path, { body: body, signal: options.signal }),
  patch: <T>(path: string, body: unknown, options: { signal?: AbortSignal } = {}) =>
    request<T>("PATCH", path, { body: body, signal: options.signal }),
  put: <T>(path: string, body: unknown, options: { signal?: AbortSignal } = {}) =>
    request<T>("PUT", path, { body: body, signal: options.signal }),
  delete: <T>(path: string, body?: unknown) => request<T>("DELETE", path, { body: body }),
};

export const enc = encodeURIComponent;

/** Request cancelled by a newer one (not an error for the user). */
export const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

const ERROR_RESPONSE_MAX_BYTES = 65_536;
