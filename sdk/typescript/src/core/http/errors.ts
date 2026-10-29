import { NelcotaError } from "../client.errors.js";
import { isRecord } from "../json.js";
import { parseRetryAfter } from "./retry.js";
export const HTTP_STATUS = {
  redirectStart: 300,
  clientErrorStart: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  tooManyRequests: 429,
  unavailable: 503,
} as const;

const MAX_ERROR_BYTES = 65_536;

/** Error pages are metadata, even when a proxy sends a large or endless body. */
async function errorBody(response: Response): Promise<string | null> {
  if (response.body == null) return "";
  const length = response.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_ERROR_BYTES) {
    void response.body.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  try {
    return await readErrorChunks(reader);
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

async function readErrorChunks(
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>,
): Promise<string | null> {
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let size = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- Read one chunk at a time so the error-body budget stops unbounded responses.
    const { done, value } = await reader.read();
    if (done) return parts.join("") + decoder.decode();
    size += value.byteLength;
    if (size > MAX_ERROR_BYTES) {
      void reader.cancel().catch(() => {});
      return null;
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
}
/**
 * The code for an error response without a JSON body (a HEAD request, a
 * proxy page): the common statuses keep a meaningful code, the rest get
 * `http_<status>`.
 */
function codeForStatus(status: number): string {
  switch (status) {
    case HTTP_STATUS.unauthorized:
      return "unauthorized";
    case HTTP_STATUS.forbidden:
      return "forbidden";
    case HTTP_STATUS.notFound:
      return "not_found";
    case HTTP_STATUS.tooManyRequests:
      return "rate_limited";
    case HTTP_STATUS.unavailable:
      return "unavailable";
    default:
      return `http_${status}`;
  }
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** The server's `{ code, message, ... }`, or a generic error from the status. */
export async function errorFromResponse(response: Response): Promise<NelcotaError> {
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  let code = codeForStatus(response.status);
  let message = response.statusText === "" ? `HTTP ${response.status}` : response.statusText;
  let record: Record<string, unknown> = {};
  const text = await errorBody(response);
  try {
    const body: unknown = text === null ? null : JSON.parse(text);
    if (isRecord(body)) {
      record = body;
      code = optionalString(record, "code") ?? code;
      message = optionalString(record, "message") ?? message;
    }
  } catch {
    // Not JSON (a proxy page, an empty body): keep the generic error.
  }
  return new NelcotaError({
    status: response.status,
    code,
    message,
    retryAfter,
    sqlstate: optionalString(record, "sqlstate"),
    details: optionalString(record, "details"),
    hint: optionalString(record, "hint"),
    constraint: optionalString(record, "constraint"),
  });
}
