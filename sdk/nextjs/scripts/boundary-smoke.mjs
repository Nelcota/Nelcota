// Deliberately invalid Client Component must be rejected by a real Next build.
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const example = fileURLToPath(new URL('../examples/app-router/', import.meta.url));
const directory = new URL('../examples/app-router/app/boundary-probe/', import.meta.url);
await mkdir(directory); // refuse to overwrite an existing application route
try {
  await writeFile(new URL('page.tsx', directory), "'use client';\nimport { createNelcotaNext } from '@nelcota/nextjs/server';\nexport default function Probe() { return <p>{typeof createNelcotaNext}</p>; }\n");
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url)), 'build', '--webpack'], { cwd: example, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /server-only|Server Component/);
  console.log('PASS: real Next production build rejected a server entry imported by a Client Component');
} finally { await rm(directory, { recursive: true, force: true }); }
