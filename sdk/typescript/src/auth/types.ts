import type { Result } from "../core/client.errors.js";
import type { TokenSource } from "../core/http/types.js";
/** Auth inputs and lifecycle options; no HTTP, storage effects or timers. */
import type { Session, SessionStorage } from "./session.js";

export type AuthEvent =
  | "initial_session"
  | "signed_in"
  | "signed_out"
  | "refreshed"
  | "user_updated";
/** Listener return values are ignored; rejected promises reach onBackgroundError. */
export type AuthListener = (event: AuthEvent, session: Session | null) => unknown;
export interface AuthOptions {
  /** Default: native localStorage with an IndexedDB coordination journal in browsers, memory elsewhere. */
  storage?: SessionStorage;
  /** Default: nelcota.<host><base-path>.session. */
  storageKey?: string;
  /** Refresh in the background. Default: on in browsers. */
  autoRefresh?: boolean;
  /** Refresh when fewer than this many seconds remain, capped at half the token lifetime. Default 60. */
  refreshMargin?: number;
  /** Background storage/adapter and auth listener failures. Storage failures pause refresh; listener failures do not. Handler failures are isolated. */
  onBackgroundError?: (error: unknown) => void | Promise<void>;
}
export interface AuthRequestOptions {
  signal?: AbortSignal;
  timeout?: number;
}
export type OAuthProvider = "google" | "github";
export type EmailLinkType = "recovery" | "signup" | "magiclink";

export interface Credentials {
  email: string;
  password: string;
}

export interface SignUpInput extends Credentials {
  /** Becomes `user_metadata`. Never trust it for authorization. */
  data?: Record<string, unknown>;
}

export interface UserUpdate {
  /** New password (same rules as sign-up). */
  password?: string;
  /** Required with `password` when the account already has one. */
  currentPassword?: string;
  /**
   * Merged into `user_metadata` one level deep; a key set to `null` is
   * removed. Never trust it for authorization.
   */
  data?: Record<string, unknown>;
}

export interface OAuthInput {
  provider: OAuthProvider;
  /** App page to come back to; must be allowed in NELCOTA_OAUTH_REDIRECT_URLS. */
  redirectTo: string;
  /** Navigate there right away (browsers only). Default true in browsers. */
  redirect?: boolean;
}

export interface EmailLink {
  type: EmailLinkType;
  token: string;
}

export interface SessionTransport {
  rotate: (token: string, options: AuthRequestOptions) => Promise<Result<Session>>;
  accessToken: TokenSource | undefined;
}
