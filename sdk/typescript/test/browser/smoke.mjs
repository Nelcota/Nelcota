// The built package in a real Chromium, on another origin than the API, so
// CORS is exercised for real: preflights with Prefer, the exposed
// Content-Range, uploads, the session in localStorage, address-bar cleanup
// and the service_role refusal. Run by scripts/contract.ts --browser.
//
//   node test/browser/smoke.mjs <api url> <service_role token>

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright-core';

const [api, serviceToken] = process.argv.slice(2);
if (!api || !serviceToken) {
  console.error('usage: smoke.mjs <api url> <service_role token>');
  process.exit(2);
}

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist');
const examples = resolve(dirname(fileURLToPath(import.meta.url)), '../../examples');
const page = '<!doctype html><meta charset="utf-8"><title>sdk smoke</title><body>smoke</body>';

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://x').pathname;
  if (path === '/' || path === '/app') {
    response.writeHead(200, { 'content-type': 'text/html' }).end(page);
    return;
  }
  if (path === '/demo' || path === '/examples/browser.js') {
    try {
      const file = path === '/demo' ? 'browser.html' : 'browser.js';
      response.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'text/javascript' }).end(await readFile(join(examples, file)));
    } catch { response.writeHead(404).end(); }
    return;
  }
  const file = normalize(join(dist, path.replace(/^\/dist\//, '/')));
  if (!path.startsWith('/dist/') || !file.startsWith(dist)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const type = extname(file) === '.js' ? 'text/javascript' : 'application/octet-stream';
    response.writeHead(200, { 'content-type': type }).end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const engine = process.env.NELCOTA_SDK_BROWSER ?? 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(engine)) throw new Error(`Unknown browser: ${engine}`);
const browser = await { chromium, firefox, webkit }[engine].launch(
  engine === 'chromium' && process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
);
console.log(`Browser: ${engine}`);
let failed = false;
try {
  const context = await browser.newContext();
  const tab = await context.newPage();
  const failures = [];
  tab.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });
  await tab.goto(`${origin}/app#type=magiclink&token=abc123`);
  const result = await tab.evaluate(
    async ({ api, serviceToken }) => {
      const { createClient, NelcotaUsageError } = await import('/dist/index.js');
      const out = {};
      const nelcota = createClient(api);

      out.link = nelcota.auth.readEmailLink();
      out.cleanedUrl = location.href;

      const email = `browser-${crypto.randomUUID()}@example.com`;
      const signUp = await nelcota.auth.signUp({ email, password: 'browser-password-1' });
      out.signUpError = signUp.error?.code ?? null;
      out.stored = Object.keys(localStorage).filter((k) => k.startsWith('nelcota.'));

      const inserted = await nelcota.from('echo').insert({ value: 'from the browser' }).select('id,value').single();
      out.inserted = inserted.data?.value ?? inserted.error?.message;

      const counted = await nelcota.from('customers').select('id', { count: 'exact' }).limit(1);
      out.count = counted.count;

      const uid = signUp.data?.user.id;
      const files = nelcota.storage.from('private-files');
      const up = await files.upload(`${uid}/browser.txt`, new Blob(['blob body'], { type: 'text/plain' }));
      out.upload = up.error?.code ?? up.data?.size;
      const opened = await files.open(`${uid}/browser.txt`);
      out.etagReadable = Boolean(opened.data?.headers.get('etag'));
      out.download = await opened.data?.text();

      const admin = createClient(api, { accessToken: () => serviceToken });
      try {
        await admin.from('customers').select();
        out.serviceRole = 'allowed';
      } catch (error) {
        out.serviceRole = error instanceof NelcotaUsageError ? 'refused' : String(error);
      }

      const signOut = await nelcota.auth.signOut();
      out.signOut = signOut.error?.code ?? 'ok';
      out.storedAfter = Object.keys(localStorage).filter((k) => k.startsWith('nelcota.'));
      // Retire the first scenario's listeners before the two-tab rotation.
      // A still-live auto-refresh client would act as an unintended third client.
      nelcota.dispose();
      admin.dispose();
      return out;
    },
    { api, serviceToken },
  );

  const expected = {
    link: { type: 'magiclink', token: 'abc123' },
    cleanedUrl: `${origin}/app`,
    signUpError: null,
    stored: [`nelcota.${new URL(api).host}.session`],
    inserted: 'from the browser',
    count: 3,
    upload: 9,
    etagReadable: true,
    download: 'blob body',
    serviceRole: 'refused',
    signOut: 'ok',
    storedAfter: [],
  };
  for (const [key, value] of Object.entries(expected)) {
    const ok = JSON.stringify(result[key]) === JSON.stringify(value);
    failed ||= !ok;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${key}: ${JSON.stringify(result[key])}${ok ? '' : ` (expected ${JSON.stringify(value)})`}`);
  }
  if (failures.length > 0) console.log(`console errors:\n  ${failures.join('\n  ')}`);

  // Two actual pages share localStorage and Web Locks, rather than a mocked
  // lock manager. Rotation must leave both pages with the same live session.
  await tab.evaluate(async (api) => {
    if (!navigator.locks) throw new Error('Cross-tab rotation requires Web Locks');
    const { createClient } = await import('/dist/index.js');
    globalThis.sdkClient = createClient(api, { auth: { autoRefresh: false } });
    const signup = await globalThis.sdkClient.auth.signUp({ email: `tabs-${crypto.randomUUID()}@example.com`, password: 'browser-tabs-password' });
    if (signup.error) throw signup.error;
    const session = (await globalThis.sdkClient.auth.getSession()).data;
    await globalThis.sdkClient.auth.setSession({ ...session, expires_at: Math.floor(Date.now() / 1000) + 5 });
  }, api);
  const other = await context.newPage();
  await other.goto(`${origin}/app`);
  await other.evaluate(async (api) => {
    const { createClient } = await import('/dist/index.js');
    globalThis.sdkClient = createClient(api, { auth: { autoRefresh: false } });
  }, api);
  let refreshRequests = 0;
  const rotationRequests = [];
  for (const page of [tab, other]) page.on('request', request => {
    if (new URL(request.url()).searchParams.get('grant_type') === 'refresh_token') {
      refreshRequests++;
      rotationRequests.push({ page: page === tab ? 'first' : 'second', token: request.postDataJSON().refresh_token });
    }
  });
  const rounds = 100;
  for (let round = 0; round < rounds; round++) {
    const before = refreshRequests;
    const sessions = await Promise.all([tab, other].map((page) => page.evaluate(() => globalThis.sdkClient.auth.getSession())));
    const shared = sessions.every((value) => value.error === null && value.data !== null)
      && sessions[0].data.refresh_token === sessions[1].data.refresh_token
      && refreshRequests - before === 1;
    failed ||= !shared;
    if (!shared) {
      console.log('FAIL refresh across two real tabs');
      console.log('Rotation diagnostics:', {
        round: round + 1,
        refreshRequests: refreshRequests - before,
        errors: sessions.map(value => value.error?.code ?? null),
        present: sessions.map(value => value.data !== null),
        matching: sessions[0].data?.refresh_token === sessions[1].data?.refresh_token,
        sameInputToken: rotationRequests.slice(before).every(request => request.token === rotationRequests[before].token),
        owners: rotationRequests.slice(before).map(request => request.page),
      });
      break;
    }
    if (round === rounds - 1) {
      console.log(`ok  refresh across two real tabs (${rounds} rounds)`);
      break;
    }
    // Keep both clients warm and expiring for the next contention. Transfer
    // the same session without ever printing its tokens in CI diagnostics.
    const expiring = { ...sessions[0].data, expires_at: Math.floor(Date.now() / 1000) + 5 };
    await Promise.all([tab, other].map(page => page.evaluate(session => globalThis.sdkClient.auth.setSession(session), expiring)));
  }
  const oauthSession = (await tab.evaluate(() => globalThis.sdkClient.auth.getSession())).data;
  if (!oauthSession) throw new Error('OAuth fixture needs the native browser session');
  await tab.evaluate(() => globalThis.sdkClient.auth.signOut());
  await other.waitForFunction(async () => (await globalThis.sdkClient.auth.getSession()).data === null);
  console.log('ok  sign-out broadcast to the other tab');

  // Exercise native verifier storage in each engine with a controlled HTTP
  // exchange. Provider validation has dedicated server regressions.
  let challenge = '';
  let exchanges = 0;
  const matchedChallenges = [];
  const callback = (url) => url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'pkce';
  for (const page of [tab, other]) await page.route(callback, async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    exchanges++;
    const verifier = route.request().postDataJSON()?.code_verifier;
    const matches = typeof verifier === 'string' && createHash('sha256').update(verifier).digest('base64url') === challenge;
    matchedChallenges.push(matches);
    await route.fulfill({ status: matches ? 200 : 400, headers: { 'access-control-allow-origin': '*' }, json: matches ? oauthSession : { code: 'invalid_grant', message: 'PKCE mismatch' } });
  });
  for (let flow = 0; flow < 2; flow++) {
    const started = await tab.evaluate(redirectTo => globalThis.sdkClient.auth.signInWithOAuth({ provider: 'github', redirectTo, redirect: false }), `${origin}/app`);
    if (started.error) throw new Error('Native PKCE publication failed');
    challenge = new URL(started.data.url).searchParams.get('code_challenge');
    if (flow === 1) {
      const cancelled = await tab.evaluate(async () => (await globalThis.sdkClient.auth.exchangeCode('browser-code', { signal: AbortSignal.abort() })).error?.code);
      if (cancelled !== 'aborted') throw new Error('Cancelled PKCE exchange did not preserve its claim boundary');
    }
    // Error subclasses lose custom fields across Playwright serialization.
    // Extract codes in the browser so negative assertions verify the SDK result.
    const accepted = await other.evaluate(async () => { const value = await globalThis.sdkClient.auth.exchangeCode('browser-code'); return { code: value.error?.code ?? null, present: Boolean(value.data) }; });
    const repeated = await tab.evaluate(async () => (await globalThis.sdkClient.auth.exchangeCode('browser-code')).error?.code);
    if (accepted.code || !accepted.present || repeated !== 'pkce_missing' || exchanges !== flow + 1) {
      console.log('PKCE diagnostics:', { flow, exchanges, accepted: accepted.code, present: accepted.present, repeated, matchedChallenges });
      throw new Error('Native PKCE handoff or one-time consumption failed');
    }
  }
  for (const page of [tab, other]) await page.unroute(callback);
  console.log('ok  native PKCE across real tabs: matching challenge, one-time consumption and pre-cancelled exchange');
  await Promise.all([tab, other].map((page) => page.evaluate(() => globalThis.sdkClient.dispose())));

  await other.goto(`${origin}/demo`);
  await other.getByLabel('API URL').fill(api);
  await other.getByLabel('Email', { exact: true }).fill(`demo-${Date.now()}-${engine}@example.com`);
  await other.getByLabel('Password', { exact: true }).fill('browser-demo-password');
  await other.getByRole('button', { name: 'Create account', exact: true }).click();
  await other.waitForFunction(() => document.querySelector('#result').textContent.includes('Account created'));
  await other.getByLabel('Note', { exact: true }).fill('Hello from the browser demo');
  await other.getByRole('button', { name: 'Save note', exact: true }).click();
  await other.waitForFunction(() => document.querySelector('#result').textContent.includes('Hello from the browser demo'));
  await other.getByLabel('File', { exact: true }).setInputFiles({ name: 'demo.txt', mimeType: 'text/plain', buffer: Buffer.from('demo contents') });
  await other.getByRole('button', { name: 'Upload file', exact: true }).click();
  await other.waitForFunction(() => document.querySelector('#result').textContent.includes('demo.txt'));
  await other.getByRole('button', { name: 'List notes', exact: true }).click();
  await other.waitForFunction(() => document.querySelector('#result').textContent.includes('Hello from the browser demo'));
  await other.getByRole('button', { name: 'Sign out', exact: true }).click();
  await other.waitForFunction(() => document.querySelector('#result').textContent === 'You are signed out.');
  console.log('ok  runnable browser demo: signup, notes, upload and logout');
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
