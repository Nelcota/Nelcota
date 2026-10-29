import { afterEach, expect, it, vi } from "vitest";

import { errorFromResponse, parseRetryAfter } from "../../src/core/http/client.js";
import { requiredValue } from "../../src/core/required-value.js";
import { createClient, NelcotaUsageError } from "../../src/index.js";
import { client } from "./http-client-fixtures.js";
import { empty, json, mockFetch, session } from "./http-fixtures.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([NaN, Infinity, -Infinity, new Number(NaN)])(
  "JSON input boundaries: rejects non-finite writes and RPC input before auth or HTTP (%s)",
  async (value) => {
    const mock = mockFetch();
    const token = vi.fn(() => null);
    const nelcota = createClient("https://api.example.com", {
      fetch: mock.fetch,
      accessToken: token,
      auth: { autoRefresh: false },
    });
    try {
      for (const query of [
        nelcota.from("notes").insert({ nested: { values: [value] } }),
        nelcota.from("notes").update({ value }),
        nelcota.from("notes").upsert({ value }),
      ])
        // oxlint-disable-next-line no-await-in-loop -- Observe the current response before advancing the shared retry fixture.
        await expect(query.execute()).rejects.toBeInstanceOf(NelcotaUsageError);
      await expect(nelcota.rpc("echo", { value })).rejects.toBeInstanceOf(NelcotaUsageError);
      expect(mock.calls).toHaveLength(0);
      expect(token).not.toHaveBeenCalled();
    } finally {
      nelcota.dispose();
    }
  },
);

it("JSON input boundaries: preserves explicit nulls and finite numbers in writes and RPC", async () => {
  const mock = mockFetch(empty(), json(null));
  const nelcota = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: false },
  });
  const input = { value: null, nested: [1.25, null], label: "NaN" };
  try {
    expect((await nelcota.from("notes").insert(input).execute()).error).toBeNull();
    expect((await nelcota.rpc("echo", input)).error).toBeNull();
    expect(
      mock.calls.map((call) => JSON.parse(requiredValue(call.body, "request body")) as unknown),
    ).toEqual([input, input]);
  } finally {
    nelcota.dispose();
  }
});

it.each([undefined, "1", "1000000"])(
  "error response budgets: cancels oversized error pages with length %s",
  async (length) => {
    const cancel = vi.fn();
    let chunks = 0;
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (chunks++ === 10) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(8192));
    });
    const headers = new Headers({ "retry-after": "90" });
    if (length !== undefined) headers.set("content-length", length);
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    const error = await errorFromResponse(new Response(body, { status: 503, headers }));
    expect(error).toMatchObject({ status: 503, code: "unavailable", retryAfter: 90 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull.mock.calls.length).toBe(length === "1000000" ? 0 : 9);
    expect(body.locked).toBe(false);
  },
);

it("error response budgets: decodes a complete error at the exact byte boundary", async () => {
  const text = JSON.stringify({ code: "db_error", message: "ação" });
  const data = new TextEncoder().encode(
    text + " ".repeat(65536 - new TextEncoder().encode(text).length),
  );
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  expect(await errorFromResponse(new Response(body, { status: 409 }))).toMatchObject({
    status: 409,
    code: "db_error",
    message: "ação",
  });
});

it("keeps an unsafe identifier intact when it is reused in a filter", async () => {
  const mock = mockFetch(new Response('[{"id":9007199254740993}]'), json([]));
  const nelcota = client(mock);
  const first = await nelcota.from("todos").select("id").execute();
  expect(first.data).toEqual([{ id: "9007199254740993" }]);
  const id = requiredValue(requiredValue(first.data, "response data")[0], "recorded test item").id;
  if (typeof id !== "string" && typeof id !== "number") throw new Error("Missing row identifier");
  await nelcota.from("todos").select("id").eq("id", id).execute();
  expect(requiredValue(mock.calls[1], "recorded test item").url.searchParams.get("id")).toBe(
    "eq.9007199254740993",
  );
});

