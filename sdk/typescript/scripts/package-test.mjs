// Install the tarball in a clean consumer; repository imports cannot hide
// missing exports, declarations, license files or accidental dependencies.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const taskDir = mkdtempSync(join(tmpdir(), 'nelcota-package-'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this check with npm run test:package');

function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: process.env });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Command failed (${result.status})`);
  return result.stdout;
}

try {
  const packOutput = JSON.parse(run([npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', taskDir]));
  const [packed] = Array.isArray(packOutput) ? packOutput : Object.values(packOutput);
  const paths = packed.files.map((file) => file.path);
  for (const required of ['LICENSE', 'README.md', 'CHANGELOG.md', 'docs/quickstart.pt-BR.md', 'dist/index.js', 'dist/index.d.ts']) {
    assert(paths.includes(required), `Missing published file: ${required}`);
  }
  assert(paths.every((path) => /^(dist\/|docs\/|examples\/|README\.md$|CHANGELOG\.md$|LICENSE$|package\.json$)/.test(path)), 'Unexpected published files');
  // Maintainer-only documents stay in the repository.
  assert(!paths.includes('docs/releasing.md'), 'docs/releasing.md must not be published');
  const consumer = join(taskDir, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run([npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', join(taskDir, packed.filename)], consumer);
  const installed = join(consumer, 'node_modules/@nelcota/client');
  const metadata = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.equal(Object.keys(metadata.dependencies ?? {}).length, 0, 'Runtime dependencies were added');
  for (const entry of Object.values(metadata.exports)) {
    if (typeof entry === 'string') { assert(existsSync(join(installed, entry))); continue; }
    for (const target of Object.values(entry)) assert(existsSync(join(installed, target)), `Missing export: ${target}`);
  }
  writeFileSync(join(consumer, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { createClient, NelcotaUsageError } from '@nelcota/client';
import { createRestClient } from '@nelcota/client/rest';
import { createAuthClient } from '@nelcota/client/auth';
import { createStorageClient } from '@nelcota/client/storage';
import { withRollbackTransaction } from '@nelcota/client/testing';
const session = { access_token: 'access', token_type: 'bearer', expires_in: 900,
  expires_at: Math.floor(Date.now()/1000)+900, refresh_token: 'refresh',
  user: {id:'u1',email:'a@example.com',email_confirmed_at:null,user_metadata:{},created_at:'',last_sign_in_at:null} };
const fetch = async (url, init) => new Response(String(url).includes('/precise') ? '[{"id":9007199254740993}]' : JSON.stringify(
  String(url).includes('/auth/') ? session : String(url).includes('/storage/') ? {folders:[],objects:[]} : [{id:1}]
), {headers:{'content-type':'application/json'}});
const options = {fetch, accessToken:()=> 'access'};
assert.deepEqual((await createClient('https://api.example.com', options).from('notes').select()).data, [{id:1}]);
assert.deepEqual((await createRestClient('https://api.example.com', options).from('notes').select()).data, [{id:1}]);
for (const factory of [createClient, createRestClient]) {
  assert.deepEqual((await factory('https://api.example.com', options).from('precise').select()).data, [{id:'9007199254740993'}]);
}
const auth = createAuthClient('https://api.example.com', {fetch});
assert.equal((await auth.signInWithPassword({email:'a@example.com',password:'pw'})).data.access_token, 'access');
assert.deepEqual((await createStorageClient('https://api.example.com', options).from('files').list()).data, {folders:[],objects:[]});
assert.throws(()=>createClient('invalid'), NelcotaUsageError);
auth.dispose();
assert.equal(typeof withRollbackTransaction, 'function');
console.log('ok  installed JavaScript package and all five entry points');
`);
  console.log(run([join(consumer, 'consumer.mjs')], consumer).trim());
  copyFileSync(join(root, 'test/types/database.ts'), join(consumer, 'database.ts'));
  writeFileSync(join(consumer, 'consumer.ts'), `
import { createClient } from '@nelcota/client';
import { createRestClient } from '@nelcota/client/rest';
import { createAuthClient } from '@nelcota/client/auth';
import { createStorageClient } from '@nelcota/client/storage';
import type { Database } from './database.js';
const client = createClient<Database>('https://api.example.com');
const result = await client.from('customers').select('id,name');
if (!result.error) {
  const id: number | string = result.data[0]!.id;
  await client.from('customers').select().eq('id', id);
  // @ts-expect-error: a bigint response can exceed JavaScript's numeric precision
  const rounded: number = id;
  void rounded;
}
const rest = createRestClient<Database>('https://api.example.com');
// @ts-expect-error: unknown table
rest.from('missing_table');
// @ts-expect-error: invalid enum
rest.from('orders').insert({total:1,status:'invalid'});
const auth = createAuthClient('https://api.example.com');
await auth.signInWithPassword({email:'a@example.com',password:'pw'}, {signal:new AbortController().signal});
createStorageClient('https://api.example.com', {accessToken:()=>auth.accessToken()}).from('files');
auth.dispose(); client.dispose();
`);
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2023', 'DOM'], types: [], strict: true, noEmit: true,
  }, include: ['*.ts'] }));
  run([join(root, 'node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')], consumer);
  console.log(`ok  installed TypeScript declarations; ${packed.files.length} files, ${packed.size} bytes packed`);
} finally {
  // taskDir is the exact directory created by mkdtemp under the OS temp directory.
  rmSync(taskDir, { recursive: true, force: true });
}
