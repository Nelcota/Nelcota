import { expect, it } from "vitest";

import { createAuthClient } from "../../src/auth/index.js";
import { requiredValue } from "../../src/core/required-value.js";
import { createClient, memoryStorage } from "../../src/index.js";
import { createRestClient } from "../../src/rest/index.js";
import { createStorageClient } from "../../src/storage/index.js";
import { empty, json, mockFetch, session } from "./http-fixtures.js";

it("standalone clients: separates projects served under different base paths in a shared adapter", async () => {
  const storage = memoryStorage();
  const options = { auth: { storage, autoRefresh: false } };
  const a = createClient("https://api.example.com/project-a/", options);
  const b = createClient("https://api.example.com/project-b", options);
  const sameA = createClient("https://api.example.com/project-a", options);
  await a.auth.setSession(session());
  expect((await b.auth.getSession()).data).toBeNull();
  expect((await sameA.auth.getSession()).data?.access_token).toBe("access-1");
  a.dispose();
  b.dispose();
  sameA.dispose();
});

it("standalone clients: shares an auth token with REST and storage through the public interface", async () => {
  const mock = mockFetch(json(session()), json([{ id: 1 }]), empty());
  const auth = createAuthClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: false },
  });
  expect(
    (await auth.signInWithPassword({ email: "ana@example.com", password: "pw" })).error,
  ).toBeNull();
  const options = { fetch: mock.fetch, accessToken: () => auth.accessToken() };
  expect(
    (await createRestClient("https://api.example.com", options).from("notes").select().execute())
      .data,
  ).toEqual([{ id: 1 }]);
  expect(
    (await createStorageClient("https://api.example.com", options).from("files").remove("u1/a.txt"))
      .error,
  ).toBeNull();
  expect(mock.calls.slice(1).map((call) => call.headers.get("authorization"))).toEqual([
    "Bearer access-1",
    "Bearer access-1",
  ]);
  auth.dispose();
});

it("standalone clients: keeps sessions isolated between server requests", async () => {
  const mock = mockFetch(json(session()), json([]));
  const a = createClient("https://api.example.com", { fetch: mock.fetch });
  const b = createClient("https://api.example.com", { fetch: mock.fetch });
  await a.auth.signInWithPassword({ email: "ana@example.com", password: "pw" });
  expect((await b.auth.getSession()).data).toBeNull();
  await b.from("notes").select().execute();
  expect(requiredValue(mock.calls.at(-1), "recorded request").headers.has("authorization")).toBe(
    false,
  );
  const request = createClient("https://api.example.com", {
    fetch: mock.fetch,
    accessToken: () => "caller-token",
  });
  await request.from("notes").select().execute();
  expect(requiredValue(mock.calls.at(-1), "recorded request").headers.get("authorization")).toBe(
    "Bearer caller-token",
  );
  expect((await request.auth.getSession()).data).toBeNull();
  a.dispose();
  b.dispose();
  request.dispose();
});
