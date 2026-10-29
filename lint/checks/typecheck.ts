import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const compiler = fileURLToPath(
  new URL("./bin/tsc", import.meta.resolve("typescript-7/package.json")),
);
const configurations = process.argv.slice(2);
if (configurations.length === 0) throw new Error("Provide at least one TypeScript configuration");

for (const configuration of configurations) {
  const result = spawnSync(
    process.execPath,
    [compiler, "--noEmit", "--pretty", "false", "-p", configuration],
    { stdio: "inherit" },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exitCode = 1;
}
