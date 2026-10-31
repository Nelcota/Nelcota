/** `@nelcota/client/storage`: bucket administration and standalone composition. */
import { fail, ok, type Result } from "../core/client.errors.js";
import { bucketId } from "../core/encoding.js";
import type { HttpClient, RequestSpec } from "../core/http/client.js";
import { encodeJson } from "../core/json.js";
import { createHttpClient, type TransportOptions } from "../core/options.js";
import { BucketFiles } from "./files.js";
import { requireCompleteSettings } from "./input.js";
import type { Bucket, BucketSettings, BucketUpdateSettings, RequestOptions } from "./types.js";
import { item, items } from "./validation.js";

export { NelcotaError, NelcotaUsageError, unwrap } from "../core/client.errors.js";
export type { Result } from "../core/client.errors.js";
export type { TransportOptions } from "../core/options.js";
export type { FetchLike, TokenSource } from "../core/http/client.js";
export { BucketFiles } from "./files.js";
export type {
  Bucket,
  BucketSettings,
  BucketUpdateSettings,
  FileBody,
  ListedObject,
  Listing,
  ListOptions,
  OpenOptions,
  RequestOptions,
  StoredObject,
  UploadOptions,
} from "./types.js";

/** Storage without loading REST or auth. Supply a token source for private files. */
export function createStorageClient(
  url: string | URL,
  options: TransportOptions = {},
): StorageClient {
  return new StorageClient(createHttpClient(url, options));
}

const CANONICAL_INT64 = /^[1-9]\d{0,18}$/;

/**
 * The settings object, written field by field. A canonical decimal string
 * limit is sent as a JSON integer, so limits beyond Number.MAX_SAFE_INTEGER
 * stay exact; the server keeps its int64 range check.
 */
function bucketJson(settings: BucketSettings & { id?: string }): string {
  const fields: string[] = [];
  const field = (name: string, value: unknown): void => {
    if (value !== undefined) fields.push(`${encodeJson(name)}:${encodeJson(value)}`);
  };
  field("id", settings.id);
  field("public", settings.public);
  const limit = settings.file_size_limit;
  if (typeof limit === "string" && CANONICAL_INT64.test(limit))
    fields.push(`"file_size_limit":${limit}`);
  else field("file_size_limit", limit);
  field("allowed_mime_types", settings.allowed_mime_types);
  return `{${fields.join(",")}}`;
}

/** Only the transport options a caller may set; never headers, auth or validation. */
function transport(options: RequestOptions): Pick<RequestSpec, "signal" | "timeout"> {
  return { signal: options.signal, timeout: options.timeout };
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
    const result = await this.#http.json<Bucket[]>({
      method: "GET",
      path: "/storage/v1/bucket",
      ...transport(options),
      validate: items,
    });
    return result.error != null ? fail(result.error) : ok(result.data);
  }

  async getBucket(id: string, options: RequestOptions = {}): Promise<Result<Bucket>> {
    const result = await this.#http.json<Bucket>({
      method: "GET",
      path: `/storage/v1/bucket/${bucketId(id)}`,
      ...transport(options),
      validate: item,
    });
    return result.error != null ? fail(result.error) : ok(result.data);
  }

  async createBucket(
    id: string,
    settings: BucketSettings = {},
    options: RequestOptions = {},
  ): Promise<Result<Bucket>> {
    const result = await this.#http.json<Bucket>({
      method: "POST",
      path: "/storage/v1/bucket",
      body: bucketJson({ ...settings, id: bucketId(id) }),
      headers: { "content-type": "application/json" },
      ...transport(options),
      validate: item,
    });
    return result.error != null ? fail(result.error) : ok(result.data);
  }

  /** Replaces every setting; all fields are required, including explicit null limits. */
  async updateBucket(
    id: string,
    settings: BucketUpdateSettings,
    options: RequestOptions = {},
  ): Promise<Result<Bucket>> {
    requireCompleteSettings(settings);
    const result = await this.#http.json<Bucket>({
      method: "PUT",
      path: `/storage/v1/bucket/${bucketId(id)}`,
      body: bucketJson(settings),
      headers: { "content-type": "application/json" },
      ...transport(options),
      validate: item,
    });
    return result.error != null ? fail(result.error) : ok(result.data);
  }

  /** Deletes an empty bucket (`bucket_not_empty` otherwise). */
  async deleteBucket(id: string, options: RequestOptions = {}): Promise<Result<null>> {
    const { error } = await this.#http.send({
      method: "DELETE",
      path: `/storage/v1/bucket/${bucketId(id)}`,
      ...transport(options),
    });
    return error != null ? fail(error) : ok(null);
  }
}
