import { spawnSync } from "node:child_process";
// Shared setup for the real-Next smoke scripts.
import { lstat, mkdir, readlink, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureObject, fixtureString } from "./fixture-values.mjs";

const WEBPACK_FLAG_MAJOR = 16;
const MAX_BUILD_OUTPUT_BYTES = 4_194_304;

export const root = fileURLToPath(new URL("../", import.meta.url));
const registryExample = process.env.NELCOTA_NEXT_EXAMPLE_DIR;
export const example =
  registryExample != null && registryExample !== ""
    ? resolve(registryExample)
    : fileURLToPath(new URL("../examples/app-router/", import.meta.url));
const dependencies = createRequire(
  registryExample != null && registryExample !== ""
    ? join(example, "package.json")
    : import.meta.url,
);
export const nextVersion = fixtureString(fixtureObject(dependencies("next/package.json")).version);
export const nextBin = dependencies.resolve("next/dist/bin/next");

/** The example imports `@nelcota/nextjs`. Resolve it from the package's own
 * (gitignored) node_modules so the example and the package share one copy of
 * next/react; a second installed copy would split Next's request storage. */
export async function linkPackage() {
  if (registryExample != null && registryExample !== "") return; // External consumers must keep their registry dependencies.
  const scope = new URL("../node_modules/@nelcota/", import.meta.url),
    link = new URL("nextjs", scope);
  await mkdir(scope, { recursive: true });
  try {
    const stat = await lstat(link);
    if (stat.isSymbolicLink() === false || (await readlink(link)) !== "../..")
      throw new Error(`Refusing to replace ${fileURLToPath(link)}`);
  } catch (error) {
    if (error instanceof Error === false || ("code" in error && error.code === "ENOENT") === false)
      throw error;
    await symlink("../..", link, "dir");
  }
}

/** Real production webpack build of the example; returns the spawn result. */
/** @param {Readonly<Record<string, string | undefined>>} [environment] */
export function buildExample(environment = {}) {
  const major = Number(nextVersion.split(".")[0]);
  const result = spawnSync(
    process.execPath,
    [nextBin, "build", ...(major >= WEBPACK_FLAG_MAJOR ? ["--webpack"] : [])],
    {
      cwd: example,
      env: {
        ...process.env,
        ...environment,
        NELCOTA_NEXT_CHECKOUT: registryExample != null && registryExample !== "" ? "0" : "1",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: MAX_BUILD_OUTPUT_BYTES,
    },
  );
  if (result.error != null) throw result.error;
  return result;
}
