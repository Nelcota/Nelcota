/**
 * `@nelcota/client/storage`: buckets and files, under the same RLS as the
 * tables (a row in `storage.objects` per file).
 */

import { NelcotaUsageError, clientError, fail, ok, type Result } from '../core/errors.js';
import { bucketId, folderPrefix, objectPath } from '../core/encoding.js';
import type { HttpClient, RequestSpec } from '../core/http.js';
import { createHttpClient, type TransportOptions } from '../core/options.js';
import { encodeJson } from '../core/json.js';

export { NelcotaError, NelcotaUsageError, unwrap } from '../core/errors.js';
export type { Result } from '../core/errors.js';
export type { TransportOptions } from '../core/options.js';
export type { FetchLike, TokenSource } from '../core/http.js';

/** Storage without loading REST or auth. Supply a token source for private files. */
export function createStorageClient(url: string | URL, options: TransportOptions = {}): StorageClient {
  return new StorageClient(createHttpClient(url, options));
}

export interface Bucket {
  id: string;
  public: boolean;
  file_size_limit: number | string | null;
  allowed_mime_types: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface BucketSettings {
  public?: boolean;
  /** Positive int64 bytes; use a decimal string above Number.MAX_SAFE_INTEGER. */
  file_size_limit?: number | string | null;
  /** `image/png`, `image/*`... `null` allows any type. */
  allowed_mime_types?: string[] | null;
}

/** PUT replaces every setting. Use explicit null to clear a limit. */
export type BucketUpdateSettings = Required<BucketSettings>;

export interface StoredObject {
  id: string;
  bucket: string;
  name: string;
  size: number;
  mime_type: string;
  etag: string;
  /** Present for public buckets. */
  public_url?: string;
}

export interface ListedObject {
  id: string;
  name: string;
  size: number;
  mime_type: string;
  etag: string;
  owner: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface Listing {
  folders: string[];
  objects: ListedObject[];
}

export type FileBody = Blob | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string;

export interface RequestOptions {
  signal?: AbortSignal;
  /** Timeout in ms; uploads and downloads have none by default. */
  timeout?: number;
}

export interface UploadOptions extends RequestOptions {
  /** Default: the Blob's type, else `application/octet-stream`. The server checks it against the bytes. */
  contentType?: string;
  /** Replace a file with the same name instead of failing with `object_exists`. */
  upsert?: boolean;
}

export interface OpenOptions extends RequestOptions {
  /** Bytes `start` to `end` (inclusive); answered with 206. */
  range?: { start: number; end?: number };
  /** An ETag from a previous download: 304 when the file did not change. */
  ifNoneMatch?: string;
  /** Serve as an attachment (`Content-Disposition`). */
  download?: boolean;
}

export interface ListOptions extends RequestOptions {
  /** A folder, ending in `/`. */
  prefix?: string;
  /** 1 to 1000, default 100. */
  limit?: number;
  offset?: number;
}

/** Unquote only a canonical integer at the first key; the server retains int64 validation. */
function bucketJson(settings: BucketSettings & { id?: string }): string {
  const { file_size_limit: limit, ...rest } = settings;
  return encodeJson({ file_size_limit: limit, ...rest }).replace(/^(\{"file_size_limit":)"([1-9]\d{0,18})"/, '$1$2');
}

function contentTypeOf(body: FileBody, explicit: string | undefined): string {
  if (explicit !== undefined) {
    if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(\s*;.*)?$/.test(explicit) || /[\r\n]/.test(explicit)) {
      throw new NelcotaUsageError(`Invalid content type ${JSON.stringify(explicit)}`);
    }
    return explicit;
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob && body.type) return body.type;
  if (typeof body === 'string') return 'text/plain;charset=utf-8';
  return 'application/octet-stream';
}

function rangeHeader(range: { start: number; end?: number }): string {
  const { start, end } = range;
  if (!Number.isSafeInteger(start) || start < 0 || (end !== undefined && (!Number.isSafeInteger(end) || end < start))) {
    throw new NelcotaUsageError('A range needs integers with 0 <= start <= end');
  }
  return `bytes=${start}-${end ?? ''}`;
}

/** Files of one bucket. */
export class BucketFiles {
  readonly #http: HttpClient;
  readonly #bucket: string;

  /** @internal Use `client.storage.from(bucket)`. */
  constructor(http: HttpClient, bucket: string) {
    this.#http = http;
    this.#bucket = bucketId(bucket);
  }

  #path(kind: '' | 'public/' | 'sign/', name: string): string {
    return `/storage/v1/object/${kind}${this.#bucket}/${objectPath(name)}`;
  }

  /**
   * Uploads the bytes as they are (no multipart). A `ReadableStream` is sent
   * without buffering where the runtime can stream request bodies.
   */
  async upload(name: string, body: FileBody, options: UploadOptions = {}): Promise<Result<StoredObject>> {
    const spec: RequestSpec = {
      method: options.upsert ? 'PUT' : 'POST',
      path: this.#path('', name),
      body: body as BodyInit,
      headers: { 'content-type': contentTypeOf(body, options.contentType) },
      signal: options.signal,
      timeout: options.timeout ?? 0,
    };
    const result = await this.#http.json<StoredObject>(spec);
    return result.error ? fail(result.error) : ok(result.data);
  }

