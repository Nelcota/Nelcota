import { SessionError } from "../errors.js";
import { trustedUrl } from "../http/policy.js";
import {
  sessionConfiguration,
  SESSION_LIMITS,
  type SessionConfiguration,
} from "../session/configuration.js";
import type { SessionOptions } from "../session/types.js";
import type { SessionLease, StoredSession } from "../store.js";
import { sha256 } from "./crypto.js";
import { sessionKey, SessionSealer, type SessionState } from "./seal.js";
const SECOND_IN_MS = 1_000;
/** Rows that share one browser cookie history share a lineage record. */
export function lineageOf(key: string): Promise<string> {
  return sha256(`nelcota-next/lineage\0${key}`);
}
export interface Loaded {
  state: SessionState | null;
  /** A row existed at the key, readable or not. */
  row: boolean;
  lineage: string | null;
  /** Retired by a later identity of the same lineage (tombstone or dead session row). */
  superseded: boolean;
  tombstone: boolean;
}
export interface LineageHead {
  current: string;
  generation: number;
}
interface ReadIdentity {
  state: SessionState | null;
  hasSession: boolean;
  staleCookie: boolean;
  superseded: boolean;
  clearable: boolean;
}
function clearableCookie(id: string, loaded: Loaded | null): boolean {
  return id !== "" && (loaded === null || (loaded.row && loaded.superseded === false));
}

/** Sealed rows and lineage heads shared by read and write contexts. */
export class SessionRecords {
  static async create(options: SessionOptions): Promise<SessionRecords> {
    if (typeof (globalThis as { document?: unknown }).document !== "undefined")
      throw new SessionError("configuration", "@nelcota/ssr sessions run only on the server");
    const development = options.allowInsecureDevelopment === true;
    const namespace = `${trustedUrl(options.appOrigin, development, true).origin}\0${trustedUrl(options.url, development).href}`;
    const scope = (await sha256(namespace)).slice(0, SESSION_LIMITS.scopeDigestChars);
    const copied = { ...options };
    const sealer = await SessionSealer.create(options.keys);
    return new SessionRecords(sessionConfiguration(copied, scope), sealer);
  }
  readonly config: SessionConfiguration;
  readonly sealer: SessionSealer;
  constructor(config: SessionConfiguration, sealer: SessionSealer) {
    this.config = config;
    this.sealer = sealer;
  }

  binding(key: string): string {
    return `nelcota-next/v1\0${this.config.origin}\0${this.config.api.href}\0${key}`;
  }
  lineageBinding(lineage: string): string {
    return `nelcota-next/lineage/v1\0${this.config.origin}\0${this.config.api.href}\0${lineage}`;
  }
  /** Unreadable rows (lost keys, tampering, mismatched expiry) count as signed out.
   * A session-bearing row is live only while its lineage head names its key and
   * generation; otherwise a later sign-in/out in the same browser replaced it.
   */
  async load(key: string, lease?: SessionLease): Promise<Loaded> {
    const row = await this.#readStored(() =>
      lease != null ? lease.load() : this.config.options.store.read(key),
    );
    const unusable: Loaded = {
      state: null,
      row: row !== null,
      lineage: null,
      superseded: false,
      tombstone: false,
    };
    if (row == null) return unusable;
    let state: SessionState;
    try {
      state = await this.sealer.open(row.sealed, this.binding(key));
    } catch (cause) {
      if (cause instanceof SessionError === false) throw cause;
      return unusable;
    }
    // Expired after the store check, unreadable or mismatched: all are no session.
    if (row.expiresAt !== state.expiresAt) return unusable;
    return await this.#liveState(key, state, lease);
  }
  async #liveState(key: string, state: SessionState, lease?: SessionLease): Promise<Loaded> {
    const lineage = state.lineage ?? null;
    if (state.superseded)
      return { state: null, row: true, lineage, superseded: true, tombstone: true };
    if (state.session !== null && lineage !== null && state.generation !== undefined) {
      const head = await this.head(lineage, undefined, lease);
      if (head?.current !== key || head.generation !== state.generation)
        return { state: null, row: true, lineage, superseded: true, tombstone: false };
    }
    return { state, row: true, lineage, superseded: false, tombstone: false };
  }
  async readIdentity(id: string): Promise<ReadIdentity> {
    const key = await sessionKey(id, this.config.namespace);
    const loaded = key !== null && key !== "" ? await this.load(key) : null;
    const state = loaded?.state ?? null;
    return {
      state,
      hasSession: state?.session != null,
      staleCookie: id !== "" && state === null,
      superseded: loaded?.superseded === true,
      clearable: state === null && clearableCookie(id, loaded),
    };
  }
  /** A missing or unreadable head fails closed: no generation of that lineage is live. */
  async head(
    lineage: string,
    lease?: SessionLease,
    parent?: SessionLease,
  ): Promise<LineageHead | null> {
    const row = await this.#readStored(() => {
      if (lease != null) return lease.load();
      if (parent?.read != null) return parent.read(lineage);
      return this.config.options.store.read(lineage);
    });
    if (row == null) return null;
    let value: Record<string, unknown>;
    try {
      value = await this.sealer.openRecord(row.sealed, this.lineageBinding(lineage));
    } catch (cause) {
      if (cause instanceof SessionError === false) throw cause;
      return null;
    }
    const current = value["current"],
      generation = value["generation"];
    if (
      value["kind"] !== "lineage" ||
      typeof current !== "string" ||
      /^[a-f0-9]{64}$/.test(current) === false ||
      typeof generation !== "number" ||
      Number.isSafeInteger(generation) === false ||
      generation < 1
    )
      return null;
    return { current, generation };
  }
  async #readStored(read: () => Promise<StoredSession | null>): Promise<StoredSession | null> {
    try {
      return await read();
    } catch (cause) {
      if (cause instanceof SessionError) throw cause;
      throw new SessionError("session_store", "Session storage is unavailable", cause);
    }
  }
  /** Credential-free marker that keeps a retired key linked to its lineage. */
  async tombstone(key: string, lineage: string): Promise<StoredSession> {
    const expiresAt = Date.now() + this.config.ttl * SECOND_IN_MS;
    return {
      sealed: await this.sealer.seal(
        {
          schema: 1,
          session: null,
          pkce: null,
          oauthState: null,
          returnTo: "/",
          expiresAt,
          lineage,
          superseded: true,
        },
        this.binding(key),
      ),
      expiresAt,
    };
  }
  /** Replaces a superseded session row (an orphan) with a tombstone under its own lock. */
  async retire(key: string): Promise<void> {
    await this.config.options.store.exclusive(key, async (lease) => {
      const loaded = await this.load(key, lease);
      if (loaded.superseded === false || loaded.tombstone || loaded.lineage === null) return;
      await lease.save(await this.tombstone(key, loaded.lineage));
    });
  }
}
