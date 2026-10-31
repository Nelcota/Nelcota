export type SessionErrorCode =
  | "configuration"
  | "invalid_session"
  | "session_store"
  | "session_capacity"
  | "read_only"
  | "csrf"
  | "closed_context";

/** Safe public classification; diagnostics never serialize credentials or causes. */
class NelcotaSessionError extends Error {
  override readonly name = "NelcotaSessionError";
  constructor(
    readonly code: SessionErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
  toJSON(): { code: SessionErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

// Before 0.2 the class (and `error.name`) was "NelcotaNextSessionError"; the
// public export has always been `SessionError`.
export { NelcotaSessionError as SessionError };
