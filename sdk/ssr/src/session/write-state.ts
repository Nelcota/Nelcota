import type { SessionStorage } from "@nelcota/client";

import { SessionError } from "../errors.js";
import { promiseResult } from "../lifecycle/promise-result.js";
import { fromBase64url } from "../sealing/crypto.js";
import { lineageOf, type Loaded, type SessionRecords } from "../sealing/records.js";
import { newSessionId, sessionKey, type SessionState } from "../sealing/seal.js";
import type { SessionLease } from "../store.js";

const SECOND_IN_MS = 1_000;
interface WriteInput {
  id: string;
  initialKey: string;
  existingId: string;
  presented: boolean;
  callbackRequest: boolean;
  /** Lineage heads this write replaced; retired after the lease succeeds. */
  retired: Set<string>;
  /** Stored sessions (JSON) an identity change replaced; revoked upstream after success. */
  replaced: string[];
}

/**
 * The upstream `session_id` claim of a stored session's access token, read
 * without verification (the token only identifies which session to compare),
 * or `null` when the value carries none.
 */
function upstreamSessionId(stored: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) return null;
    const token = (parsed as { access_token?: unknown }).access_token;
    if (typeof token !== "string") return null;
    const payload = token.split(".")[1];
    if (payload === undefined) return null;
    const claims: unknown = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
    if (typeof claims !== "object" || claims === null) return null;
    const id = (claims as { session_id?: unknown }).session_id;
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    return null;
  }
}

/**
 * Whether two stored sessions belong to the same upstream session. Refreshed
 * tokens and re-saved user data change the stored JSON but not the session, so
 * the access tokens' `session_id` claims decide; only when either lacks one
 * does the stored value itself.
 */
function sameUpstreamSession(previous: string, next: string): boolean {
  const before = upstreamSessionId(previous),
    after = upstreamSessionId(next);
  return before !== null && after !== null ? before === after : previous === next;
}

/** Mutable state belongs to one store lease and is never shared across requests. */
export class WriteState {
  readonly records: SessionRecords;
  readonly lease: SessionLease;
  readonly input: WriteInput;
  readonly loaded: Loaded;
  readonly lineage: string;
  readonly clearPresented: boolean;
  readonly storageKey: string;
  readonly publication = { failed: false, cookieNeeded: false };
  id: string;
  key: string;
  state: SessionState | null;
  generation: number | null;
  alive = true;
  accepting = true;
  identityMutation = false;
  published: boolean;

  private constructor(
    records: SessionRecords,
    lease: SessionLease,
    setup: { input: WriteInput; loaded: Loaded; lineage: string },
  ) {
    this.records = records;
    this.lease = lease;
    this.input = setup.input;
    this.loaded = setup.loaded;
    this.lineage = setup.lineage;
    this.id = setup.input.id;
    this.key = setup.input.initialKey;
    this.state = setup.loaded.state;
    this.generation = this.state?.session != null ? (this.state.generation ?? null) : null;
    this.published = this.id === setup.input.existingId;
    this.clearPresented =
      setup.input.existingId !== "" &&
      (setup.input.presented === false || (setup.loaded.row && setup.loaded.superseded === false));
    // Frozen: the in-request storage key name predates the neutral package name.
    this.storageKey = `nelcota-next.${setup.input.initialKey}.session`;
  }

  static async create(
    records: SessionRecords,
    lease: SessionLease,
    input: WriteInput,
  ): Promise<WriteState> {
    const loaded = await records.load(input.initialKey, lease);
    const lineage = loaded.lineage ?? (await lineageOf(input.initialKey));
    const state = new WriteState(records, lease, { input, loaded, lineage });
    // Unknown and superseded IDs move to a fresh unpublished row before accepting credentials.
    if (state.state === null && state.published) await state.rotate(loaded.superseded);
    return state;
  }

  ensure(): void {
    if (this.alive === false || this.publication.failed || this.lease.signal.aborted)
      throw new SessionError("closed_context", "The session context is no longer writable");
  }

  mutate(): void {
    this.ensure();
    if (this.input.callbackRequest)
      throw new SessionError("csrf", "OAuth callbacks only permit code exchange");
  }

  stopAccepting(): void {
    this.accepting = false;
  }
  close(): void {
    this.alive = false;
  }
  markPublicationFailed(): void {
    this.publication.failed = true;
  }
  async publishGeneration(): Promise<void> {
    this.generation = await this.register();
    this.publication.cookieNeeded = true;
  }
  async identity<T>(operation: () => Promise<T>): Promise<T> {
    this.identityMutation = true;
    try {
      return await operation();
    } finally {
      this.identityMutation = false;
    }
  }

  async rotate(retain: boolean): Promise<void> {
    const id = newSessionId();
    const key = await sessionKey(id, this.records.config.namespace);
    if (key === null || key === "")
      throw new SessionError("invalid_session", "Invalid generated session id");
    try {
      await this.lease.rotate(
        key,
        retain ? await this.records.tombstone(this.key, this.lineage) : undefined,
      );
      this.id = id;
      this.key = key;
      this.published = false;
    } catch (cause) {
      this.publication.failed = true;
      throw new SessionError("session_store", "Session publication failed", cause);
    }
  }

