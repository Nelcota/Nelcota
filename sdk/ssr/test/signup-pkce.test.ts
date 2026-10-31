import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import { promiseResult } from "../src/lifecycle/promise-result.js";
import { user, session, post, setup } from "./context-fixtures.js";
import { requiredValue } from "./required-value.js";

/** An auth server that keeps sign-ups pending and records the JSON bodies it receives. */
function pendingSignups() {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (url: string | URL | Request, init: RequestInit = {}) =>
    promiseResult(() => {
      const path = new URL(url instanceof Request ? url.url : url).pathname;
      if (typeof init.body === "string")
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      if (path === "/auth/v1/signup") return Response.json({ user }, { status: 201 });
      if (path === "/auth/v1/verify") return Response.json(session());
      return Response.json(path === "/auth/v1/user" ? user : []);
    });
  return { bodies, fetch };
}

it("sign-up PKCE: the sealed session keeps the verifier until the confirmation link is verified", async () => {
  const server = pendingSignups();
  const { integration, jar } = await setup({ fetch: server.fetch });
  const signed = await integration.write(jar, post(), (context) =>
    context.auth.signUp({ email: user.email, password: "fixture-password" }),
  );
  expect(signed.data?.confirmationRequired).toBe(true);
  // The pending sign-up is kept for the browser that signed up.
  expect(requiredValue(jar.writes.at(-1), "published cookie").options.maxAge).toBeGreaterThan(0);
  const challenge = requiredValue(server.bodies[0], "sign-up body")["code_challenge"];
  expect(requiredValue(server.bodies[0], "sign-up body")["code_challenge_method"]).toBe("S256");

  const link = { type: "signup", token: "fixture-token" } as const;
  const confirmed = await integration.write(jar, post(), (context) =>
    context.auth.verifyEmailLink(link),
  );
  expect(confirmed.error).toBeNull();
  const verifier = requiredValue(server.bodies[1], "verify body")["code_verifier"];
  expect(typeof verifier).toBe("string");
  expect(createHash("sha256").update(String(verifier)).digest("base64url")).toBe(challenge);
  await integration.read(jar, (context) =>
    promiseResult(() => {
      expect(context.hasSession).toBe(true);
    }),
  );

  // Consumed: a later confirmation from this browser sends no verifier.
  await integration.write(jar, post(), (context) => context.auth.verifyEmailLink(link));
  expect(server.bodies[2]).toEqual(link);
});

it("sign-up PKCE: starting OAuth keeps a pending sign-up's verifier", async () => {
  const server = pendingSignups();
  const { integration, jar } = await setup({ fetch: server.fetch });
  await integration.write(jar, post(), (context) =>
    context.auth.signUp({ email: user.email, password: "fixture-password" }),
  );
  await integration.write(jar, post(), (context) =>
    context.auth.startOAuth({ provider: "github" }),
  );
  await integration.write(jar, post(), (context) =>
    context.auth.verifyEmailLink({ type: "signup", token: "fixture-token" }),
  );
  expect(typeof requiredValue(server.bodies[1], "verify body")["code_verifier"]).toBe("string");
});
