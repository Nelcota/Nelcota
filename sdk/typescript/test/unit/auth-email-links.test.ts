import { afterEach, expect, it, vi } from "vitest";

import { requiredValue } from "../../src/core/required-value.js";
import { memoryStorage } from "../../src/index.js";
import { setup } from "./auth-fixtures.js";
import { json, session } from "./http-fixtures.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("email links: reads the fragment and cleans the address bar of the current page", () => {
  const href = "https://app.example.com/new-password#type=recovery&token=tok_123";
  const replaceState = vi.fn();
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
  vi.stubGlobal("location", { href });
  vi.stubGlobal("history", { state: null, replaceState });
  const { nelcota } = setup();
  expect(nelcota.auth.readEmailLink()).toEqual({ type: "recovery", token: "tok_123" });
  expect(replaceState).toHaveBeenCalledWith(null, "", "https://app.example.com/new-password");
});

it("email links: ignores fragments that are not email links", () => {
  const { nelcota } = setup();
  for (const href of [
    "https://a.com/#type=admin&token=x",
    "https://a.com/#token=x",
    `https://a.com/#type=signup&token=${"x".repeat(129)}`,
  ]) {
    expect(nelcota.auth.readEmailLink(href), href).toBeNull();
  }
});

it("email links: verifies links and resets passwords", async () => {
  const { nelcota, calls } = setup(memoryStorage(), json(session()));
  await nelcota.auth.verifyEmailLink({ type: "magiclink", token: "t1" });
  await nelcota.auth.resetPassword({ token: "t2", password: "new-password" });
  expect(calls.map((c) => JSON.parse(requiredValue(c.body, "request body")) as unknown)).toEqual([
    { type: "magiclink", token: "t1" },
    { type: "recovery", token: "t2", password: "new-password" },
  ]);
});

it("email links: asks for emails without revealing whether the account exists", async () => {
  const { nelcota, calls } = setup(memoryStorage(), json({}));
  expect(await nelcota.auth.requestPasswordReset("a@x.com")).toEqual({ data: null, error: null });
  await nelcota.auth.sendMagicLink("a@x.com");
  await nelcota.auth.resendConfirmation("a@x.com");
  expect(
    calls.map((c) => [
      c.url.pathname,
      JSON.parse(requiredValue(c.body, "request body")) as unknown,
    ]),
  ).toEqual([
    ["/auth/v1/recover", { email: "a@x.com" }],
    ["/auth/v1/magiclink", { email: "a@x.com" }],
    ["/auth/v1/resend", { type: "signup", email: "a@x.com" }],
  ]);
});
