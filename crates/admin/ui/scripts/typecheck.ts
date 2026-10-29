import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const svelteCheck = fileURLToPath(
  new URL("./bin/svelte-check", import.meta.resolve("svelte-check/package.json")),
);
const compiler = fileURLToPath(
  new URL("./bin/tsc", import.meta.resolve("typescript-7/package.json")),
);
const checks = [
  [svelteCheck, "--tsconfig", "tsconfig.app.json"],
  ...["node", "e2e", "scripts"].map((scope) => [compiler, "-p", `tsconfig.${scope}.json`]),
];

for (const args of checks) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    process.exitCode = 1;
    break;
  }
}
