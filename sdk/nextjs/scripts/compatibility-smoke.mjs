// Test an earlier Next major in a disposable consumer, preserving the main install.
import { cp, mkdtemp, mkdir, readFile, writeFile, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const version = process.env.NELCOTA_NEXT_COMPAT_VERSION ?? '15.5.28';
assert.equal(version, '15.5.28', 'Only the reviewed, pinned compatibility fixture is allowed');
const sdk = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'nelcota-next-compat-'));
const target = join(directory, 'nextjs');
async function run(command, args, cwd = target) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${code ?? signal})`)));
  });
}
try {
  await cp(sdk, target, { recursive: true, filter: path => !['node_modules', '.next', '.git'].includes(path.split('/').at(-1)) });
  // The base SDK remains the exact built local dependency used by the normal smokes.
  await mkdir(join(directory, 'typescript'));
  await cp(join(sdk, '../typescript/dist'), join(directory, 'typescript/dist'), { recursive: true });
  await cp(join(sdk, '../typescript/package.json'), join(directory, 'typescript/package.json'));
  await symlink(join(sdk, '../typescript/node_modules'), join(directory, 'typescript/node_modules'), 'dir');
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  manifest.devDependencies.next = version;
  manifest.peerDependencies.next = `^${version}`;
  await writeFile(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await rm(join(target, 'package-lock.json'));
  const example = join(target, 'examples/app-router');
  const app = JSON.parse(await readFile(join(example, 'package.json'), 'utf8'));
  app.dependencies.next = version;
  await writeFile(join(example, 'package.json'), JSON.stringify(app, null, 2) + '\n');
  // Next 15 uses middleware.ts with an explicit Node runtime; Next 16 uses proxy.ts.
  const source = await readFile(join(example, 'proxy.ts'), 'utf8');
  await rename(join(example, 'proxy.ts'), join(example, 'middleware.ts'));
  await writeFile(join(example, 'middleware.ts'), source.replace('function proxy(', 'function middleware(').replace('export const config = {', "export const config = { runtime: 'nodejs',"));
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
  await run('npm', ['audit', '--audit-level=high']);
  await run('npm', ['run', 'check']);
  await run(process.execPath, ['scripts/boundary-smoke.mjs']);
  await run(process.execPath, ['scripts/framework-smoke.mjs']);
  console.log(JSON.stringify({ next: version, node: process.version, browser: process.env.NELCOTA_NEXT_BROWSER ?? 'chromium', checks: ['typecheck', 'server-only production boundary', 'production framework and two-process PostgreSQL sessions'], fixture: 'removed in finally' }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
