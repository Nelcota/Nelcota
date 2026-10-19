/** Transfers for one bucket; streaming and response ownership stay together. */
import { NelcotaUsageError, clientError, fail, ok, type Result } from '../core/errors.js';
import { bucketId, folderPrefix, objectPath } from '../core/encoding.js';
import type { HttpClient, RequestSpec } from '../core/http.js';
import type { FileBody, Listing, ListOptions, OpenOptions, RequestOptions, StoredObject, UploadOptions } from './types.js';

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
