/**
 * `@nelcota/client/rest`: tables, views and functions of the exposed schema,
 * under the caller's RLS.
 */

import { NelcotaUsageError, type NelcotaError } from '../core/errors.js';
import { identifier } from '../core/encoding.js';
import type { HttpClient } from '../core/http.js';
import { isRecord } from '../core/json.js';
import { createHttpClient, type TransportOptions } from '../core/options.js';
import { TableRef } from './query.js';
import type {
  ArgsOptional,
  FunctionArgs,
  FunctionName,
  FunctionReturns,
  GenericSchema,
  InsertOf,
  Relation,
  RelationName,
  RowOf,
  UpdateOf,
  DefaultSchemaName,
  SchemaOf,
} from './types.js';

export { NelcotaError, NelcotaUsageError, unwrap } from '../core/errors.js';
export { escapeLike } from '../core/encoding.js';
export type { TransportOptions } from '../core/options.js';
export type { FetchLike, TokenSource } from '../core/http.js';

/** REST without loading session handling or storage. Supply a token source when needed. */
export function createRestClient<Database = any, SchemaName extends string = DefaultSchemaName<Database>>(
  url: string | URL,
  options: TransportOptions & { schema?: SchemaName } = {},
): RestClient<SchemaOf<Database, SchemaName>> {
  return new RestClient(createHttpClient(url, options));
}

export { Query, TableRef, countFromRange, rangeFromHeader, selectList } from './query.js';
export type {
  CountOption,
  FilterColumn,
  OrderOptions,
  QueryOutcome,
  QueryResult,
  QuerySuccess,
  ReferencedOption,
  RowRange,
  SelectOptions,
  UpsertOptions,
} from './query.js';
export { Conditions } from './conditions.js';
export type { CompareOperator, Condition, FilterValue, IsValue } from './conditions.js';
export type * from './types.js';

export interface RpcOptions {
  signal?: AbortSignal;
  /** Timeout in ms (`0` disables it). */
  timeout?: number;
}

export type RpcResult<T> = { data: T; error: null; status: number } | { data: null; error: NelcotaError; status: number };

type RpcArgs<S extends GenericSchema, F> =
  ArgsOptional<FunctionArgs<S, F>> extends true
    ? [args?: FunctionArgs<S, F>, options?: RpcOptions]
    : [args: FunctionArgs<S, F>, options?: RpcOptions];

export class RestClient<S extends GenericSchema> {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** A table or view of the exposed schema. */
  from<Name extends RelationName<S>>(
    table: Name,
  ): TableRef<S, Name, RowOf<Relation<S, Name>>, InsertOf<Relation<S, Name>>, UpdateOf<Relation<S, Name>>> {
    return new TableRef(this.#http, table);
  }

  /**
   * Calls a function (`POST /rest/v1/rpc/{name}`) with named arguments. It
   * runs with the caller's role, so its GRANTs and RLS apply as usual.
   */
  async rpc<F extends FunctionName<S>>(name: F, ...rest: RpcArgs<S, F>): Promise<RpcResult<FunctionReturns<S, F>>> {
    const [args, options = {}] = rest;
    if (args !== undefined && !isRecord(args)) {
      throw new NelcotaUsageError('rpc arguments are one object of named arguments');
    }
    const result = await this.#http.json<FunctionReturns<S, F>>({
      method: 'POST',
      path: `/rest/v1/rpc/${encodeURIComponent(identifier(name, 'function'))}`,
      json: args ?? {},
      signal: options.signal,
      timeout: options.timeout,
    });
    if (result.error) return { data: null, error: result.error, status: result.error.status };
    return { data: result.data, error: null, status: result.response.status };
  }
}
