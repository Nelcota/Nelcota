import { encodeJson } from "../../core/json.js";
import { BrowserSessionConflictError } from "../browser/session.errors.js";
import type { Session, User } from "../session.js";
import type { SessionStore } from "../store.js";
import type { AuthEvent } from "../types.js";
import type { SessionBackground } from "./background.js";
interface PublicationContext {
  store: SessionStore;
  lifecycle: SessionBackground;
  locked: <T>(task: () => Promise<T>) => Promise<T>;
}
/** Persist and announce exactly the session accepted under the lifecycle lock. */
export class SessionPublication {
  constructor(private readonly context: PublicationContext) {}

  async reload(event?: AuthEvent, revision?: string): Promise<void> {
    const store = this.context.store;
    await this.context.locked(async () => {
      if (store.dirty && store.journaled === false) return;
      const before = store.session;
      const after = await store.read(true);
      const announcement = revision === store.journalRevision ? event : undefined;
      this.context.lifecycle.schedule(store.dirty ? null : after);
      if (before !== undefined && encodeJson(before) === encodeJson(after)) return;
      if (after === null) {
        if (before != null || announcement === "signed_out")
          this.context.lifecycle.emit("signed_out", null);
        return;
      }
      this.context.lifecycle.emit(publicationEvent(before, after, announcement), after);
    });
  }
  async write(session: Session | null, event: AuthEvent, completingRefresh = false): Promise<void> {
    let announcement = event;
    const store = this.context.store;
    const encoded = encodeJson(session);
    store.adopt(session);
    this.context.lifecycle.schedule(null);
    try {
      await this.persist(encoded, completingRefresh, event);
      this.context.lifecycle.schedule(session);
    } catch (error) {
      if (error instanceof BrowserSessionConflictError) {
        announcement = await this.#adoptAuthoritativeSession();
      }
      throw error;
    } finally {
      this.context.lifecycle.emit(announcement, store.session ?? null);
    }
  }
  async #adoptAuthoritativeSession(): Promise<AuthEvent> {
    const store = this.context.store;
    // The response lost ownership: never announce its discarded session.
    store.discard();
    try {
      await store.read(true);
    } catch {
      /* Keep local state cleared if the authoritative read fails. */
    }
    this.context.lifecycle.schedule(store.session ?? null);
    return store.session != null ? "signed_in" : "signed_out";
  }
  async persist(encoded?: string, completingRefresh = false, event?: AuthEvent): Promise<void> {
    await this.context.store.persist(encoded, completingRefresh);
    this.context.lifecycle.notify(event, this.context.store.journalRevision);
  }
  rememberUser(snapshot: Session): (user: User) => Promise<void> {
    const store = this.context.store;
    const encoded = encodeJson(snapshot);
    const revision =
      store.session !== null &&
      store.session !== undefined &&
      encodeJson(store.session) === encoded &&
      store.revision;
    return (user) =>
      this.context.locked(async () => {
        const current = await store.read(true);
        if (
          current == null ||
          revision !== store.revision ||
          encodeJson(current) !== encoded ||
          encodeJson(current.user) === encodeJson(user)
        )
          return;
        await this.write({ ...current, user }, "user_updated");
      });
  }
}

function inferredEvent(before: Session | null | undefined, after: Session): AuthEvent {
  if (before == null || before.user.id !== after.user.id) return "signed_in";
  return before.refresh_token !== after.refresh_token ? "refreshed" : "user_updated";
}

function publicationEvent(
  before: Session | null | undefined,
  after: Session,
  announcement?: AuthEvent,
): AuthEvent {
  if (before != null && before.user.id !== after.user.id) return "signed_in";
  return announcement ?? inferredEvent(before, after);
}
