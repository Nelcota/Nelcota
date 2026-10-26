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
  // So is the SSR core (`file:../ssr`), with its SQL schema; the adapter's type
  // check also covers tests that import the core's sources and fixtures.
  await mkdir(join(directory, 'ssr'));
  for (const entry of ['dist', 'sql', 'src', 'test', 'package.json']) await cp(join(sdk, '../ssr', entry), join(directory, 'ssr', entry), { recursive: true });
  // Its only runtime dependency is the base SDK: point it at the same copy as above.
  await mkdir(join(directory, 'ssr/node_modules/@nelcota'), { recursive: true });
  await symlink('../../../typescript', join(directory, 'ssr/node_modules/@nelcota/client'), 'dir');
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  manifest.devDependencies.next = version;
  // Next 15 pins an affected PostCSS release; keep the audit gate enabled.
  manifest.overrides = { ...manifest.overrides, postcss: '8.5.31' };
  // O Next 15 usa a API JavaScript do TypeScript 6; o suporte ao TypeScript 7 começa no Next 16.2.11.
  manifest.devDependencies.typescript = 'npm:@typescript/typescript6@^6.0.2';
  manifest.peerDependencies.next = `^${version}`;
  await writeFile(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  // O lock do checkout fixa o Next 16; o consumidor npm resolve o Next 15 do zero.
  await rm(join(target, 'bun.lock'));
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
  console.log(JSON.stringify({ next: version, postcssOverride: '8.5.31', typescript: 6, node: process.version, browser: process.env.NELCOTA_NEXT_BROWSER ?? 'chromium', checks: ['typecheck', 'server-only production boundary', 'production framework and two-process PostgreSQL sessions'], fixture: 'removed in finally' }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
