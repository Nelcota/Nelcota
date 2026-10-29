import { expect, it } from "vitest";

import { type SessionOptions } from "../src/context.js";
import { requiredValue } from "../src/required-value.js";
import { post, setup } from "./context-fixtures.js";

const start = async (overrides: Partial<SessionOptions> = {}) => {
  const fixture = await setup(overrides);
  const started = await fixture.integration.write(fixture.jar, post(), (context) =>
    context.auth.startOAuth({ provider: "github" }),
  );
  return {
    ...fixture,
    redirect: new URL(
      requiredValue(
        new URL(requiredValue(started.data, "response data").url).searchParams.get("redirect_to"),
        "response data",
      ),
    ),
  };
};
it("OAuth callback path > honours basePath for redirectTo and callback matching", async () => {
  const { integration, jar, redirect } = await start({ basePath: "/app" });
  expect(redirect.origin).toBe("http://localhost:3000");
  expect(redirect.pathname).toBe("/app/auth/callback");
  const state = requiredValue(redirect.searchParams.get("state"), "URL parameter");
  await expect(
    integration.write(
      jar,
      new Request(`http://localhost:3000/auth/callback?code=fixture&state=${state}`),
      (context) => context.auth.exchangeCode("fixture"),
      true,
    ),
  ).rejects.toMatchObject({ code: "csrf" });
  const exchanged = await integration.write(
    jar,
    new Request(`http://localhost:3000/app/auth/callback?code=fixture&state=${state}`),
    (context) => context.auth.exchangeCode("fixture"),
    true,
  );
  expect(exchanged.data?.user.id).toBe("user-one");
});
it("OAuth callback path > matches the configured callback path when a proxy rewrites Host, keeping state checks", async () => {
  const { integration, jar, redirect, requests } = await start();
  const state = requiredValue(redirect.searchParams.get("state"), "URL parameter");
  await expect(
    integration.write(
      jar,
      new Request(`http://internal:8080/auth/callback?code=fixture&state=${"a".repeat(43)}`),
      (context) => context.auth.exchangeCode("fixture"),
      true,
    ),
  ).rejects.toMatchObject({ code: "csrf" });
  expect(requests).toHaveLength(0);
  const exchanged = await integration.write(
    jar,
    new Request(`http://internal:8080/auth/callback?code=fixture&state=${state}`),
    (context) => context.auth.exchangeCode("fixture"),
    true,
  );
  expect(exchanged.data?.user.id).toBe("user-one");
});
it.each(["/", "app", "/app/", "//app", "/../app", "/./app", "/a?b", "/a#b", "/a b", "/a%2fb"])(
  "rejects non-canonical basePath %s",
  async (basePath) => {
    await expect(setup({ basePath })).rejects.toMatchObject({ code: "configuration" });
  },
);
