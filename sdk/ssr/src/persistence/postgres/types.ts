/** Compatible with a dedicated node-postgres Pool; no pg runtime dependency. */
export interface SessionConnection {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(destroy?: boolean): void;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
}
export interface OwnedConnection {
  query: SessionConnection["query"];
  release: SessionConnection["release"];
  signal: AbortSignal;
}
export interface SessionPool {
  connect(): Promise<SessionConnection>;
  /** node-postgres exposes its configuration here; `max` sizes the write-lease limit. */
  readonly options?: { readonly max?: number | undefined } | undefined;
}
export interface OwnershipRequest {
  key: string;
  deadline: number;
  /** Makes retiring rotated-away rows best-effort; see `ExclusiveOptions`. */
  onRetireError?: (error: Error) => void;
  borrowed?: OwnedConnection;
}
