import { expect, it } from "vitest";

import { requiredValue } from "../../src/core/required-value.js";
import { createClient } from "../../src/index.js";
import { json, mockFetch } from "./http-fixtures.js";

function client(...replies: Parameters<typeof mockFetch>) {
  const mock = mockFetch(...replies);
  return {
    nelcota: createClient("https://api.example.com", {
      fetch: mock.fetch,
      accessToken: () => "tok",
    }),
    calls: mock.calls,
  };
}

it("buckets: untyped options cannot replace headers, auth or response validation", async () => {
  const bucket = {
    id: "avatars",
    public: true,
    file_size_limit: null,
    allowed_mime_types: null,
    created_at: "",
    updated_at: "",
  };
  const { nelcota, calls } = client(json(bucket, 201), json({ unexpected: true }));
  const injected = {
    headers: { "content-type": "text/plain", authorization: "Bearer other" },
    auth: false,
    validate: () => true,
    method: "DELETE",
  } as never;
  expect(
    (await nelcota.storage.createBucket("avatars", { public: true }, injected)).error,
  ).toBeNull();
  expect((await nelcota.storage.getBucket("avatars", injected)).error?.code).toBe(
    "invalid_response",
  );
  for (const call of calls) expect(call.headers.get("authorization")).toBe("Bearer tok");
  expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
  expect(requiredValue(calls[0], "recorded request").headers.get("content-type")).toBe(
    "application/json",
  );
});
