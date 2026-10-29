import { afterEach, expect, it, vi } from "vitest";

import { baseUrl } from "../../src/core/http/client.js";
import { assertTokenAllowed } from "../../src/core/jwt.js";
import { requiredValue } from "../../src/core/required-value.js";
import { createClient, NelcotaUsageError } from "../../src/index.js";
import { client } from "./http-client-fixtures.js";
import { json, jwt, mockFetch } from "./http-fixtures.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("headers and tokens: sends no Authorization for visitors", async () => {
  const mock = mockFetch(json([]));
  await client(mock).from("t").select().execute();
  expect(requiredValue(mock.calls[0], "recorded test item").headers.has("authorization")).toBe(
    false,
  );
});

it("headers and tokens: refuses a service_role token in a browser, allows it on a server", () => {
  const token = jwt({ role: "service_role" });
  expect(() => assertTokenAllowed(token, true)).toThrow(NelcotaUsageError);
  expect(() => assertTokenAllowed(token, false)).not.toThrow();
  expect(() => assertTokenAllowed(jwt({ role: "authenticated" }), true)).not.toThrow();
});

it("headers and tokens: refuses a service_role request when running in a browser", async () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
  const mock = mockFetch(json([]));
  const nelcota = client(mock, { accessToken: () => jwt({ role: "service_role", n: 1 }) });
  await expect(nelcota.from("t").select().execute()).rejects.toThrow(NelcotaUsageError);
  expect(mock.calls).toHaveLength(0);
});

it("headers and tokens: validates the base URL", () => {
  expect(baseUrl("https://api.example.com/base/").href).toBe("https://api.example.com/base/");
  for (const url of [
    "ftp://x",
    "not a url",
    "https://u:p@x.com",
    "https://x.com/?a=1",
    "https://x.com/#f",
  ]) {
    expect(() => baseUrl(url), url).toThrow(NelcotaUsageError);
  }
});

it("headers and tokens: keeps a base path", async () => {
  const mock = mockFetch(json([]));
  await createClient("https://example.com/nelcota/", { fetch: mock.fetch })
    .from("t")
    .select()
    .execute();
  expect(requiredValue(mock.calls[0], "recorded test item").url.pathname).toBe(
    "/nelcota/rest/v1/t",
  );
});

it("headers and tokens: never shows tokens when errors are logged", async () => {
  const mock = mockFetch(json({ code: "invalid_token", message: "expired" }, 401));
  const { error } = await client(mock, { accessToken: () => "secret-token" })
    .from("t")
    .select()
    .execute();
  expect(JSON.stringify(error)).not.toContain("secret-token");
  expect(String(error)).not.toContain("secret-token");
});

it("retains rate-limit delay when serializing an error without its cause", async () => {
  const mock = mockFetch(
    json({ code: "rate_limited", message: "Try later" }, 429, { "retry-after": "17" }),
  );
  const result = await client(mock, { retries: 0 }).from("notes").select().execute();
  const serialized = JSON.stringify(result.error);
  expect(JSON.parse(serialized) as unknown).toEqual({
    name: "NelcotaError",
    status: 429,
    code: "rate_limited",
    message: "Try later",
    retryAfter: 17,
  });
});

it("query strings: keeps filters on engines without URLSearchParams.size (Safari < 17)", async () => {
  const size = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, "size");
  Object.defineProperty(URLSearchParams.prototype, "size", {
    configurable: true,
    get: () => undefined,
  });
  try {
    const mock = mockFetch(json([]));
    await createClient("https://api.example.com", { fetch: mock.fetch })
      .from("notes")
      .select("id")
      .eq("owner", 7)
      .execute();
    expect(String(mock.calls[0]?.url)).toContain("owner=eq.7");
  } finally {
    if (size != null) Object.defineProperty(URLSearchParams.prototype, "size", size);
  }
});
