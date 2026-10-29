import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { createServer } from "node:http";

import { example, nextBin } from "../example.mjs";
import { fixturePort } from "../fixture-values.mjs";
const requestTimeoutInMs = 1000,
  delayInMs = 100,
  forceStopInMs = 3000;
/** Owns the local API and Next processes used by the framework smoke. */
export class FrameworkProcesses {
  output = createWriteStream(process.env.NELCOTA_NEXT_LOG ?? "/tmp/nelcota-next-framework.log", {
    mode: 0o600,
  });
  /** @type {import("node:child_process").ChildProcessByStdio<null, import("node:stream").Readable, import("node:stream").Readable>[]} */
  children = [];
  /** @param {import("./auth.mjs").FrameworkAuth} auth */
  constructor(auth) {
    this.api = createServer((request, response) => {
      void auth.handle(request, response).catch((error) => {
        response.destroy(
          error instanceof Error ? error : new Error("Request handler failed", { cause: error }),
        );
      });
    });
  }
  /** @param {URL} database @param {string} key */
  async start(database, key) {
    this.api.listen(0, "127.0.0.1");
    await once(this.api, "listening");
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = fixturePort(reservation);
    await new Promise((resolve) => reservation.close(resolve));
    const origin = `http://localhost:${port}`;
    /** @type {string[]} */
    const destinations = [];
    for (let instance = 0; instance < 2; instance++) {
      // oxlint-disable-next-line no-await-in-loop -- Each owned process must finish startup before the next instance starts.
      destinations.push(await this.startInstance({ database, key, origin, port, instance }));
    }
    return { origin, destinations };
  }
  /** @param {{database: URL, key: string, origin: string, port: number, instance: number}} fixture */
  async startInstance({ database, key, origin, port, instance }) {
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    // oxlint-disable-next-line no-await-in-loop -- Advance the shared browser/server fixture only after this response or cleanup step settles.
    await once(probe, "listening");
    const nextPort = instance === 0 ? port : fixturePort(probe);
    // oxlint-disable-next-line no-await-in-loop -- Advance the shared browser/server fixture only after this response or cleanup step settles.
    await new Promise((resolve) => probe.close(resolve));
    const destination = `http://localhost:${nextPort}`;

    const child = spawn(
      process.execPath,
      [nextBin, "start", "-p", String(nextPort), "-H", "127.0.0.1"],
      {
        cwd: example,
        env: {
          ...process.env,
          NEXT_TELEMETRY_DISABLED: "1",
          NELCOTA_URL: `http://127.0.0.1:${fixturePort(this.api)}`,
          APP_ORIGIN: origin,
          NELCOTA_SESSION_KEY: key,
          NELCOTA_NEXT_SESSION_DATABASE_URL: database.href,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.children.push(child);
    child.stdout.pipe(this.output);
    child.stderr.pipe(this.output);
    // oxlint-disable-next-line no-await-in-loop -- Advance the shared browser/server fixture only after this response or cleanup step settles.
    await waitForNext(destination, child);
    return destination;
  }
  async stop() {
    for (const child of this.children.filter((child) => child.exitCode === null)) {
      const stopped = once(child, "close");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), forceStopInMs);
      // oxlint-disable-next-line no-await-in-loop -- Advance the shared browser/server fixture only after this response or cleanup step settles.
      await stopped;
      clearTimeout(timer);
    }
  }
  async closeApi() {
    await new Promise((resolve) => this.api.close(resolve));
    this.output.end();
  }
}
/** @param {string} destination
 * @param {import("node:child_process").ChildProcess} child
 * @returns {Promise<void>} */
async function waitForNext(destination, child) {
  for (let attempt = 0; ; attempt++) {
    // oxlint-disable-next-line no-await-in-loop -- Advance the shared browser/server fixture only after this response or cleanup step settles.
    const response = await fetch(destination, {
      signal: AbortSignal.timeout(requestTimeoutInMs),
    }).catch(() => null);
    if (response?.ok === true) return;
    if (attempt >= 100 || child.exitCode !== null)
      throw new Error("Next fixture startup failed; see private log");
    // oxlint-disable-next-line no-await-in-loop -- Advance the shared browser/server fixture only after this response or cleanup step settles.
    await new Promise((resolve) => setTimeout(resolve, delayInMs));
  }
}
