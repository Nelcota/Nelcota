/**
 * `@nelcota/client`: a thin, typed client for a Nelcota project. Every call
 * is one HTTP request; Postgres (GRANTs and RLS) decides what it may do.
 *
 * ```ts
 * import { createClient } from '@nelcota/client';
 * import type { Database } from './database'; // nelcota types -o database.ts
 *
 * const nelcota = createClient<Database>('https://api.example.com');
 * const { data, error } = await nelcota.from('notes').select('id,body').order('id', { ascending: false });
 * ```
 */

import { AuthClient, type AuthOptions } from './auth/index.js';
import { createHttpClient, type TransportOptions } from './core/options.js';
import { RestClient } from './rest/index.js';
import type { DefaultSchemaName, SchemaOf } from './rest/types.js';
import { StorageClient } from './storage/index.js';

export interface ClientOptions<SchemaName> extends TransportOptions {
  /** Schema the types come from (the server exposes one, `public` by default). */
  schema?: SchemaName;
  auth?: AuthOptions;
}

export class NelcotaClient<Database = any, SchemaName extends string = DefaultSchemaName<Database>> extends RestClient<
  SchemaOf<Database, SchemaName>
> {
  readonly auth: AuthClient;
  readonly storage: StorageClient;
  /** The project's base URL. */
  readonly url: URL;

  constructor(url: string | URL, options: ClientOptions<SchemaName> = {}) {
    let auth: AuthClient | undefined;
    const http = createHttpClient(url, options, () => auth?.accessToken() ?? null);
    super(http);
    auth = new AuthClient(http, options.accessToken ? { ...options.auth, autoRefresh: false } : options.auth);
    this.auth = auth;
    this.storage = new StorageClient(http);
    this.url = http.url;
  }

  /** Releases auth timers and listeners; it does not sign the user out. */
  dispose(): void {
    this.auth.dispose();
  }
}

/** Creates a client. Pass the `Database` type from `nelcota types` for typed rows. */
export function createClient<Database = any, SchemaName extends string = DefaultSchemaName<Database>>(
  url: string | URL,
  options: ClientOptions<SchemaName> = {},
): NelcotaClient<Database, SchemaName> {
  return new NelcotaClient<Database, SchemaName>(url, options);
}

export type { ClientErrorCode, NelcotaErrorCode, NelcotaErrorJson, Result, ServerErrorCode } from './core/errors.js';
export type { FetchLike, TokenSource } from './core/http.js';
export type { TransportOptions } from './core/options.js';
export * from './rest/index.js';
export * from './auth/index.js';
export * from './storage/index.js';
