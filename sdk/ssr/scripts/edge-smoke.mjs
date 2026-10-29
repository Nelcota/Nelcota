// Bundle the core for web runtimes and execute it without Node globals/imports.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyReleasedEnvelopes } from "./edge-envelopes-smoke.mjs";
import { edgeLoader } from "./edge-loader.mjs";
import { verifyEdgeSession } from "./edge-session-smoke.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.includes("--sandbox") === false) await checkBundles();
else await checkSandbox();

/** @returns {Promise<void>} */
async function checkBundles() {
  const temporary = mkdtempSync(join(tmpdir(), "nelcota-edge-"));
  try {
    const result = await Bun.build({
      entrypoints: [
        join(root, "src/index.ts"),
        join(root, "src/sealing/seal.ts"),
        join(root, "src/memory-store.ts"),
      ],
      target: "browser",
      format: "esm",
      minify: false,
    });
    if (Boolean(result.success) === false) throw new Error(JSON.stringify(result.logs));
    const sources = await Promise.all(
      result.outputs.map(async (output) => [output.path.split("/").at(-1), await output.text()]),
    );
    const path = join(temporary, "bundles.json");
    writeFileSync(path, JSON.stringify(Object.fromEntries(sources)));
    const child = spawnSync(
      "node",
      ["--experimental-vm-modules", fileURLToPath(import.meta.url), "--sandbox", path],
      { stdio: "inherit" },
    );
    if (child.status !== 0) process.exitCode = child.status ?? 1;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** @returns {Promise<void>} */
async function checkSandbox() {
  const bundlePath = process.argv.at(-1);
  assert(bundlePath != null && bundlePath !== "");
  const load = edgeLoader(bundlePath);
  const { Integration } = await load("index.js");
  const { DevelopmentSessionStore } = await load("memory-store.js");
  const sealing = await load("seal.js");
  const secret = randomBytes(32).toString("base64url");
  await verifyReleasedEnvelopes(secret, sealing);
  await verifyEdgeSession({ Integration, DevelopmentSessionStore }, secret);
  console.log(
    "PASS: web bundle without Node globals, released v1/v2 envelopes, stable hashes, opaque-cookie sign-in/read/sign-out and CSRF rejection",
  );
}
