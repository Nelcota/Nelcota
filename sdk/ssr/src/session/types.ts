import type {
  AuthRequestOptions,
  Credentials,
  DefaultSchemaName,
  FetchLike,
  NelcotaClient,
  OAuthProvider,
  Result,
  SignUpInput,
  User,
  UserUpdate,
} from "@nelcota/client";

import type { SessionStore } from "../store.js";

export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

export interface CookieWriter extends CookieReader {
  set(
    name: string,
    value: string,
    options: { path: "/"; httpOnly: true; secure: boolean; sameSite: "lax"; maxAge: number },
  ): void;
}

export interface SessionOptions {
  url: string;
  appOrigin: string;
  /** Path the app is mounted under (Next `basePath`, SvelteKit `paths.base`), e.g. '/app'; prefixes the OAuth callback. Default ''. */
  basePath?: string;
  keys: readonly string[];
  store: SessionStore;
  allowInsecureDevelopment?: boolean;
  cookieName?: string;
  sessionTtlSeconds?: number;
  timeout?: number;
  fetch?: FetchLike;
  /** Absolute origins that storage object downloads may be redirected to,
   * e.g. a presigned S3 endpoint. HTTPS only (loopback HTTP with
   * `allowInsecureDevelopment`). Unset: storage redirects are refused. */
  storageRedirectOrigins?: readonly string[];
}

export type DataClient<Database> = Pick<
  NelcotaClient<Database, DefaultSchemaName<Database>>,
  "from" | "rpc" | "storage" | "url"
>;

export interface VerifiedContext<Database> {
  client: DataClient<Database>;
  hasSession: boolean;
  /** A cookie was presented without usable state (missing, expired or unreadable). */
  staleCookie: boolean;
  /** The presented cookie belongs to an identity a later sign-in/out in this browser replaced. */
  superseded: boolean;
  getUser(this: void, options?: AuthRequestOptions): Promise<Result<User>>;
}

export type MutationOptions = Pick<AuthRequestOptions, "timeout">;

export interface AuthOperations {
  getUser(): Promise<Result<User>>;
  signInWithPassword(input: Credentials, options?: MutationOptions): Promise<Result<User>>;
  signUp(
    input: SignUpInput,
    options?: MutationOptions,
  ): Promise<Result<{ user: User; confirmationRequired: boolean }>>;
  signOut(options?: MutationOptions): Promise<Result<null>>;
  refresh(options?: MutationOptions): Promise<Result<{ user: User; expiresAt: number } | null>>;
  updateUser(input: UserUpdate, options?: MutationOptions): Promise<Result<User>>;
  requestPasswordReset(email: string, options?: MutationOptions): Promise<Result<null>>;
  sendMagicLink(email: string, options?: MutationOptions): Promise<Result<null>>;
  resendConfirmation(email: string, options?: MutationOptions): Promise<Result<null>>;
  startOAuth(input: {
    provider: OAuthProvider;
    returnTo?: string;
  }): Promise<Result<{ url: string }>>;
  exchangeCode(
    code: string,
    options?: MutationOptions,
  ): Promise<Result<{ user: User; returnTo: string }>>;
  verifyEmailLink(
    input: { type: "signup" | "magiclink"; token: string },
    options?: MutationOptions,
  ): Promise<Result<User>>;
  resetPassword(
    input: { token: string; password: string },
    options?: MutationOptions,
  ): Promise<Result<User>>;
}

export interface WritableContext<Database> {
  client: DataClient<Database>;
  auth: AuthOperations;
}
