// Shared setup for the real-Next smoke scripts.
import { lstat, mkdir, readlink, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const example = fileURLToPath(new URL('../examples/app-router/', import.meta.url));
export const nextBin = fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url));

/** The example imports `@nelcota/nextjs`. Resolve it from the package's own
 * (gitignored) node_modules so the example and the package share one copy of
 * next/react; a second installed copy would split Next's request storage. */
export async function linkPackage() {
  const scope = new URL('../node_modules/@nelcota/', import.meta.url), link = new URL('nextjs', scope);
  await mkdir(scope, { recursive: true });
  try {
    const stat = await lstat(link);
    if (!stat.isSymbolicLink() || await readlink(link) !== '../..') throw new Error(`Refusing to replace ${fileURLToPath(link)}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await symlink('../..', link, 'dir');
  }
}

/** Real production webpack build of the example; returns the spawn result. */
export function buildExample() {
  const result = spawnSync(process.execPath, [nextBin, 'build', '--webpack'], { cwd: example, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}
