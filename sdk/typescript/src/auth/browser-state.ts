/** Native storage visibility is not ordered by Web Locks. Commit the handoff. */
import { parseSession, type Session } from './session.js';
import { encodeJson } from '../core/json.js';
import { createVerifier } from './pkce.js';

type Receipt = { kind: 'ready' | 'refreshing'; owner: string; value: string | null; revision?: string };
type Snapshot = { value: string | null; retainDirty: boolean };
const DATABASE = 'nelcota.auth';
const STORE = 'sessions';
const DEADLINE = 5000;

export class BrowserSessionConflictError extends Error {
  constructor() { super('Browser session changed during refresh'); }
}

function receipt(value: unknown): Receipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid browser session receipt');
  const fields = value as Record<string, unknown>;
  if ((fields['kind'] !== 'ready' && fields['kind'] !== 'refreshing') || typeof fields['owner'] !== 'string' || fields['owner'].length === 0 || fields['owner'].length > 128 || !(fields['value'] === null || typeof fields['value'] === 'string')) throw new Error('Invalid browser session receipt');
  if (fields['revision'] !== undefined && (typeof fields['revision'] !== 'string' || fields['revision'].length !== 64)) throw new Error('Invalid browser session revision');
  return value as Receipt;
}

export class BrowserSessionState {
  readonly #owner = createVerifier();
  revision: string | undefined;
  constructor(readonly key: string, private readonly factory: IDBFactory | undefined) {}

  async #open(): Promise<IDBDatabase> {
    if (!this.factory) throw new Error('IndexedDB is required for coordinated browser sessions');
    return new Promise((resolve, reject) => {
      const request = this.factory!.open(DATABASE, 1);
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(error);
      };
      const timer = setTimeout(() => fail(new Error('Browser session storage timed out')), DEADLINE);
      request.onblocked = () => fail(new Error('Browser session storage is blocked'));
      request.onerror = () => fail(request.error ?? new Error('Browser session storage failed'));
      request.onupgradeneeded = () => {
        if (settled) { request.transaction?.abort(); return; }
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.close(); fail(new Error('Invalid browser session database')); return;
        }
        settled = true; clearTimeout(timer); resolve(request.result);
      };
    });
  }

  async #transaction<T>(operation: (store: IDBObjectStore, previous: unknown) => T): Promise<T> {
    const database = await this.#open();
    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction;
      try { transaction = database.transaction(STORE, 'readwrite', { durability: 'strict' }); }
      catch (error) { database.close(); reject(error); return; }
      let value: T;
      let failure: unknown;
      const timer = setTimeout(() => {
        failure = new Error('Browser session transaction timed out');
        try { transaction.abort(); }
        catch { database.close(); reject(failure); }
      }, DEADLINE);
      transaction.oncomplete = () => { clearTimeout(timer); database.close(); resolve(value); };
      transaction.onabort = () => { clearTimeout(timer); database.close(); reject(failure ?? transaction.error ?? new Error('Browser session transaction aborted')); };
      try {
        const store = transaction.objectStore(STORE);
        const request = store.get(this.key);
        request.onsuccess = () => {
          try { value = operation(store, request.result); }
          catch (error) { failure = error; transaction.abort(); }
        };
      }
      catch (error) { failure = error; transaction.abort(); }
    });
  }

  #record(kind: Receipt['kind'], value: string | null): Receipt {
    return { kind, owner: this.#owner, value, revision: createVerifier() };
  }

  async read(legacy: () => string | null, dirty?: string | null, allowPending = false): Promise<Snapshot> {
    const result = await this.#transaction((store, previous) => {
      if (previous === undefined) {
        const value = dirty !== undefined ? dirty : legacy();
        const state = this.#record('ready', value);
        store.put(state, this.key);
        return { value, retainDirty: dirty !== undefined, revision: state.revision };
      }
      const state = receipt(previous);
      // Upgrade the original receipt format in the same committed transaction.
      if (state.revision === undefined) {
        state.revision = createVerifier();
        store.put(state, this.key);
      }
      const owned = state.owner === this.#owner;
      const retainDirty = dirty !== undefined && (owned || state.revision === this.revision);
      if (state.kind === 'refreshing' && !owned && !allowPending && !retainDirty) throw new Error('Browser session refresh was interrupted; sign in again');
      return { value: retainDirty ? dirty : state.value, retainDirty, revision: state.revision };
    });
    this.revision = result.revision;
    return { value: result.value, retainDirty: result.retainDirty };
  }

  async reserve(session: Session): Promise<void> {
    const next = this.#record('refreshing', encodeJson(session));
    await this.#transaction((store, previous) => {
      const state = receipt(previous);
      if (state.kind === 'refreshing' && state.owner !== this.#owner) throw new Error('Browser session refresh was interrupted; sign in again');
      if (state.kind === 'ready' && parseSession(state.value)?.refresh_token !== session.refresh_token) throw new Error('Browser session changed before refresh');
      store.put(next, this.key);
    });
    this.revision = next.revision;
  }

  async write(value: string | null, completingRefresh = false): Promise<void> {
    const next = this.#record('ready', value);
    await this.#transaction((store, previous) => {
      if (completingRefresh) {
        const state = receipt(previous);
        if (state.kind !== 'refreshing' || state.owner !== this.#owner) throw new BrowserSessionConflictError();
      }
      store.put(next, this.key);
    });
    this.revision = next.revision;
  }

  async consume(legacy: () => string | null): Promise<string | null> {
    const next = this.#record('ready', null);
    const value = await this.#transaction((store, previous) => {
      const state = previous === undefined ? this.#record('ready', legacy()) : receipt(previous);
      if (state.kind !== 'ready') throw new Error('Browser verification state is unavailable');
      store.put(next, this.key);
      return state.value;
    });
    this.revision = next.revision;
    return value;
  }
}
