/**
 * Errors the client returns as values. `code` is the server's code, untouched
 * (`user_already_exists`, `invalid_grant`, `db_error`...), or one of the
 * client codes below when no response arrived.
 */

/** Codes produced by the client itself, never by the server. */
export type ClientErrorCode =
  | 'network_error'
  // Also sent by the server when a request outlives its time budget (504).
  | 'timeout'
  | 'aborted'
  | 'invalid_response'
  | 'not_single'
  | 'session_missing'
  | 'pkce_missing'
  // Statuses without a JSON error body (HEAD requests, proxies).
  | 'unauthorized'
  | 'forbidden';

/**
 * Codes the server sends today. Later server versions may add codes, so keep
 * a default branch when switching on one.
 */
export type ServerErrorCode =
  // Any route
  | 'invalid_token'
  | 'rate_limited'
  | 'unavailable'
  | 'internal'
  | 'not_found'
  | 'invalid_body'
  | 'bad_request'
  | 'method_not_allowed'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'range_not_satisfiable'
  // REST
  | 'db_error'
  | 'invalid_query'
  | 'response_too_large'
  // Auth
  | 'validation_failed'
  | 'invalid_email'
  | 'weak_password'
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'mail_busy'
  | 'user_already_exists'
  | 'user_not_found'
  | 'signup_disabled'
  | 'invalid_grant'
  | 'unsupported_grant_type'
  | 'recovery_disabled'
  | 'confirmation_disabled'
  | 'magiclink_disabled'
  | 'provider_error'
  | 'access_denied'
  | 'email_required'
  | 'email_conflict'
  | 'provider_disabled'
  | 'redirect_not_allowed'
  | 'invalid_code_challenge'
  | 'invalid_state'
  | 'bad_verification_code'
  // Storage
  | 'invalid_bucket'
  | 'bucket_exists'
  | 'bucket_not_found'
  | 'bucket_not_empty'
  | 'invalid_path'
  | 'object_exists'
  | 'object_not_found'
  | 'file_too_large'
  | 'mime_type_not_allowed'
  | 'unsupported_type'
  | 'storage_full'
  | 'invalid_expiry'
  | 'invalid_signature'
  | 'upload_busy'
  | 'upload_interrupted'
  | 'upload_timeout';

/**
 * Every code the client knows, plus any other string: autocomplete for the
 * known ones without breaking when a newer server adds a code. A response
 * without a JSON error body gets `unauthorized` (401), `forbidden` (403),
 * `not_found` (404), `rate_limited` (429), `unavailable` (503) or
 * `http_<status>` (`http_502`).
 */
export type NelcotaErrorCode = ServerErrorCode | ClientErrorCode | (string & {});

export interface NelcotaErrorInit {
  status: number;
  code: NelcotaErrorCode;
  message: string;
  retryAfter?: number | undefined;
  sqlstate?: string | undefined;
  details?: string | undefined;
  hint?: string | undefined;
  constraint?: string | undefined;
  cause?: unknown;
}

export class NelcotaError extends Error {
  override readonly name = 'NelcotaError';
  /** HTTP status, or 0 when no response arrived. */
  readonly status: number;
  readonly code: NelcotaErrorCode;
  /** Seconds to wait before retrying, from `Retry-After` (429/503). */
  readonly retryAfter: number | undefined;
  /** Postgres SQLSTATE of a `db_error` (`23505` = unique violation), when the server sends it. */
  readonly sqlstate: string | undefined;
  /** Postgres DETAIL (`Key (email)=(a@b.c) already exists.`), when the server sends it. */
  readonly details: string | undefined;
  /** Postgres HINT, when the server sends it. */
  readonly hint: string | undefined;
  /** Name of the violated constraint (`todos_title_check`), when the server sends it. */
  readonly constraint: string | undefined;

  constructor(init: NelcotaErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.status = init.status;
    this.code = init.code;
    this.retryAfter = init.retryAfter;
    this.sqlstate = init.sqlstate;
    this.details = init.details;
    this.hint = init.hint;
    this.constraint = init.constraint;
  }

  toJSON(): NelcotaErrorJson {
    const json: NelcotaErrorJson = { name: this.name, status: this.status, code: this.code, message: this.message };
    if (this.retryAfter !== undefined) json.retryAfter = this.retryAfter;
    if (this.sqlstate !== undefined) json.sqlstate = this.sqlstate;
    if (this.details !== undefined) json.details = this.details;
    if (this.hint !== undefined) json.hint = this.hint;
    if (this.constraint !== undefined) json.constraint = this.constraint;
    return json;
  }
}

export interface NelcotaErrorJson {
  retryAfter?: number;
  name: string;
  status: number;
  code: NelcotaErrorCode;
  message: string;
  sqlstate?: string;
  details?: string;
  hint?: string;
  constraint?: string;
}

/**
 * A programming mistake (an invalid column name, a `service_role` token in a
 * browser...). It is thrown, not returned: no request was sent.
 */
export class NelcotaUsageError extends TypeError {
  override readonly name = 'NelcotaUsageError';
}

export type Result<T> = { data: T; error: null } | { data: null; error: NelcotaError };

export function ok<T>(data: T): { data: T; error: null } {
  return { data, error: null };
}

export function fail(error: NelcotaError): { data: null; error: NelcotaError } {
  return { data: null, error };
}

/**
 * The data of a result, or its error thrown: for code that prefers
 * exceptions. `const user = unwrap(await nelcota.auth.getUser())`.
 */
export function unwrap<T>(result: { data: T; error: null } | { data: null; error: NelcotaError }): T {
  if (result.error) throw result.error;
  return result.data as T;
}

export function clientError(code: ClientErrorCode, message: string, cause?: unknown): NelcotaError {
  return new NelcotaError({ status: 0, code, message, cause });
}
