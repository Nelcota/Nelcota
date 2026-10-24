// Deliberately invalid Client Component must be rejected by a real Next build.
import { mkdir, writeFile, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { buildExample, linkPackage } from './example.mjs';
await linkPackage();
// Control: the valid application must build, so the failure below is the probe's.
const control = buildExample();
assert.equal(control.status, 0, 'valid example build failed:\n' + control.stdout + control.stderr);
const directory = new URL('../examples/app-router/app/boundary-probe/', import.meta.url);
await mkdir(directory); // refuse to overwrite an existing application route
try {
  await writeFile(new URL('page.tsx', directory), "'use client';\nimport { createNelcotaNext } from '@nelcota/nextjs/server';\nexport default function Probe() { return <p>{typeof createNelcotaNext}</p>; }\n");
  const result = buildExample();
  assert.notEqual(result.status, 0);
  const output = result.stdout + result.stderr;
  assert.doesNotMatch(output, /Module not found/);
  assert.match(output, /server-only|Server Component/);
  console.log('PASS: real Next production build rejected a server entry imported by a Client Component');
} finally { await rm(directory, { recursive: true, force: true }); }
const rebuilt = buildExample();
assert.equal(rebuilt.status, 0, 'valid example rebuild failed:\n' + rebuilt.stdout + rebuilt.stderr);
console.log('PASS: valid example rebuilt after removing the probe');
