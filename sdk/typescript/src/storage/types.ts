/** Storage wire values and request options; no runtime dependencies. */

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
