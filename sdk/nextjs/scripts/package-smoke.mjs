// Install actual tarballs in an external disposable consumer; never publish.
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'nelcota-next-package-'));
function run(command, args, cwd = directory) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, npm_config_cache: join(directory, '.npm-cache') } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  return result.stdout;
}
try {
  const next = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], root))[0];
  const client = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], resolve(root, '../typescript')))[0];
  assert(next.files.some(file => file.path === 'dist/server.js'));
  assert(next.files.some(file => file.path === 'sql/session-store.sql'));
  assert(!next.files.some(file => /(^|\/)(node_modules|test|examples|\.env)(\/|$)/.test(file.path)));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', join(directory, next.filename), join(directory, client.filename), 'next@16.4.3', 'react@19.3.1', '@types/react@19.3.0']);
  await writeFile(join(directory, 'consumer.mjs'), `import { createNelcotaNext, SessionError } from '@nelcota/nextjs/server';
import { PostgresSessionStore } from '@nelcota/nextjs/postgres';
import { createNelcotaProxy } from '@nelcota/nextjs/proxy';
import { refreshSession } from '@nelcota/nextjs/browser';
import { DevelopmentSessionStore } from '@nelcota/nextjs/testing';
if ([createNelcotaNext, SessionError, PostgresSessionStore, createNelcotaProxy, refreshSession, DevelopmentSessionStore].some(value => typeof value !== 'function')) throw new Error('Invalid export');
`);
  run(process.execPath, ['--conditions=react-server', 'consumer.mjs']);
  await writeFile(join(directory, 'consumer.ts'), `import { createNelcotaNext, type NextOptions } from '@nelcota/nextjs/server';
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
`);
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc6'), '--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--target', 'ES2022', 'consumer.ts']);
  const packageData = JSON.parse(await readFile(join(directory, 'node_modules/@nelcota/nextjs/package.json'), 'utf8'));
  assert.equal(packageData.private, true);
  console.log(JSON.stringify({ exports: Object.keys(packageData.exports), files: next.files.length, packedBytes: next.size, private: true, consumer: 'actual external npm install, all exports and strict TypeScript declarations; Next server-only condition explicit' }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
