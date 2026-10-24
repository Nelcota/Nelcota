// Real Next/browser transport smoke. The local API is a fixture, NOT RLS evidence.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from '../../typescript/node_modules/playwright-core/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('../examples/app-router/', import.meta.url));
const output = createWriteStream(process.env.NELCOTA_NEXT_LOG ?? '/tmp/nelcota-next-framework.log', { mode: 0o600 });
let child, browser;
const user = { id: 'next-fixture-user', email: 'next@example.test', email_confirmed_at: null, user_metadata: {}, created_at: '', last_sign_in_at: null };
const counts = { password: 0, user: 0, logout: 0 };
const api = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  const path = new URL(request.url, 'http://fixture').pathname;
  if (path === '/auth/v1/token') {
    counts.password++;
    response.end(JSON.stringify({ access_token: 'fixture-access-private', refresh_token: 'fixture-refresh-private', token_type: 'bearer', expires_in: 900, expires_at: Math.floor(Date.now() / 1000) + 900, user })); return;
  }
  if (path === '/auth/v1/user') {
    counts.user++;
    if (request.headers.authorization !== 'Bearer fixture-access-private') { response.statusCode = 401; response.end(JSON.stringify({ code: 'invalid_token', message: 'Not signed in' })); return; }
    response.end(JSON.stringify(user)); return;
  }
  if (path === '/auth/v1/logout') { counts.logout++; response.statusCode = 204; response.end(); return; }
  response.statusCode = 404; response.end(JSON.stringify({ code: 'not_found', message: 'Fixture route not found' }));
});
try {
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const origin = `http://localhost:${port}`;
  child = spawn(process.execPath, [root + 'node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: fixture, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NELCOTA_URL: `http://127.0.0.1:${api.address().port}`, APP_ORIGIN: origin, NELCOTA_SESSION_KEY: randomBytes(32).toString('base64url') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(output); child.stderr.pipe(output);
  for (let attempt = 0; ; attempt++) {
    try { const ready = await fetch(origin, { signal: AbortSignal.timeout(1000) }); if (ready.ok) break; } catch {}
    if (attempt >= 100 || child.exitCode !== null) throw new Error('Next fixture startup failed; see private log');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const denied = await fetch(origin + '/api/login', { method: 'POST', headers: { origin: 'https://foreign.test', 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password: 'fixture-password' }) });
  assert.equal(denied.status, 500); assert.equal(counts.password, 0);
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password: 'fixture-password' }) });
  assert.equal(login.status, 200);
  const payload = await login.text(); assert(!payload.includes('fixture-access-private')); assert(!payload.includes('fixture-refresh-private'));
  const cookie = login.headers.get('set-cookie'); assert(cookie); assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=lax/i);
  assert.match(login.headers.get('cache-control'), /private.*no-store/);
  const profile = await fetch(origin + '/profile', { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(profile.status, 200); assert((await profile.text()).includes(user.email));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext(); const page = await context.newPage();
  await page.goto(origin + '/login');
  await page.getByLabel('Email').fill(user.email); await page.getByLabel('Password').fill('fixture-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(origin + '/profile');
  assert.equal(await page.getByTestId('email').textContent(), user.email);
  const cookies = await context.cookies(); assert(cookies.some(row => row.httpOnly && row.value.length === 43));
  const source = await page.content(); assert(!source.includes('fixture-access-private')); assert(!source.includes('fixture-refresh-private'));
  const loggedOut = await page.evaluate(async () => (await fetch('/api/logout', { method: 'POST' })).status);
  assert.equal(loggedOut, 200); await page.reload(); await page.getByRole('heading', { name: 'Signed out' }).waitFor();
  await context.close();
  console.log(JSON.stringify({ framework: 'Next 16.4.3 production webpack / React 19.3.1', browser: 'Chromium', checks: ['cross-origin request refused before API', 'Route Handler HttpOnly cookie merged', 'private response cache', 'Server Component verified user', 'Server Action redirect retains cookie', 'HTML contains no session credentials', 'logout clears browser session'], counts, authorization: 'not tested: local transport fixture' }, null, 2));
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    const stopped = once(child, 'close'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await stopped; clearTimeout(timer);
  }
  await new Promise(resolve => api.close(resolve)); output.end();
}
