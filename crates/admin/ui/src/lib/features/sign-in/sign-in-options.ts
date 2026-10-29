// How the app's users can sign in, read from the server's settings. Each way
// says whether it is on and which environment variables change that: they live
// in the server's .env, so the panel explains instead of offering a form that
// could not save. Ways that need setup only say how to turn them on; open
// sign-up, on by default, also says how to turn it off.
import type { SignIn } from "$lib/contracts/types";
const SECONDS_PER_MINUTE = 60;

export type OptionId = "password" | "confirmation" | "recovery" | "magicLink" | "google" | "github";

export interface SignInOption {
  id: OptionId;
  on: boolean;
  /** What the variables do: turn the option on, or (open sign-up only) off. */
  change: "enable" | "disable";
  /** Variables that make the change; empty when there is nothing to show. */
  variables: string[];
}

const MAIL = ["NELCOTA_SMTP_URL", "NELCOTA_SMTP_FROM", "NELCOTA_PASSWORD_RECOVERY_URL"];
const OAUTH = ["NELCOTA_API_URL", "NELCOTA_OAUTH_REDIRECT_URLS"];

export function signInOptions(settings: SignIn): SignInOption[] {
  const option = (id: OptionId, on: boolean, variables: string[]): SignInOption => ({
    id,
    on,
    change: "enable",
    variables: on ? [] : variables,
  });
  // Without SMTP, every email feature needs the mail trio first.
  const mail = (extra: string[]) => (settings.email ? extra : [...MAIL, ...extra]);
  return [
    settings.signup_enabled
      ? { id: "password", on: true, change: "disable", variables: ["NELCOTA_SIGNUP_ENABLED=false"] }
      : option("password", false, ["NELCOTA_SIGNUP_ENABLED=true"]),
    option("confirmation", settings.email_confirmation, mail(["NELCOTA_EMAIL_CONFIRMATION_URL"])),
    option("recovery", settings.password_recovery, mail([])),
    option("magicLink", settings.magic_link, mail(["NELCOTA_MAGIC_LINK_URL"])),
    option("google", settings.providers.google, [
      ...OAUTH,
      "NELCOTA_OAUTH_GOOGLE_CLIENT_ID",
      "NELCOTA_OAUTH_GOOGLE_CLIENT_SECRET",
    ]),
    option("github", settings.providers.github, [
      ...OAUTH,
      "NELCOTA_OAUTH_GITHUB_CLIENT_ID",
      "NELCOTA_OAUTH_GITHUB_CLIENT_SECRET",
    ]),
  ];
}

/** The variables as .env lines, ready to fill in: `NAME=` unless a value is given. */
export const envSnippet = (variables: string[]) =>
  variables.map((v) => (v.includes("=") ? v : `${v}=`)).join("\n");

/** Seconds as whole minutes, at least one. */
export const minutes = (seconds: number) => Math.max(1, Math.round(seconds / SECONDS_PER_MINUTE));
