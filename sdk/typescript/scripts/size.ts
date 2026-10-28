#!/usr/bin/env bun
// Size budget per entry point: the gzip size of every module an import pulls
// in (its static import closure), compiled without comments and before any
// minifier, which shrinks it further. The budget also keeps the dependency
// graph honest, e.g. that importing the REST client never drags auth along.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = mkdtempSync(join(tmpdir(), 'nelcota-sdk-size-'));
const tsc = spawnSync(
  process.execPath,
  [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.build.json'), '--outDir', dist, '--removeComments', '--declaration', 'false', '--isolatedDeclarations', 'false'],
  { stdio: 'inherit' },
);
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
process.on('exit', () => rmSync(dist, { recursive: true, force: true }));

const BUDGETS: Record<string, number> = {
  // Includes shared cancellation, explicit row/bucket contract validation and
  // the optional Postgres error fields, pages() and throwOnError()/unwrap().
  // Bounded streaming error reads add about 200 B gzip to the HTTP closure.
  // Lossless JSON decoding adds about 380 B gzip to each HTTP closure.
  // Session-shape, refresh-margin and non-finite JSON input guards.
  // Native IndexedDB session handoff adds about 1.5 KiB gzip to auth/root only.
  // Receipt revisions, pre-auth snapshots and PKCE ownership add about 360 B gzip.
  // Removable cancellation waiters add 187–204 B gzip to the shared HTTP closure.
  // Maintainer-approved input/representation guards: +300 B maximum root/storage,
  // +50 B auth. Covers null storage replies, missing bodies and blank OAuth codes.
  // Open-issue corrections (#132-#142) add about 1 KiB gzip to root/auth and
  // 200-350 B to REST/storage: per-adapter refresh queues, cross-tab identity
  // checks, reserved-column filters, post-header deadlines and sign-out revocation.
  // Splitting the session lifecycle into store, scheduler and manager modules
  // (one responsibility each) adds about 400 B gzip to root/auth.
  // Rejecting invalid Date/bigint JSON bodies, a size-free query check and a quick
  // first retry inside the server's refresh-reuse window add about 130 B gzip.
  // Skipping the lossless-number rewrite pass when no token can lose digits
  // (8-12x faster parsing of typical responses) adds 13-44 B gzip to every
  // entry point below; each budget rose by 50 B for it.
  // Initial-session subscriptions and exact write counts add 127 B at root,
  // 110 B to auth and 21 B to REST; the independent testing entry adds no bytes here.
  'index.js': 19_250,
  // Standalone factories include HTTP and keep the other feature modules out.
  'rest/index.js': 10_100,
  // Failed persistence must retain rotated tokens; background failures are observed.
  'auth/index.js': 13_050,
  'storage/index.js': 8_050,
};

function closure(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const code = readFileSync(entry, 'utf8');
  // Runtime imports only: `import type` is erased by tsc.
  for (const [, specifier = ''] of code.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]/g)) {
    closure(resolve(dirname(entry), specifier), seen);
  }
  return seen;
}

let failed = false;
for (const [entry, budget] of Object.entries(BUDGETS)) {
  const files = [...closure(resolve(dist, entry))];
  const source = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const size = gzipSync(source, { level: 9 }).length;
  const ok = size <= budget;
  failed ||= !ok;
  const modules = files.map((f) => f.slice(dist.length + 1).replace(/\\/g, '/')).sort();
  console.log(`${ok ? 'ok  ' : 'OVER'} ${entry.padEnd(18)} ${String(size).padStart(6)} B gzip (budget ${budget})  ${modules.join(', ')}`);
}
if (failed) {
  console.error('\nA size budget was exceeded: trim the code or raise the budget on purpose.');
  process.exit(1);
}
