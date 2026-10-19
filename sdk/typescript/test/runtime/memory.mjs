// The built SDK must release cancelled callers before a shared rotation settles.
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { abortable } from '../../dist/core/cancellation.js';
import { createClient, memoryStorage } from '../../dist/index.js';

assert.equal(typeof globalThis.gc, 'function', 'Run this check with node --expose-gc');

async function retained(references) {
  // WeakRef targets survive their creation job. Collect across separate turns.
  for (let index = 0; index < 10; index++) {
    await setImmediate();
    globalThis.gc();
  }
  return references.filter(reference => reference.deref() !== undefined).length;
}

async function round(number) {
  let finish;
  const operation = new Promise(resolve => { finish = resolve; });
  const active = abortable(operation, new AbortController().signal);
  async function cancel() {
    const controller = new AbortController();
    const reference = new WeakRef(controller.signal);
    const pending = abortable(operation, controller.signal);
    controller.abort();
    assert.equal((await pending).error?.code, 'aborted');
    return reference;
  }
  const references = [];
  for (let index = 0; index < 1000; index++) references.push(await cancel());
  const count = await retained(references);
  assert.equal(count, 0, 'A pending shared operation retained cancelled callers');
  finish('accepted');
  assert.equal((await active).data, 'accepted');
  console.log(JSON.stringify({ round: number, cancelledCallers: references.length, retainedSignalsBeforeCompletion: count }));
  return new WeakRef(operation);
}

const operations = [];
for (let number = 1; number <= 3; number++) operations.push(await round(number));
assert.equal(await retained(operations), 0, 'Completed operations remained rooted');

async function queuedAuthentication(webLocks) {
  const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const queues = new Map();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: webLocks ? { locks: {
    request(name, task) {
      const result = (queues.get(name) ?? Promise.resolve()).then(task);
      queues.set(name, result.then(() => undefined, () => undefined));
      return result;
    },
  } } : {} });
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let requests = 0;
  const client = createClient('https://fixture.example', {
    auth: { autoRefresh: false, storage: memoryStorage() }, retries: 0,
    fetch: async () => { requests++; entered(); await held; return new Response('{"code":"fixture","message":"fixture"}', { status: 400 }); },
  });
  const owner = client.auth.signInWithPassword({ email: 'owner@example.test', password: 'fixture' });
  const references = [];
  async function cancel(index) {
    const controller = new AbortController();
    references.push(new WeakRef(controller.signal));
    const waiting = client.auth.signInWithPassword({ email: `queued${index}@example.test`, password: 'fixture' }, { signal: controller.signal });
    controller.abort();
    assert.equal((await waiting).error?.code, 'aborted');
  }
  try {
    await started;
    await Promise.all(Array.from({ length: 200 }, (_, index) => cancel(index)));
    assert.equal(await retained(references), 0, 'Queued authentication retained cancelled signals');
    assert.equal(requests, 1);
    console.log(JSON.stringify({ webLocks, queuedAuthentication: references.length, retainedSignalsBeforeOwnerCompletes: 0 }));
  } finally {
    release(); await owner; client.dispose();
    if (navigator) Object.defineProperty(globalThis, 'navigator', navigator);
    if (!navigator) delete globalThis.navigator;
  }
}

await queuedAuthentication(false);
await queuedAuthentication(true);
