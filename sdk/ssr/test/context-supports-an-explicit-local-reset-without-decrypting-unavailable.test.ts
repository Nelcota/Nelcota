import { expect, it, vi } from "vitest";

import { promiseResult } from "../src/lifecycle/promise-result.js";
import { DevelopmentSessionStore } from "../src/memory-store.js";
import { requiredValue } from "../src/required-value.js";
import { newSessionId } from "../src/sealing/seal.js";
import { Jar, post, setup, credentials } from "./context-fixtures.js";

it("supports an explicit local reset without decrypting unavailable state", async () => {
  const store = new DevelopmentSessionStore();
  const original = await setup({ store });
  await original.integration.write(original.jar, post(), (context) =>
    context.auth.signInWithPassword(credentials),
  );
  const rotated = await setup({ store });
  await rotated.integration.read(original.jar, (context) => {
    return promiseResult(() => {
      expect(context.hasSession).toBe(false);
      expect(context.staleCookie).toBe(true);
    });
  });
  await rotated.integration.forget(original.jar, post());
  await rotated.integration.read(original.jar, (context) => {
    return promiseResult(() => {
      expect(context.hasSession).toBe(false);
    });
  });
  expect(original.jar.values.size).toBe(0);
});

it("cancels a pending OAuth identity when a password login succeeds", async () => {
  const { integration, jar, requests } = await setup();
  const start = await integration.write(jar, post(), (context) =>
    context.auth.startOAuth({ provider: "github" }),
  );
  const callback = new URL(
    requiredValue(
      new URL(requiredValue(start.data, "response data").url).searchParams.get("redirect_to"),
      "response data",
    ),
  );
  await integration.write(jar, post(), (context) => context.auth.signInWithPassword(credentials));
  await expect(
    integration.write(
      jar,
      new Request(callback),
      (context) => context.auth.exchangeCode("old-pending-code"),
      true,
    ),
  ).rejects.toMatchObject({ code: "csrf" });
  expect(requests).toHaveLength(1);
});

it("grants a new absolute lifetime to a successful replacement login", async () => {
  const { integration, jar } = await setup({ sessionTtlSeconds: 300 });
  await integration.write(jar, post(), (context) => context.auth.signInWithPassword(credentials));
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 290000);
  try {
    await integration.write(jar, post(), (context) => context.auth.signInWithPassword(credentials));
    expect(jar.writes.at(-1)?.options.maxAge).toBe(300);
  } finally {
    clock.mockRestore();
  }
});

it("does not abort an accepted storage response stream when its session lease closes", async () => {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let signal: AbortSignal | null | undefined;
  const { integration, jar } = await setup({
    fetch: (_url, init) => {
      return promiseResult(() => {
        signal = init?.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
          }),
        );
      });
    },
  });
  const result = await integration.write(jar, post(), (context) =>
    context.client.storage.from("assets").open("file"),
  );
  expect(result.error).toBeNull();
  expect(signal?.aborted).toBe(false);
  stream?.enqueue(new TextEncoder().encode("accepted stream"));
  stream?.close();
  expect(await result.data?.text()).toBe("accepted stream");
});

it("ends the adapter header deadline before handing a stream to its caller", async () => {
  const delayInMs = 150;

  let signal: AbortSignal | null | undefined;
  const { integration, jar } = await setup({
    timeout: 100,
    fetch: (_url, init) => {
      return promiseResult(() => {
        signal = init?.signal;
        return new Response("accepted object");
      });
    },
  });
  const result = await integration.write(jar, post(), (context) =>
    context.client.storage.from("assets").open("file"),
  );
  expect(result.error).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, delayInMs));
  expect(signal?.aborted).toBe(false);
  expect(await result.data?.text()).toBe("accepted object");
});

