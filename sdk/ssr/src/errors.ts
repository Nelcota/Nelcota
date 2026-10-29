export type SessionErrorCode =
  | "configuration"
  | "invalid_session"
  | "session_store"
  | "session_capacity"
  | "read_only"
  | "csrf"
  | "closed_context";

/** Safe public classification; diagnostics never serialize credentials or causes. */
class NelcotaNextSessionError extends Error {
  override readonly name = "NelcotaNextSessionError";
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

export { NelcotaNextSessionError as SessionError };
