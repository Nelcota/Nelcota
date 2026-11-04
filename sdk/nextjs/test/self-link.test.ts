import {
  mkdtemp,
  mkdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, test } from "vitest";

import { linkSelf } from "../scripts/self-link.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "nelcota-self-link-"));
  directories.push(directory);
  const packageRoot = join(directory, "package");
  const scope = join(packageRoot, "node_modules", "@nelcota");
  await mkdir(scope, { recursive: true });
  return {
    directory,
    packageRoot,
    link: join(scope, "nextjs"),
    url: pathToFileURL(packageRoot + sep),
  };
}

test("the checkout link is idempotent with native path separators", async () => {
  const { packageRoot, link, url } = await fixture();
  await linkSelf(url);
  await linkSelf(url);
  expect(await realpath(link)).toBe(await realpath(packageRoot));
});

test("a foreign symbolic link is rejected and preserved", async () => {
  const { directory, link, url } = await fixture();
  const other = join(directory, "foreign");
  await mkdir(other);
  await symlink(other, link, "dir");
  const before = await readlink(link);
  await expect(linkSelf(url)).rejects.toThrow("Refusing to replace");
  expect(await readlink(link)).toBe(before);
});

test("an installed directory is rejected without deleting its contents", async () => {
  const { link, url } = await fixture();
  await mkdir(link);
  const marker = join(link, "marker");
  await writeFile(marker, "keep");
  await expect(linkSelf(url)).rejects.toThrow("Refusing to replace");
  expect(await readFile(marker, "utf8")).toBe("keep");
});