  /** Moves the lineage head to this key. `beforePublish` runs under the lineage
   * lock with the new generation, so the new row is durable before the head names
   * it; the rotated-away row is replaced only when the whole lease succeeds. */
  async register(beforePublish?: (generation: number) => Promise<void>): Promise<number> {
    this.ensure();
    try {
      const store = this.records.config.options.store;
      const exclusive = this.lease.exclusive?.bind(this.lease) ?? store.exclusive.bind(store);
      return await exclusive(this.lineage, async (owner) => {
        const head = await this.records.head(this.lineage, owner);
        const generation = (head?.generation ?? 0) + 1;
        if (beforePublish !== undefined) await beforePublish(generation);
        const expiresAt = Date.now() + this.records.config.ttl * SECOND_IN_MS;
        await owner.save({
          sealed: await this.records.sealer.seal(
            { kind: "lineage", current: this.key, generation },
            this.records.lineageBinding(this.lineage),
          ),
          expiresAt,
        });
        if (head != null && head.current !== this.key && head.current !== this.input.initialKey)
          this.input.retired.add(head.current);
        return generation;
      });
    } catch (cause) {
      this.publication.failed = true;
      throw new SessionError("session_store", "Session publication failed", cause);
    }
  }

  async save(value: SessionState): Promise<void> {
    this.ensure();
    const next: SessionState = { ...value, lineage: this.lineage };
    try {
      await this.lease.save({
        sealed: await this.records.sealer.seal(next, this.records.binding(this.key)),
        expiresAt: next.expiresAt,
      });
      this.state = next;
      this.publication.cookieNeeded = true;
    } catch (cause) {
      this.publication.failed = true;
      throw new SessionError("session_store", "Session publication failed", cause);
    }
  }

  get storage(): SessionStorage {
    return {
      getItem: (name) => promiseResult(() => this.#storedItem(name)),
      setItem: (name, value) => this.#storeItem(name, value),
      removeItem: (name) => this.#removeItem(name),
    };
  }

  #storedItem(name: string): string | null {
    this.ensure();
    if (name === this.storageKey) return this.state?.session ?? null;
    if (name === `${this.storageKey}.pkce`) return this.state?.pkce ?? null;
    if (name === `${this.storageKey}.signup`) return this.state?.signupPkce ?? null;
    throw new SessionError("session_store", "Unexpected session storage key");
  }

  #nextState(): SessionState {
    if (this.state !== null) {
      const { schema, session, pkce, signupPkce, oauthState, returnTo, expiresAt, generation } =
        this.state;
      const next: SessionState = { schema, session, pkce, oauthState, returnTo, expiresAt };
      if (generation !== undefined) next.generation = generation;
      if (signupPkce != null) next.signupPkce = signupPkce;
      return next;
    }
    const state: SessionState = {
      schema: 1,
      session: null,
      pkce: null,
      oauthState: null,
      returnTo: "/",
      expiresAt: Date.now() + this.records.config.ttl * SECOND_IN_MS,
    };
    return state;
  }

  async #storeItem(name: string, value: string): Promise<void> {
    this.ensure();
    const next = this.#nextState();
    if (name === this.storageKey && this.identityMutation && this.published) {
      this.ensure();
      await this.rotate(true);
    }
    if (name === this.storageKey) await this.#acceptSession(next, value);
    else if (name === `${this.storageKey}.pkce`) await this.save({ ...next, pkce: value });
    else if (name === `${this.storageKey}.signup`) await this.save({ ...next, signupPkce: value });
    else throw new SessionError("session_store", "Unexpected session storage key");
  }

  async #acceptSession(next: SessionState, value: string): Promise<void> {
    if (this.identityMutation === false) {
      await this.save({ ...next, session: value });
      return;
    }
    const expiresAt = Date.now() + this.records.config.ttl * SECOND_IN_MS;
    const previous = this.state?.session ?? null;
    this.generation = await this.register(async (generation) => {
      await this.save({
        ...next,
        session: value,
        expiresAt,
        pkce: null,
        oauthState: null,
        generation,
      });
    });
    // A different upstream session replaced a live one: end it after success.
    if (previous !== null && sameUpstreamSession(previous, value) === false)
      this.input.replaced.push(previous);
  }

  async #removeItem(name: string): Promise<void> {
    this.ensure();
    if (this.state === null) return;
    if (name === `${this.storageKey}.signup`) {
      if (this.state.signupPkce != null) await this.save({ ...this.state, signupPkce: null });
      return;
    }
    if (name !== this.storageKey && name !== `${this.storageKey}.pkce`)
      throw new SessionError("session_store", "Unexpected session storage key");
    await this.save({
      ...this.state,
      session: name === this.storageKey ? null : this.state.session,
      pkce: name === `${this.storageKey}.pkce` ? null : this.state.pkce,
      oauthState: name === `${this.storageKey}.pkce` ? null : this.state.oauthState,
    });
  }
}
