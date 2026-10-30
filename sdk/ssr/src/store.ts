/** Opaque encrypted state. Implementations must never interpret auth credentials. */
export interface StoredSession {
  sealed: string;
  expiresAt: number;
}

/** A linearizable, live owner; every save must be durable before resolving. */
export interface SessionLease {
  /** Aborts when ownership ends; late auth/data operations must stop. */
  readonly signal: AbortSignal;
  /** Epoch ms by which an auth request must end so its result can still be
   * saved inside this lease; Infinity when the store has no lease deadline.
   */
  readonly deadline: number;
  /** Reads a related record using this owner's connection when supported.
   * @remarks
   * Avoids borrowing another pooled connection while this lease owns one.
   */
  read?(key: string): Promise<StoredSession | null>;
  /** Acquires nested ownership using this owner's connection when supported.
   * @remarks
   * Keep a consistent lock order and finish the nested owner before taking other
   * locks through this lease; saving this lease's own row meanwhile is allowed (a
   * sign-in writes its new row under the lineage lock, before moving the head).
   * Nested ownership ends when the parent ends, including on failure.
   */
  exclusive?<T>(key: string, work: (lease: SessionLease) => Promise<T>): Promise<T>;
  load(): Promise<StoredSession | null>;
  save(value: StoredSession): Promise<void>;
  remove(): Promise<void>;
  /** Owns a fresh, never-published key until this lease ends and directs later
   * load/save/remove calls to it. The previous row is left untouched while the
   * callback runs; only when the callback succeeds is it replaced with `retain` (a
   * credential-free tombstone) or removed when `retain` is omitted, before the
   * lease releases. A failed callback leaves it as it was. `retain` has the same
   * bounds as `save`.
   */
  rotate(key: string, retain?: StoredSession): Promise<void>;
}

export interface SessionStore {
  /** Memory stores cannot be selected accidentally in production. */
  readonly durability: "shared" | "development";
  read(key: string): Promise<StoredSession | null>;
  /** Serialize the entire async callback for this key across all app instances.
   * No TTL-only lease: stale owners must be unable to save after ownership loss.
   * Keep writes durable individually, including PKCE consumption before HTTP.
   * Close the lease before releasing ownership, even when the callback throws.
   */
  exclusive<T>(key: string, work: (lease: SessionLease) => Promise<T>): Promise<T>;
}
