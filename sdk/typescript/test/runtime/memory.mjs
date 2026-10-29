// The built SDK must release cancelled callers before a shared rotation settles.
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";

import { abortable } from "../../dist/core/cancellation.js";
import { createClient, memoryStorage } from "../../dist/index.js";

function collect() {
  const gc = globalThis.gc;
  assert(gc != null, "Run this check with node --expose-gc");
  gc();
}

/** @param {readonly WeakRef<object>[]} references */
async function retained(references) {
  // WeakRef targets survive their creation job. Collect across separate turns.
  for (let index = 0; index < 10; index++) {
    // oxlint-disable-next-line no-await-in-loop -- Settle each cancellation and GC turn before measuring the next retained-reference sample.
    await setImmediate();
    collect();
  }
  return references.filter((reference) => reference.deref() !== undefined).length;
}

/** @param {number} number */
async function round(number) {
  /** @type {PromiseWithResolvers<string>} */
  const completion = Promise.withResolvers();
  const { promise: operation, resolve: finish } = completion;
  const active = abortable(operation, new AbortController().signal);
  async function cancel() {
    const controller = new AbortController();
    const reference = new WeakRef(controller.signal);
    const pending = abortable(operation, controller.signal);
    controller.abort();
    assert.equal((await pending).error?.code, "aborted");
    return reference;
  }
  /** @type {WeakRef<AbortSignal>[]} */
  const references = [];
  // oxlint-disable-next-line no-await-in-loop -- Settle each cancellation and GC turn before measuring the next retained-reference sample.
  for (let index = 0; index < 1000; index++) references.push(await cancel());
  const count = await retained(references);
  assert.equal(count, 0, "A pending shared operation retained cancelled callers");
  finish("accepted");
  assert.equal((await active).data, "accepted");
  console.log(
    JSON.stringify({
      round: number,
      cancelledCallers: references.length,
      retainedSignalsBeforeCompletion: count,
    }),
  );
  return new WeakRef(operation);
}

const operations = [];
// oxlint-disable-next-line no-await-in-loop -- Settle each cancellation and GC turn before measuring the next retained-reference sample.
for (let number = 1; number <= 3; number++) operations.push(await round(number));
assert.equal(await retained(operations), 0, "Completed operations remained rooted");

/** @param {boolean} webLocks */
async function queuedAuthentication(webLocks) {
  const navigator = replaceNavigator(webLocks);
  const { promise: started, resolve: entered } = voidCompletion();
  const { promise: held, resolve: release } = voidCompletion();
  let requests = 0;
  const client = createClient("https://fixture.example", {
    auth: { autoRefresh: false, storage: memoryStorage() },
    retries: 0,
    fetch: async () => {
      requests++;
      entered();
      await held;
      return new Response('{"code":"fixture","message":"fixture"}', { status: 400 });
    },
  });
  const owner = client.auth.signInWithPassword({
    email: "owner@example.test",
    password: "fixture",
  });
  /** @type {WeakRef<AbortSignal>[]} */
  const references = [];

  try {
    await started;
    await Promise.all(
      Array.from({ length: 200 }, (_, index) => cancelQueued(client, references, index)),
    );
    assert.equal(await retained(references), 0, "Queued authentication retained cancelled signals");
    assert.equal(requests, 1);
    console.log(
      JSON.stringify({
        webLocks,
        queuedAuthentication: references.length,
        retainedSignalsBeforeOwnerCompletes: 0,
      }),
    );
  } finally {
    release();
    await owner;
    client.dispose();
    if (navigator !== undefined) Object.defineProperty(globalThis, "navigator", navigator);
    if (navigator == null) Reflect.deleteProperty(globalThis, "navigator");
  }
}

await queuedAuthentication(false);
await queuedAuthentication(true);

/** @param {boolean} webLocks */
function replaceNavigator(webLocks) {
  const navigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  /** @type {Map<string, Promise<void>>} */
  const queues = new Map();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: webLocks
      ? {
          locks: {
            /** @template T
             * @param {string} name
             * @param {() => Promise<T>} task */
            request(name, task) {
              const result = (queues.get(name) ?? Promise.resolve()).then(task);
              queues.set(
                name,
                result.then(
                  () => undefined,
                  () => undefined,
                ),
              );
              return result;
            },
          },
        }
      : {},
  });
  return navigator;
}
function voidCompletion() {
  /** @type {PromiseWithResolvers<void>} */
  const completion = Promise.withResolvers();
  return completion;
}

/** @param {ReturnType<typeof createClient>} client @param {WeakRef<AbortSignal>[]} references @param {number} index */
async function cancelQueued(client, references, index) {
  const controller = new AbortController();
  references.push(new WeakRef(controller.signal));
  const waiting = client.auth.signInWithPassword(
    { email: `queued${index}@example.test`, password: "fixture" },
    { signal: controller.signal },
  );
  controller.abort();
  assert.equal((await waiting).error?.code, "aborted");
}
