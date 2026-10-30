/**
 * The IndexedDB journal behind native localStorage sessions. Native storage
 * visibility is not ordered by Web Locks, so every handoff is a committed
 * receipt: `ready` holds the current value, `refreshing` reserves its refresh
 * token for one owner while the rotation is in flight.
 */
import { encodeJson } from "../../core/json.js";
import { RANDOM_ID_CHARS, randomId } from "../../core/random-id.js";
import { parseSession, type Session } from "../session.js";
import { BrowserRefreshPendingError, BrowserSessionConflictError } from "./session.errors.js";
const MAX_OWNER_CHARS = 128;
/**
 * How long a foreign reservation blocks other owners. It matches the server's
 * refresh-token reuse window: after it, the reserved token is either unused
 * (and still valid) or spent beyond any retry, so waiting longer gains nothing.
 * An older reservation is abandoned (its tab closed or crashed) and taken over.
 */
export const RESERVATION_LEASE_IN_MS = 10_000;
/**
 * A ready receipt whose localStorage mirror has been missing for longer than
 * this was cleared on purpose (site data, developer tools), not caught between
 * the journal commit and the mirror write.
 */
export const MIRROR_SETTLE_IN_MS = 5_000;

type Receipt = {
  kind: "ready" | "refreshing";
  owner: string;
  value: string | null;
  revision?: string;
  /** Unix time in ms when the receipt was written; absent in older SDKs. */
  at?: number;
};
type Snapshot = { value: string | null; retainDirty: boolean };
const DATABASE = "nelcota.auth";
const STORE = "sessions";
const DEADLINE_IN_MS = 5000;

function receipt(value: unknown): Receipt {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid browser session receipt");
  const fields = value as Record<string, unknown>;
  if (validReceiptFields(fields) === false) throw new Error("Invalid browser session receipt");
  if (
    fields["revision"] !== undefined &&
    (typeof fields["revision"] !== "string" || fields["revision"].length !== RANDOM_ID_CHARS)
  )
    throw new Error("Invalid browser session revision");
  if (validReceiptTime(fields["at"]) === false)
    throw new Error("Invalid browser session receipt time");
  return value as Receipt;
}

function validReceiptTime(at: unknown): boolean {
  return at === undefined || (typeof at === "number" && Number.isFinite(at));
}

function validReceiptFields(fields: Record<string, unknown>): boolean {
  return (
    (fields["kind"] === "ready" || fields["kind"] === "refreshing") &&
    typeof fields["owner"] === "string" &&
    fields["owner"].length > 0 &&
    fields["owner"].length <= MAX_OWNER_CHARS &&
    (fields["value"] === null || typeof fields["value"] === "string")
  );
}

export class BrowserSessionState {
  readonly #owner = randomId();
  revision: string | undefined;
  pending = false;
  constructor(
    readonly key: string,
    private readonly factory: IDBFactory | undefined,
  ) {}