it("treats rows sealed with lost keys as signed out and lets login replace them", async () => {
  const store = new DevelopmentSessionStore();
  const original = await setup({ store });
  await original.integration.write(original.jar, post(), (context) =>
    context.auth.signInWithPassword(credentials),
  );
  const rotated = await setup({ store });
  await rotated.integration.read(original.jar, async (context) => {
    expect(context.hasSession).toBe(false);
    expect(context.staleCookie).toBe(true);
    expect((await context.getUser()).error?.code).toBe("session_missing");
  });
  const result = await rotated.integration.write(original.jar, post(), (context) =>
    context.auth.signInWithPassword(credentials),
  );
  expect(result.data?.id).toBe("user-one");
  await rotated.integration.read(original.jar, async (context) => {
    expect(context.hasSession).toBe(true);
    expect((await context.getUser()).data?.id).toBe("user-one");
  });
});

it("lets the proxy clear only a stale cookie that had a row", async () => {
  const store = new DevelopmentSessionStore();
  const original = await setup({ store });
  // A bootstrap/pre-login ID: a sign-in in flight may already have replaced it.
  const bootstrap = new Jar();
  await original.integration.write(original.jar, post(), (context) =>
    context.auth.signInWithPassword(credentials),
  );
  const name = requiredValue([...original.jar.values.keys()][0], "published cookie");
  bootstrap.values.set(name, newSessionId());
  await original.integration.read(bootstrap, (context, { clearable }) => {
    return promiseResult(() => {
      expect(context.staleCookie).toBe(true);
      expect(clearable).toBe(false);
    });
  });
  // A row sealed with keys this server no longer has is cleared.
  const rotated = await setup({ store });
  await rotated.integration.read(original.jar, (context, { clearable }) => {
    return promiseResult(() => {
      expect(context.staleCookie).toBe(true);
      expect(clearable).toBe(true);
    });
  });
});

it("removes an unreadable row and clears its cookie when a write saves nothing", async () => {
  const store = new DevelopmentSessionStore();
  const original = await setup({ store });
  const ownership = vi.spyOn(store, "exclusive");
  await original.integration.write(original.jar, post(), (context) =>
    context.auth.signInWithPassword(credentials),
  );
  const key = requiredValue(ownership.mock.calls[0], "recorded request")[0];
  const rotated = await setup({ store });
  await rotated.integration.write(original.jar, post(), () => promiseResult(() => undefined));
  expect(await store.read(key)).toBeNull();
  expect(original.jar.writes.at(-1)?.options.maxAge).toBe(0);
  expect(original.jar.values.size).toBe(0);
  expect(rotated.requests).toHaveLength(0);
});

it("counts a row that expires between the store check and decryption as expired", async () => {
  const { integration, jar, store } = await setup({ sessionTtlSeconds: 300 });
  await integration.write(jar, post(), (context) => context.auth.signInWithPassword(credentials));
  const read = store.read.bind(store),
    now = Date.now();
  const clock = vi.spyOn(Date, "now");
  vi.spyOn(store, "read").mockImplementation(async (key) => {
    const row = await read(key);
    clock.mockReturnValue(now + 301000);
    return row;
  });
  try {
    await integration.read(jar, (context) => {
      return promiseResult(() => {
        expect(context.hasSession).toBe(false);
        expect(context.staleCookie).toBe(true);
      });
    });
  } finally {
    clock.mockRestore();
  }
});

it("session fixation: never adopts a well-formed cookie that has no stored row", async () => {
  const { integration, jar, store } = await setup();
  const probe = new Jar();
  await integration.write(probe, post(), (context) => context.auth.signInWithPassword(credentials));
  const name = requiredValue(probe.writes[0], "published cookie").name;
  const planted = newSessionId();
  jar.values.set(name, planted);
  const ownership = vi.spyOn(store, "exclusive");
  await integration.write(jar, post(), (context) => context.auth.signInWithPassword(credentials));
  const issued = requiredValue(jar.writes.at(-1), "published cookie");
  expect(issued.name).toBe(name);
  expect(issued.value).toHaveLength(43);
  expect(issued.value).not.toBe(planted);
  expect(issued.options.maxAge).toBeGreaterThan(0);
  expect(
    await store.read(requiredValue(ownership.mock.calls[0], "recorded request")[0]),
  ).toBeNull();
});
