import { SessionError } from "../../errors.js";
import { boundedOperation } from "./deadlines.js";
import type { OwnedConnection, SessionConnection, SessionPool } from "./types.js";

const MAX_CONNECTIONS = 32;

/** Count pending and borrowed connections together, including late pool resolutions. */
export class SessionConnections {
  readonly #pool: SessionPool;
  readonly timeout: number;
  readonly leaseTimeout: number;
  #connecting = 0;
  #borrowed = 0;
  constructor(pool: SessionPool, timeout: number, leaseTimeout: number) {
    this.#pool = pool;
    this.timeout = timeout;
    this.leaseTimeout = leaseTimeout;
  }

  #accepted(client: SessionConnection): OwnedConnection {
    this.#connecting--;
    this.#borrowed++;
    let released = false;
    const connection = new AbortController();
    const lost = (): void => connection.abort();
    client.on("error", lost);
    return {
      signal: connection.signal,
      query: (text, values) => {
        if (connection.signal.aborted)
          return Promise.reject(new SessionError("session_store", "Session connection was lost"));
        return client.query(text, values);
      },
      release: (destroy) => {
        if (released)
          throw new SessionError("closed_context", "Session connection already released");
        released = true;
        this.#borrowed--;
        const destroyed = destroy === true || connection.signal.aborted;
        // Observe terminal FATAL errors from destroyed clients until the connection ends.
        try {
          client.release(destroyed);
        } finally {
          if (destroyed === false) client.removeListener("error", lost);
        }
      },
    };
  }

  async connect(timeout: number = this.timeout): Promise<OwnedConnection> {
    if (this.#connecting + this.#borrowed >= MAX_CONNECTIONS)
      throw new SessionError("session_capacity", "Session store connection capacity reached");
    this.#connecting++;
    let connect: Promise<SessionConnection>;
    try {
      connect = this.#pool.connect();
    } catch (cause) {
      this.#connecting--;
      throw new SessionError("session_store", "Session connection failed", cause);
    }
    const pending = connect.then(
      (client) => this.#accepted(client),
      (error: unknown) => {
        this.#connecting--;
        // oxlint-disable-next-line typescript/only-throw-error -- Preserve the pool adapter's original rejection identity.
        throw error;
      },
    );
    try {
      return await boundedOperation(pending, Math.min(timeout, this.timeout));
    } catch (cause) {
      // A late borrow remains counted until it settles, then is destroyed.
      void pending.then(
        (client) => client.release(true),
        () => undefined,
      );
      throw new SessionError("session_store", "Session connection failed", cause);
    }
  }
}