  /** The whole file as a Blob. For large files, ranges or ETags use `open`. */
  async download(name: string, options: Omit<OpenOptions, 'range' | 'ifNoneMatch'> = {}): Promise<Result<Blob>> {
    return this.#http.blob(this.#openSpec(name, options));
  }

  /**
   * The raw response: stream `response.body`, read `ETag`, handle 206/304.
   * Downloads from S3 may be redirected to a presigned URL; `fetch` follows
   * it and drops the Authorization header on the way.
   */
  async open(name: string, options: OpenOptions = {}): Promise<Result<Response>> {
    const { response, error } = await this.#http.send(this.#openSpec(name, options));
    return error ? fail(error) : ok(response);
  }

  #openSpec(name: string, options: OpenOptions): RequestSpec {
    const headers: Record<string, string> = {};
    if (options.range) headers['range'] = rangeHeader(options.range);
    if (options.ifNoneMatch !== undefined) headers['if-none-match'] = options.ifNoneMatch;
    return {
      method: 'GET',
      path: this.#path('', name),
      query: options.download ? new URLSearchParams({ download: '' }) : undefined,
      headers,
      signal: options.signal,
      timeout: options.timeout ?? 0,
    };
  }

  async remove(name: string, options: RequestOptions = {}): Promise<Result<null>> {
    const { error } = await this.#http.send({
      method: 'DELETE',
      path: this.#path('', name),
      signal: options.signal,
      timeout: options.timeout,
    });
    return error ? fail(error) : ok(null);
  }

  /** Files and subfolders directly under a folder. */
  async list(options: ListOptions = {}): Promise<Result<Listing>> {
    const body: Record<string, unknown> = { prefix: folderPrefix(options.prefix ?? '') };
    if (options.limit !== undefined) body['limit'] = options.limit;
    if (options.offset !== undefined) body['offset'] = options.offset;
    const result = await this.#http.json<Listing>({
      method: 'POST',
      path: `/storage/v1/object/list/${this.#bucket}`,
      json: body,
      signal: options.signal,
      timeout: options.timeout,
    });
    return result.error ? fail(result.error) : ok(result.data);
  }

  /**
   * A URL anyone can open until it expires (1 s to 7 days), to share a
   * private file without a session. Whoever holds it can read the file.
   */
  async createSignedUrl(name: string, expiresIn: number, options: RequestOptions = {}): Promise<Result<string>> {
    if (!Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > 604_800) {
      throw new NelcotaUsageError('expiresIn is 1 to 604800 seconds');
    }
    const result = await this.#http.json<{ signed_url?: unknown }>({
      method: 'POST',
      path: this.#path('sign/', name),
      json: { expires_in: expiresIn },
      signal: options.signal,
      timeout: options.timeout,
    });
    if (result.error) return fail(result.error);
    const relative = result.data?.signed_url;
    if (typeof relative !== 'string' || !relative.startsWith('/storage/v1/object/sign/')) {
      return fail(clientError('invalid_response', 'Invalid signed URL response'));
    }
    return ok(this.#http.href(relative));
  }

  /** The URL of a file in a public bucket (no request, no expiry). */
  publicUrl(name: string): string {
    return this.#http.href(this.#path('public/', name));
  }
}

export class StorageClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  from(bucket: string): BucketFiles {
    return new BucketFiles(this.#http, bucket);
  }

  async listBuckets(options: RequestOptions = {}): Promise<Result<Bucket[]>> {
    const result = await this.#http.json<Bucket[]>({ method: 'GET', path: '/storage/v1/bucket', ...options });
    return result.error ? fail(result.error) : ok(result.data);
  }

  async getBucket(id: string, options: RequestOptions = {}): Promise<Result<Bucket>> {
    const result = await this.#http.json<Bucket>({ method: 'GET', path: `/storage/v1/bucket/${bucketId(id)}`, ...options });
    return result.error ? fail(result.error) : ok(result.data);
  }

  async createBucket(id: string, settings: BucketSettings = {}, options: RequestOptions = {}): Promise<Result<Bucket>> {
    const result = await this.#http.json<Bucket>({
      method: 'POST',
      path: '/storage/v1/bucket',
      body: bucketJson({ ...settings, id: bucketId(id) }),
      headers: { 'content-type': 'application/json' },
      ...options,
    });
    return result.error ? fail(result.error) : ok(result.data);
  }

  /** Replaces every setting; all fields are required, including explicit null limits. */
  async updateBucket(id: string, settings: BucketUpdateSettings, options: RequestOptions = {}): Promise<Result<Bucket>> {
    if (typeof settings !== 'object' || settings === null || typeof settings.public !== 'boolean'
        || settings.file_size_limit === undefined || settings.allowed_mime_types === undefined) {
      throw new NelcotaUsageError('updateBucket needs public, file_size_limit and allowed_mime_types (null clears limits)');
    }
    const result = await this.#http.json<Bucket>({
      method: 'PUT',
      path: `/storage/v1/bucket/${bucketId(id)}`,
      body: bucketJson(settings),
      headers: { 'content-type': 'application/json' },
      ...options,
    });
    return result.error ? fail(result.error) : ok(result.data);
  }

  /** Deletes an empty bucket (`bucket_not_empty` otherwise). */
  async deleteBucket(id: string, options: RequestOptions = {}): Promise<Result<null>> {
    const { error } = await this.#http.send({ method: 'DELETE', path: `/storage/v1/bucket/${bucketId(id)}`, ...options });
    return error ? fail(error) : ok(null);
  }
}
