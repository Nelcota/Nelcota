import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
// Install actual tarballs in an external disposable consumer; never publish.
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureArray, fixtureObject, fixtureString } from "./fixture-values.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "nelcota-next-package-"));
const publishedBase = process.argv.includes("--published-base");
/** @param {string} command
 * @param {string[]} args
 * @param {string} [cwd] */
function run(command, args, cwd = directory) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 90000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, npm_config_cache: join(directory, ".npm-cache") },
  });
  if (result.error != null) throw result.error;
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  return result.stdout;
}
// npm <= 11 prints an array of pack results; npm 12 prints an object keyed by package name.
/** @param {string} cwd */
function packed(cwd) {
  /** @type {unknown} */
  const output = JSON.parse(
    run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", directory], cwd),
  );
  const results = Array.isArray(output) ? output : Object.values(fixtureObject(output));
  assert.equal(results.length, 1, "expected exactly one packed package");
  const packed = fixtureObject(results[0]);
  assert.equal(typeof packed.size, "number");
  if (typeof packed.size !== "number") throw new Error("Invalid packed size");
  return {
    filename: fixtureString(packed.filename),
    size: packed.size,
    files: fixtureArray(packed.files).map((file) => ({
      path: fixtureString(fixtureObject(file).path),
    })),
  };
}
/** Install commands must name every required peer the application does not already have,
 * and the SSR core dependency range must accept the checkout core packed with it. */
async function installDocumentation() {
  const manifest = fixtureObject(JSON.parse(await readFile(join(root, "package.json"), "utf8")));
  const core = fixtureObject(
    JSON.parse(await readFile(resolve(root, "../ssr/package.json"), "utf8")),
  );
  const range = fixtureString(fixtureObject(manifest.dependencies)["@nelcota/ssr"]);
  assert.match(range, /^~\d+\.\d+\.\d+$/, "@nelcota/ssr must stay a tilde (patch-only) dependency");
  const [major, minor, patch] = fixtureString(core.version).split(".").map(Number);
  const [wantMajor, wantMinor, wantPatch] = range.slice(1).split(".").map(Number);
  assert(
    major === wantMajor && minor === wantMinor && (patch ?? 0) >= (wantPatch ?? 0),
    `@nelcota/ssr ${fixtureString(core.version)} does not satisfy ${range}`,
  );
  // The host Next application already provides these framework peers.
  const host = new Set(["next", "react"]);
  const peers = Object.keys(fixtureObject(manifest.peerDependencies)).filter(
    (name) => host.has(name) === false,
  );
  for (const guide of ["README.md", "docs/quickstart.pt-BR.md"]) {
    // oxlint-disable-next-line no-await-in-loop -- Two small local files, checked in order.
    const text = await readFile(join(root, guide), "utf8");
    const installs = text
      .split("\n")
      .filter((line) => /\b(bun add|npm install)\b.*@nelcota\/nextjs@/.test(line));
    assert(installs.length > 0, `${guide} has no install command`);
    const omitted = peers.filter((peer) => installs.some((line) => line.includes(peer) === false));
    assert.deepEqual(omitted, [], `${guide} install lines omit required peers`);
  }
}
try {
  const next = packed(root);
  // The SSR core is a regular dependency; pack the checkout so unreleased core changes are tested.
  const ssr = packed(resolve(root, "../ssr"));
  await installDocumentation();
  const client = publishedBase ? null : packed(resolve(root, "../typescript"));
  assert(next.files.some((file) => file.path === "dist/server.js"));
  assert(ssr.files.some((file) => file.path === "sql/session-store.sql"));
  assert(
    Boolean(ssr.files.some((file) => /(^|\/)(node_modules|test|\.env)(\/|$)/.test(file.path))) ===
      false,
  );
  assert(
    Boolean(
      next.files.some((file) => /(^|\/)(node_modules|test|examples|\.env)(\/|$)/.test(file.path)),
    ) === false,
  );
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--omit=optional",
    join(directory, next.filename),
    join(directory, ssr.filename),
    client != null ? join(directory, client.filename) : "@nelcota/client@0.2.2",
    "next@16.4.3",
    "react@19.3.1",
    "@types/react@19.3.0",
  ]);
  await writeFile(
    join(directory, "consumer.mjs"),
    `import { createNelcotaNext, SessionError } from '@nelcota/nextjs/server';
import { PostgresSessionStore } from '@nelcota/nextjs/postgres';
import { createNelcotaProxy } from '@nelcota/nextjs/proxy';
import { refreshSession } from '@nelcota/nextjs/browser';
import { DevelopmentSessionStore } from '@nelcota/nextjs/testing';
if ([createNelcotaNext, SessionError, PostgresSessionStore, createNelcotaProxy, refreshSession, DevelopmentSessionStore].some(value => typeof value !== 'function')) throw new Error('Invalid export');
`,
  );
  run(process.execPath, ["--conditions=react-server", "consumer.mjs"]);
  await writeFile(
    join(directory, "consumer.ts"),
    `import { createNelcotaNext, type NextOptions } from '@nelcota/nextjs/server';
import type { SessionStore } from '@nelcota/nextjs/server';
import { PostgresSessionStore, type SessionPool } from '@nelcota/nextjs/postgres';
import { createNelcotaProxy } from '@nelcota/nextjs/proxy';
import { refreshSession } from '@nelcota/nextjs/browser';
import { DevelopmentSessionStore } from '@nelcota/nextjs/testing';
declare const options: NextOptions;
const integration = await createNelcotaNext(options);
await integration.server(async context => {
  const user = await context.getUser();
  if (!user.error) user.data.id satisfies string;
  // @ts-expect-error read contexts expose no managed auth client
  context.client.auth;
});
await integration.route(new Request('https://app.test'), async context => {
  const result = await context.auth.refresh();
  if (!result.error && result.data) {
    result.data.user.id satisfies string;
    // @ts-expect-error credentials are not exposed by auth operation results
    result.data.refresh_token;
  }
  return new Response();
});
const memory: SessionStore = new DevelopmentSessionStore();
void memory; void PostgresSessionStore; void createNelcotaProxy; void refreshSession;
`,
  );
  run(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "--ignoreConfig",
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--module",
    "NodeNext",
    "--target",
    "ES2022",
    "consumer.ts",
  ]);
  const packageData = fixtureObject(
    JSON.parse(
      await readFile(join(directory, "node_modules/@nelcota/nextjs/package.json"), "utf8"),
    ),
  );
  assert.equal(packageData.private, false);
  assert.equal(fixtureObject(packageData.publishConfig).access, "public");
  // Consumers never import the core directly: it ships as a dependency, not a peer.
  assert.equal(typeof fixtureObject(packageData.dependencies)["@nelcota/ssr"], "string");
  assert.equal("@nelcota/ssr" in fixtureObject(packageData.peerDependencies), false);
  assert.equal(fixtureObject(packageData.publishConfig).registry, "https://registry.npmjs.org/");
  console.log(
    JSON.stringify(
      {
        exports: Object.keys(fixtureObject(packageData.exports)),
        files: next.files.length,
        packedBytes: next.size,
        private: packageData.private,
        base: publishedBase ? "npm @nelcota/client@0.2.2" : "local packed base SDK",
        consumer:
          "actual external npm install, all exports and strict TypeScript declarations; Next server-only condition explicit",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
