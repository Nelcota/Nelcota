import { NelcotaError, NelcotaUsageError } from "../core/client.errors.js";
import { isRecord } from "../core/json.js";
import type { State } from "./query-state.js";
import type { QueryResult, RowRange } from "./query-types.js";

/** Total rows from `Content-Range: 0-19/137` (`*` when not counted). */
export function countFromRange(header: string | null): number | null {
  const count = Number(header?.match(/^(?:\d+-\d+|\*)\/(\d+)$/)?.[1]);
  return Number.isSafeInteger(count) ? count : null;
}

/** Rows from `Content-Range: 0-19/137`; `null` for `*\/137` (no rows) or no header. */
export function rangeFromHeader(header: string | null): RowRange | null {
  const match = header?.match(/^(\d+)-(\d+)\//);
  if (match == null) return null;
  const from = Number(match[1]);
  const to = Number(match[2]);
  return Number.isSafeInteger(from) && Number.isSafeInteger(to) && to >= from ? { from, to } : null;
}

export function queryParams(state: State): URLSearchParams {
  const params = new URLSearchParams(state.params.map(([key, value]) => [key, value]));
  if (state.cardinality !== "many" && state.method === "GET" && params.has("limit") === false)
    params.set("limit", "2");
  return params;
}

export async function executeQuery<Out>(state: State): Promise<QueryResult<Out>> {
  const headers: Record<string, string> = {};
  if (state.prefer.length > 0) headers["prefer"] = state.prefer.join(",");
  const {
    data: rows,
    response,
    error,
  } = await state.http.json<unknown>({
    method: state.method,
    path: `/rest/v1/${encodeURIComponent(state.table)}`,
    query: queryParams(state),
    json: state.body,
    headers,
    signal: state.signal,
    timeout: state.timeout,
  });
  if (error != null) return { data: null, error, count: null, range: null, status: error.status };
  return representation<Out>(state, { rows, response });
}

function representation<Out>(
  state: State,
  { rows, response }: { rows: unknown; response: Response },
): QueryResult<Out> {
  const contentRange = response.headers.get("content-range");
  const count = countFromRange(contentRange),
    range = rangeFromHeader(contentRange);
  if (state.returnsRows && (Array.isArray(rows) === false || rows.every(isRecord) === false)) {
    const error = new NelcotaError({
      status: response.status,
      code: "invalid_response",
      message: "The server answered with something that is not an array of rows",
    });
    return { data: null, error, count: null, range: null, status: response.status };
  }
  if (state.cardinality === "many")
    return { data: rows as Out, error: null, count, range, status: response.status };
  return singleRow<Out>(state, rows, { count, range, status: response.status });
}
function singleRow<Out>(
  state: State,
  rows: unknown,
  metadata: { count: number | null; range: RowRange | null; status: number },
): QueryResult<Out> {
  if (Array.isArray(rows) === false)
    throw new NelcotaUsageError("single/maybeSingle requires a row representation");
  if (rows.length === 1 || (rows.length === 0 && state.cardinality === "maybe"))
    return { data: (rows[0] ?? null) as Out, error: null, ...metadata };
  const error = new NelcotaError({
    status: 406,
    code: "not_single",
    message: `Expected ${state.cardinality === "one" ? "exactly one row" : "at most one row"}, got ${rows.length === 2 && state.method === "GET" ? "more than one" : rows.length}`,
  });
  return { data: null, error, count: null, range: null, status: error.status };
}
