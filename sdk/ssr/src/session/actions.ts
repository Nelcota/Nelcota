import { SessionError } from "../errors.js";
import { SESSION_LIMITS } from "./configuration.js";
import type { AuthOperations } from "./types.js";
import type { WriteState } from "./write-state.js";

/** Serialize accepted mutations and drain them before publishing their cookie. */
export class AuthQueue {
  readonly #state: WriteState;
  #queued = 0;
  #tail: Promise<void> = Promise.resolve();
  constructor(state: WriteState) {
    this.#state = state;
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.#state.accepting === false || this.#state.alive === false)
      return Promise.reject(new SessionError("closed_context", "The request context has ended"));
    if (this.#queued >= SESSION_LIMITS.queuedActions)
      return Promise.reject(
        new SessionError("session_capacity", "Too many queued auth operations"),
      );
    this.#queued++;
    const running = this.#tail
      .then(() => {
        this.#state.ensure();
        return task();
      })
      .finally(() => {
        this.#queued--;
      });
    this.#tail = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  }

  async settle(): Promise<void> {
    await this.#tail;
  }

  actions(operations: AuthOperations): AuthOperations {
    return {
      getUser: () => this.#enqueue(() => operations.getUser()),
      signInWithPassword: (input, options) =>
        this.#enqueue(() => operations.signInWithPassword(input, options)),
      signUp: (input, options) => this.#enqueue(() => operations.signUp(input, options)),
      signOut: (options) => this.#enqueue(() => operations.signOut(options)),
      refresh: (options) => this.#enqueue(() => operations.refresh(options)),
      updateUser: (input, options) => this.#enqueue(() => operations.updateUser(input, options)),
      requestPasswordReset: (email, options) =>
        this.#enqueue(() => operations.requestPasswordReset(email, options)),
      sendMagicLink: (email, options) =>
        this.#enqueue(() => operations.sendMagicLink(email, options)),
      resendConfirmation: (email, options) =>
        this.#enqueue(() => operations.resendConfirmation(email, options)),
      startOAuth: (input) => this.#enqueue(() => operations.startOAuth(input)),
      exchangeCode: (code, options) => this.#enqueue(() => operations.exchangeCode(code, options)),
      verifyEmailLink: (input, options) =>
        this.#enqueue(() => operations.verifyEmailLink(input, options)),
      resetPassword: (input, options) =>
        this.#enqueue(() => operations.resetPassword(input, options)),
    };
  }
}
