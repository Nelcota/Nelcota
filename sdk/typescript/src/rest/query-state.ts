import type { HttpClient } from "../core/http/client.js";

export type Method = "GET" | "HEAD" | "POST" | "PATCH" | "DELETE";

type Cardinality = "many" | "one" | "maybe";

export interface State {
  readonly http: HttpClient;
  readonly table: string;
  readonly method: Method;
  readonly params: readonly (readonly [string, string])[];
  readonly prefer: readonly string[];
  readonly body?: unknown;
  readonly cardinality: Cardinality;
  readonly returnsRows: boolean;
  readonly signal?: AbortSignal | undefined;
  readonly timeout?: number | undefined;
  readonly throws?: boolean;
}
