import type { SignIn } from "$lib/contracts/types";
import { expect, it } from "vitest";

import { requiredValue } from "../../contracts/required-value.js";
import { minutes, signInOptions } from "./sign-in-options";

const settings = (patch: Partial<SignIn> = {}): SignIn => ({
  signup_enabled: true,
  email: false,
  email_confirmation: false,
  password_recovery: false,
  magic_link: false,
  providers: { google: false, github: false },
  redirect_urls: [],
  callback_url: null,
  access_ttl_secs: 900,
  refresh_ttl_days: 30,
  rate_limit_per_minute: 30,
  ...patch,
});

it("sign-in options: lists every way in, in a stable order", () => {
  expect(signInOptions(settings()).map((o) => o.id)).toEqual([
    "password",
    "confirmation",
    "recovery",
    "magicLink",
    "google",
    "github",
  ]);
});

it("sign-in options: names the variables that turn an option on, only while it is off", () => {
  const [, confirmation, recovery, magic] = signInOptions(settings());
  expect(requiredValue(recovery, "test fixture item").variables).toEqual([
    "NELCOTA_SMTP_URL",
    "NELCOTA_SMTP_FROM",
    "NELCOTA_PASSWORD_RECOVERY_URL",
  ]);
  expect(requiredValue(confirmation, "test fixture item").variables.at(-1)).toBe(
    "NELCOTA_EMAIL_CONFIRMATION_URL",
  );
  expect(requiredValue(magic, "test fixture item").variables).toContain("NELCOTA_SMTP_URL");
});

it("sign-in options: open sign-up says how to turn it off while on, and on while off", () => {
  expect(signInOptions(settings())[0]).toEqual({
    id: "password",
    on: true,
    change: "disable",
    variables: ["NELCOTA_SIGNUP_ENABLED=false"],
  });
  expect(signInOptions(settings({ signup_enabled: false }))[0]).toEqual({
    id: "password",
    on: false,
    change: "enable",
    variables: ["NELCOTA_SIGNUP_ENABLED=true"],
  });
  expect(
    requiredValue(
      signInOptions(settings({ providers: { google: true, github: false } }))[4],
      "test fixture item",
    ).variables,
  ).toEqual([]);
});

it("sign-in options: with email on, only the missing page is asked for", () => {
  const options = signInOptions(settings({ email: true, password_recovery: true }));
  expect(
    requiredValue(
      options.find((o) => o.id === "magicLink"),
      "selected entry",
    ).variables,
  ).toEqual(["NELCOTA_MAGIC_LINK_URL"]);
  expect(
    requiredValue(
      options.find((o) => o.id === "recovery"),
      "selected entry",
    ).on,
  ).toBe(true);
});

it("sign-in options: providers need the API address, the return pages and their client", () => {
  const github = requiredValue(
    signInOptions(settings()).find((o) => o.id === "github"),
    "selected entry",
  );
  expect(github.variables).toEqual([
    "NELCOTA_API_URL",
    "NELCOTA_OAUTH_REDIRECT_URLS",
    "NELCOTA_OAUTH_GITHUB_CLIENT_ID",
    "NELCOTA_OAUTH_GITHUB_CLIENT_SECRET",
  ]);
  expect(
    requiredValue(
      signInOptions(settings({ providers: { google: true, github: false } }))[4],
      "test fixture item",
    ).on,
  ).toBe(true);
});

it("sign-in options: rounds token lifetimes to minutes", () => {
  expect(minutes(900)).toBe(15);
  expect(minutes(20)).toBe(1);
});
