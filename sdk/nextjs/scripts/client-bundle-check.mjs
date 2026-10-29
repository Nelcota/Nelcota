import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const SERVER_CANARIES = [
  "NELCOTA_SESSION_KEY",
  "NELCOTA_NEXT_SESSION_DATABASE_URL",
  "nelcota_next.sessions",
  "fixture-access-private-",
  "fixture-refresh-private-",
];

/** Inspect the production client output for server-only imports and private fixture values.
 * @param {string} staticRoot
 * @param {string} buildKey
 * @returns {Promise<number>} Number of inspected JavaScript chunks. */
export async function verifyClientBundles(staticRoot, buildKey) {
  let count = 0;
  for (const file of await readdir(staticRoot, { recursive: true })) {
    if (file.endsWith(".js") === false) continue;
    // oxlint-disable-next-line no-await-in-loop -- Inspect client chunks one at a time to bound read memory while checking server credential canaries.
    const source = await readFile(join(staticRoot, file), "utf8");
    assert(source.includes(buildKey) === false, "Client chunk exposed the server encryption key");
    assert(
      SERVER_CANARIES.every((marker) => source.includes(marker) === false),
      "Client chunk contains a server-session or credential canary",
    );
    count++;
  }
  assert(count > 0, "No production client chunks were inspected");
  return count;
}