  async #open(): Promise<IDBDatabase> {
    const factory = this.factory;
    if (factory == null) throw new Error("IndexedDB is required for coordinated browser sessions");
    return await new Promise((resolve, reject) => {
      const request = factory.open(DATABASE, 1);
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error("Browser session storage timed out")),
        DEADLINE_IN_MS,
      );
      request.onblocked = () => fail(new Error("Browser session storage is blocked"));
      request.onerror = () => fail(request.error ?? new Error("Browser session storage failed"));
      request.onupgradeneeded = () => {
        if (settled) {
          request.transaction?.abort();
          return;
        }
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        if (request.result.objectStoreNames.contains(STORE) === false) {
          request.result.close();
          fail(new Error("Invalid browser session database"));
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(request.result);
      };
    });
  }

  async #transaction<T>(operation: (store: IDBObjectStore, previous: unknown) => T): Promise<T> {
    const database = await this.#open();
    return await new Promise((resolve, reject) => {
      const transaction = beginTransaction(database, reject);
      if (transaction === undefined) return;
      let value: T;
      let failure: unknown;
      const timer = setTimeout(() => {
        const timeoutError = new Error("Browser session transaction timed out");
        failure = timeoutError;
        try {
          transaction.abort();
        } catch {
          database.close();
          reject(timeoutError);
        }
      }, DEADLINE_IN_MS);
      transaction.oncomplete = () => {
        clearTimeout(timer);
        database.close();
        resolve(value);
      };
      transaction.onabort = () => {
        clearTimeout(timer);
        database.close();
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Forward the original adapter rejection without changing its identity.
        reject(failure ?? transaction.error ?? new Error("Browser session transaction aborted"));
      };
      try {
        const store = transaction.objectStore(STORE);
        const request = store.get(this.key);
        request.onsuccess = () => {
          try {
            value = operation(store, request.result);
          } catch (error) {
            failure = error;
            transaction.abort();
          }
        };
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    });
  }

  #record(kind: Receipt["kind"], value: string | null): Receipt & { at: number } {
    return { kind, owner: this.#owner, value, revision: randomId(), at: Date.now() };
  }

  /**
   * The authoritative value. `mirror` reads the localStorage copy: it seeds a
   * missing journal, and a settled ready session whose mirror was removed is
   * signed out. `dirty` is a publication of this client that is not persisted
   * yet; it wins while the receipt it replaced is still current.
   */
  async read(mirror: () => string | null, dirty?: string | null): Promise<Snapshot> {
    const result = await this.#transaction((store, previous) => {
      if (previous === undefined) {
        const value = dirty !== undefined ? dirty : mirror();
        const state = this.#record("ready", value);
        store.put(state, this.key);
        return {
          value,
          retainDirty: dirty !== undefined,
          revision: state.revision,
          pending: false,
        };
      }
      const state = receipt(previous);
      // Upgrade the original receipt format in the same committed transaction.
      if (state.revision === undefined) {
        state.revision = randomId();
        store.put(state, this.key);
      }
      const owned = state.owner === this.#owner;
      const retainDirty = dirty !== undefined && (owned || state.revision === this.revision);
      if (retainDirty === false && mirrorCleared(state, mirror)) {
        const cleared = this.#record("ready", null);
        store.put(cleared, this.key);
        return { value: null, retainDirty: false, revision: cleared.revision, pending: false };
      }
      // A foreign reservation does not block reads: its access token remains
      // usable until it expires. Only rotation waits for the reservation owner.
      return {
        value: retainDirty ? dirty : state.value,
        retainDirty,
        revision: state.revision,
        pending: state.kind === "refreshing",
      };
    });
    this.revision = result.revision;
    this.pending = result.pending;
    return { value: result.value, retainDirty: result.retainDirty };
  }

  /**
   * Reserves the session's refresh token for this owner before it is sent. A
   * foreign reservation younger than the lease refuses with
   * `BrowserRefreshPendingError`; an older one, or one written by an SDK
   * without receipt times, is abandoned and taken over.
   */
  async reserve(session: Session): Promise<void> {
    const next = this.#record("refreshing", encodeJson(session));
    await this.#transaction((store, previous) => {
      const state = receipt(previous);
      if (
        state.kind === "refreshing" &&
        state.owner !== this.#owner &&
        abandoned(state, next.at) === false
      )
        throw new BrowserRefreshPendingError();
      if (parseSession(state.value)?.refresh_token !== session.refresh_token)
        throw new Error("Browser session changed before refresh");
      store.put(next, this.key);
    });
    this.revision = next.revision;
  }

  async write(value: string | null, completingRefresh = false): Promise<void> {
    const next = this.#record("ready", value);
    await this.#transaction((store, previous) => {
      if (completingRefresh) {
        const state = receipt(previous);
        if (state.kind !== "refreshing" || state.owner !== this.#owner)
          throw new BrowserSessionConflictError();
      }
      store.put(next, this.key);
    });
    this.revision = next.revision;
  }

  async consume(mirror: () => string | null): Promise<string | null> {
    const next = this.#record("ready", null);
    const value = await this.#transaction((store, previous) => {
      const state = previous === undefined ? this.#record("ready", mirror()) : receipt(previous);
      if (state.kind !== "ready") throw new Error("Browser verification state is unavailable");
      store.put(next, this.key);
      return state.value;
    });
    this.revision = next.revision;
    return value;
  }
}

function abandoned(state: Receipt, now: number): boolean {
  return state.at === undefined || Math.abs(now - state.at) >= RESERVATION_LEASE_IN_MS;
}

function mirrorCleared(state: Receipt, mirror: () => string | null): boolean {
  return (
    state.kind === "ready" &&
    state.value !== null &&
    (state.at === undefined || Math.abs(Date.now() - state.at) >= MIRROR_SETTLE_IN_MS) &&
    mirror() === null
  );
}

function beginTransaction(
  database: IDBDatabase,
  reject: (reason: unknown) => void,
): IDBTransaction | undefined {
  try {
    return database.transaction(STORE, "readwrite", { durability: "strict" });
  } catch (error) {
    database.close();
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Forward the original adapter rejection without changing its identity.
    reject(error);
    return undefined;
  }
}
