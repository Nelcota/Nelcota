import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fixturePort } from "./fixture-values.mjs";
const requestTimeoutInMs = 1000,
  delayInMs = 100;
/** Creates only a disposable directory and a reserved loopback port. */
export async function backendResources() {
  const directory = await fixtureDirectory("nelcota-next-backend-");
  const port = await reservePort();
  return { directory, port };
}
export class Jar {
  /** @type {Map<string, string>} */
  values = new Map();
  /** @param {string} name */
  get(name) {
    const value = this.values.get(name);
    return value === undefined ? undefined : { value };
  }
  /** @param {string} name
   * @param {string} value
   * @param {Parameters<import("../dist/context.js").CookieWriter["set"]>[2]} options */
  set(name, value, options) {
    if (options.maxAge === 0) this.values.delete(name);
    else this.values.set(name, value);
  }
}
/** @param {string} origin
 * @param {import("node:child_process").ChildProcess} child
 * @param {() => string} diagnostics
 * @returns {Promise<void>} */
export async function waitForBackend(origin, child, diagnostics) {
  for (let attempt = 0; ; attempt++) {
    // oxlint-disable-next-line no-await-in-loop -- Keep requests within this fixture worker ordered and wait between bounded readiness attempts.
    const response = await fetch(`${origin}/health`, {
      signal: AbortSignal.timeout(requestTimeoutInMs),
    }).catch(() => null);
    if (response?.ok === true) return;
    if (attempt > 100 || child.exitCode !== null)
      throw new Error("Disposable backend failed to start: " + diagnostics());
    // oxlint-disable-next-line no-await-in-loop -- Keep requests within this fixture worker ordered and wait between bounded readiness attempts.
    await new Promise((resolve) => setTimeout(resolve, delayInMs));
  }
}

/** @param {import("../dist/context.js").Integration<unknown>} integration @param {Jar} jar @returns {Promise<void>} */
export async function waitForCatalog(integration, jar) {
  for (let attempt = 0; ; attempt++) {
    // oxlint-disable-next-line no-await-in-loop -- Keep requests within this fixture worker ordered and wait between bounded readiness attempts.
    const ready = await integration.read(jar, (context) =>
      context.client.from("next_notes").select().execute(),
    );
    if (Boolean(ready.error) === false) break;
    if (attempt > 100) throw new Error("Catalog did not discover the fixture");
    // oxlint-disable-next-line no-await-in-loop -- Keep requests within this fixture worker ordered and wait between bounded readiness attempts.
    await new Promise((resolve) => setTimeout(resolve, delayInMs));
  }
}

/** Creates a new temporary directory owned by the disposable server fixture. @param {string} prefix */
export function fixtureDirectory(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}
/** Reserves an unused loopback port and releases the probe before returning it. */
export async function reservePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = fixturePort(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
