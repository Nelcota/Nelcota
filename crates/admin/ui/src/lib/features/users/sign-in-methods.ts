// How an account signs in, for the users list: its password, then the
// providers linked to it (D91). An account with neither can still get in by
// an email link (magic link or recovery).

export type SignInMethod =
  | { kind: "password" }
  | { kind: "provider"; name: string }
  | { kind: "linkOnly" };

const PROVIDER_NAMES: Record<string, string> = { google: "Google", github: "GitHub" };

/** A provider's display name; unknown ones keep their id, capitalised. */
export const providerName = (id: string) =>
  PROVIDER_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

export function signInMethods(user: {
  has_password: boolean;
  providers: readonly string[];
}): SignInMethod[] {
  const methods: SignInMethod[] = [];
  if (user.has_password) methods.push({ kind: "password" });
  for (const provider of user.providers)
    methods.push({ kind: "provider", name: providerName(provider) });
  return methods.length > 0 ? methods : [{ kind: "linkOnly" }];
}
