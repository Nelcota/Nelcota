/** `@nelcota/client/auth`: accounts, sessions and sign-in. */

import { createHttpClient, type TransportOptions } from "../core/options.js";
import { AuthClient, type AuthOptions } from "./client.js";

export { AuthClient } from "./client.js";
export { NelcotaError, NelcotaUsageError, unwrap } from "../core/client.errors.js";
export type { Result } from "../core/client.errors.js";
export type { TransportOptions } from "../core/options.js";
export type { FetchLike, TokenSource } from "../core/http/client.js";

export interface AuthClientOptions extends TransportOptions {
  auth?: AuthOptions;
}

/** Auth without loading REST query builders or storage. */
export function createAuthClient(url: string | URL, options: AuthClientOptions = {}): AuthClient {
  return new AuthClient(createHttpClient(url, options), options.auth);
}
export type {
  AuthRequestOptions,
  AuthEvent,
  AuthListener,
  AuthOptions,
  Credentials,
  EmailLink,
  EmailLinkType,
  OAuthInput,
  OAuthProvider,
  SignUpInput,
  UserUpdate,
} from "./client.js";
export { memoryStorage } from "./session.js";
export type { Session, SessionStorage, User } from "./session.js";
