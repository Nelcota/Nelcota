import { afterEach, expect, it, vi } from "vitest";

import { requiredValue } from "../../src/core/required-value.js";
import { createClient, NelcotaUsageError } from "../../src/index.js";
import { client } from "./http-client-fixtures.js";
import { empty, json, mockFetch } from "./http-fixtures.js";
import { promiseResult } from "./promise-result.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("failures without a response: preserves token adapter exceptions and observes late failures after cancellation", async () => {
  const mock = mockFetch(json([]));
  const failure = new Error("adapter failed");
  const broken = client(mock, {
    accessToken: () => {
      return promiseResult(() => {
        throw failure;
      });
    },
  });
  await expect(broken.from("todos").select().execute()).rejects.toBe(failure);
  let rejectToken!: (error: Error) => void, started!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const token = new Promise<string>((_resolve, reject) => {
    rejectToken = reject;
  });
  const detached = client(mock, {
    accessToken: () => {
      started();
      return token;
    },
  });
  const controller = new AbortController();
  const pending = detached.from("todos").select().abortSignal(controller.signal).execute();
  await begun;
  controller.abort();
  expect((await pending).error?.code).toBe("aborted");
  rejectToken(failure);
  await Promise.resolve();
  expect(mock.calls).toHaveLength(0);
  broken.dispose();
  detached.dispose();
});

it("failures without a response: returns errors for truncated JSON and file bodies and retries only reads", async () => {
  const broken = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError("connection lost"));
        },
      }),
    );
  const read = mockFetch(broken, json([]));
  expect((await client(read).from("t").select().execute()).error).toBeNull();
  expect(read.calls).toHaveLength(2);
  const write = mockFetch(broken);
  // The write reached the server and may have committed: not "could not be reached".
  expect((await client(write).from("t").insert({ a: 1 }).execute()).error?.code).toBe(
    "response_body_error",
  );
  expect(write.calls).toHaveLength(1);
  const file = mockFetch(broken);
  expect(
    (await client(file, { retries: 0 }).storage.from("files").download("a.txt")).error?.code,
  ).toBe("response_body_error");
});

it("failures without a response: classifies abort and timeout while reading a response body", async () => {
  const cancelDelayInMs = 15;

  const fetchBody = (_input: string | URL | Request, init?: RequestInit) =>
    promiseResult(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener(
                "abort",
                () => controller.error(new DOMException("aborted", "AbortError")),
                { once: true },
              );
            },
          }),
        ),
    );
  const timed = createClient("https://api.example.com", {
    fetch: fetchBody,
    timeout: 15,
    retries: 0,
  });
  expect((await timed.from("t").select().execute()).error?.code).toBe("timeout");
  const controller = new AbortController();
  const aborted = createClient("https://api.example.com", { fetch: fetchBody, retries: 0 });
  const download = aborted.storage.from("files").download("a.txt", { signal: controller.signal });
  setTimeout(() => controller.abort(), cancelDelayInMs);
  expect((await download).error?.code).toBe("aborted");
});

it("failures without a response: refuses invalid timeout and retry settings before sending", async () => {
  const mock = mockFetch(json([]));
  for (const options of [
    { timeout: -1 },
    { timeout: Infinity },
    { retries: -1 },
    { retries: 1.5 },
  ]) {
    expect(() => client(mock, options)).toThrow(NelcotaUsageError);
  }
  await expect(client(mock).from("t").select().timeout(NaN).execute()).rejects.toBeInstanceOf(
    NelcotaUsageError,
  );
  expect(mock.calls).toHaveLength(0);
});

it("failures without a response: reports network errors, timeouts and aborts with client codes", async () => {
  const down = mockFetch(() => {
    throw new TypeError("fetch failed");
  });
  expect((await client(down, { retries: 0 }).from("t").select().execute()).error).toMatchObject({
    status: 0,
    code: "network_error",
  });

  const hanging = mockFetch(
    (request) =>
      new Promise<Response>((_, reject) => {
        const delayInMs = 20;

        void request;
        setTimeout(() => reject(new DOMException("timed out", "TimeoutError")), delayInMs);
      }),
  );
  expect(
    (await client(hanging, { retries: 0, timeout: 10 }).from("t").select().execute()).error?.code,
  ).toBe("timeout");

  const controller = new AbortController();
  controller.abort();
  const aborting = mockFetch(json([]));
  expect(
    (await client(aborting).from("t").select().abortSignal(controller.signal).execute()).error
      ?.code,
  ).toBe("aborted");
});

it("failures without a response: keeps non-JSON error pages generic", async () => {
  const mock = mockFetch(
    new Response("<html>Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" }),
  );
  expect((await client(mock).from("t").select().execute()).error).toMatchObject({
    status: 502,
    code: "http_502",
    message: "Bad Gateway",
  });
});

it.each([
  [401, "unauthorized"],
  [403, "forbidden"],
  [404, "not_found"],
] as const)(
  "failures without a response: keeps a code for bodyless errors such as HEAD counts [%#]",
  async (status, code) => {
    const mock = mockFetch(empty(status));
    const { error } = await client(mock)
      .from("t")
      .select("*", { count: "exact", head: true })
      .execute();
    expect(error).toMatchObject({ status, code });
  },
);

it("failures without a response: exposes the optional Postgres fields of a db_error", async () => {
  const body = {
    code: "db_error",
    message: 'duplicate key value violates unique constraint "notes_title_key" (23505)',
    sqlstate: "23505",
    details: "Key (title)=(a) already exists.",
    hint: "Pick another title.",
    constraint: "notes_title_key",
  };
  const { error } = await client(mockFetch(json(body, 409)))
    .from("notes")
    .insert({ title: "a" })
    .execute();
  expect(error).toMatchObject({
    status: 409,
    code: "db_error",
    sqlstate: "23505",
    details: body.details,
    hint: body.hint,
    constraint: "notes_title_key",
  });
  expect(requiredValue(error, "required operation value").toJSON()).toEqual({
    name: "NelcotaError",
    status: 409,
    ...body,
  });

  const old = await client(mockFetch(json({ code: "db_error", message: "boom" }, 400)))
    .from("notes")
    .insert({ title: "a" })
    .execute();
  expect(old.error).toMatchObject({
    sqlstate: undefined,
    details: undefined,
    hint: undefined,
    constraint: undefined,
  });
  expect(Object.keys(requiredValue(old.error, "required operation value").toJSON())).toEqual([
    "name",
    "status",
    "code",
    "message",
  ]);
});

it("headers and tokens: omits caller-configured authorization on public auth endpoints", async () => {
  const mock = mockFetch(json({ code: "invalid_grant", message: "no" }, 400));
  await client(mock, {
    headers: { authorization: "Bearer caller-token" },
  }).auth.signInWithPassword({ email: "a@x.com", password: "pw" });
  expect(requiredValue(mock.calls[0], "recorded test item").headers.has("authorization")).toBe(
    false,
  );
});

it("headers and tokens: sends only the bearer token and the content type it needs", async () => {
  const mock = mockFetch(json([]));
  await client(mock, { accessToken: () => "tok" })
    .from("t")
    .insert({ a: 1 })
    .execute();
  const headers = [...requiredValue(mock.calls[0], "recorded test item").headers.keys()].toSorted();
  expect(headers).toEqual(["authorization", "content-type", "prefer"]);
  expect(requiredValue(mock.calls[0], "recorded test item").headers.get("authorization")).toBe(
    "Bearer tok",
  );
});