it("retries: returns long Retry-After delays instead of retrying too early", async () => {
  const mock = mockFetch(
    json({ code: "rate_limited", message: "wait" }, 429, { "retry-after": "90" }),
  );
  expect((await client(mock).from("todos").select().execute()).error?.retryAfter).toBe(90);
  expect(mock.calls).toHaveLength(1);
});

it("retries: retries reads on 429 honouring Retry-After", async () => {
  vi.useFakeTimers();
  const mock = mockFetch(
    json({ code: "rate_limited", message: "slow down" }, 429, { "retry-after": "2" }),
    json([]),
  );
  const pending = client(mock).from("todos").select().execute();
  await vi.advanceTimersByTimeAsync(1999);
  expect(mock.calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  const { data, error } = await pending;
  expect(error).toBeNull();
  expect(data).toEqual([]);
  expect(mock.calls).toHaveLength(2);
});

it("retries: gives up after the configured retries and reports retryAfter", async () => {
  const mock = mockFetch(
    json({ code: "rate_limited", message: "slow down" }, 429, { "retry-after": "0" }),
  );
  const { error } = await client(mock, { retries: 1 }).from("todos").select().execute();
  expect(mock.calls).toHaveLength(2);
  expect(error).toMatchObject({ status: 429, code: "rate_limited", retryAfter: 0 });
});

it("retries: never retries writes", async () => {
  const mock = mockFetch(
    json({ code: "unavailable", message: "down" }, 503, { "retry-after": "0" }),
  );
  const { error } = await client(mock).from("todos").insert({ title: "x" }).execute();
  expect(mock.calls).toHaveLength(1);
  expect(error?.code).toBe("unavailable");
});

it("retries: retries reads after network errors, not after 4xx", async () => {
  let attempts = 0;
  const mock = mockFetch(() => {
    attempts++;
    if (attempts === 1) throw new TypeError("fetch failed");
    return json({ code: "invalid_query", message: "bad" }, 400);
  });
  const { error } = await client(mock).from("todos").select().execute();
  expect(attempts).toBe(2);
  expect(error?.code).toBe("invalid_query");
});

it("retries: parses both Retry-After forms", () => {
  expect(parseRetryAfter("7")).toBe(7);
  expect(parseRetryAfter(new Date(Date.now() + 3000).toUTCString())).toBeGreaterThanOrEqual(2);
  expect(parseRetryAfter("soon")).toBeUndefined();
  expect(parseRetryAfter(null)).toBeUndefined();
});

it("failures without a response: cancels while waiting for a caller token without sending HTTP", async () => {
  let started!: () => void, finish!: (token: string) => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const token = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const mock = mockFetch(json([]));
  const nelcota = client(mock, {
    accessToken: () => {
      started();
      return token;
    },
  });
  const controller = new AbortController();
  const pending = nelcota.from("todos").select().abortSignal(controller.signal).execute();
  await begun;
  try {
    controller.abort();
    expect((await pending).error?.code).toBe("aborted");
    expect(mock.calls).toHaveLength(0);
  } finally {
    finish("late-token");
    nelcota.dispose();
  }
});

it("failures without a response: cancels a query independently of the shared session refresh", async () => {
  vi.useFakeTimers();
  let started!: () => void, finish!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let requests = 0;
  const nelcota = createClient("https://api.example.com", {
    auth: { autoRefresh: false },
    fetch: async () => {
      requests++;
      started();
      await wait;
      return json(session(900, "refresh-2", "access-2"));
    },
  });
  await nelcota.auth.setSession(session(30));
  const controller = new AbortController();
  let code: string | undefined;
  const pending = nelcota
    .from("todos")
    .select()
    .abortSignal(controller.signal)
    .execute()
    .then((result) => {
      code = result.error?.code;
    });
  await begun;
  try {
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(code).toBe("aborted");
    expect(requests).toBe(1);
  } finally {
    finish();
    await pending;
    expect((await nelcota.auth.getSession()).data?.refresh_token).toBe("refresh-2");
    nelcota.dispose();
    vi.useRealTimers();
  }
});
