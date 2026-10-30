import { SessionError } from "../errors.js";
import type { SessionState } from "../sealing/seal.js";
import { SESSION_LIMITS } from "./configuration.js";
import type { MutationOptions } from "./types.js";

export function mutationOptions(options?: MutationOptions): MutationOptions {
  if (options?.timeout === undefined) return {};
  if (
    Number.isSafeInteger(options.timeout) === false ||
    options.timeout < 100 ||
    options.timeout > SESSION_LIMITS.requestTimeoutInMs
  )
    throw new SessionError("configuration", "Mutation timeout must be between 100 and 30000 ms");
  return { timeout: options.timeout };
}

export function accessToken(state: SessionState | null): string | null {
  if (state?.session == null || state.session === "") return null;
  const value: unknown = JSON.parse(state.session);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new SessionError("invalid_session", "Invalid stored session");
  const token = (value as Record<string, unknown>)["access_token"];
  if (typeof token !== "string" || token.length === 0 || token.length > SESSION_LIMITS.tokenChars)
    throw new SessionError("invalid_session", "Invalid stored access token");
  return token;
}
