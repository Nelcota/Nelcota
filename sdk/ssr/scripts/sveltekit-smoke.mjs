// Real SvelteKit/browser smoke: production adapter-node build of examples/sveltekit,
// a browser, and a local auth fixture. The fixture is NOT RLS evidence.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from '../../typescript/node_modules/playwright-core/index.mjs';

const example = fileURLToPath(new URL('../examples/sveltekit/', import.meta.url));
const engine = process.env.NELCOTA_SSR_BROWSER ?? 'chromium';
const user = { id: 'kit-fixture-user', email: 'kit@example.test', email_confirmed_at: null, user_metadata: {}, created_at: '', last_sign_in_at: null };
const password = randomBytes(24).toString('base64url');
const access = `fixture-access-private-${randomBytes(8).toString('hex')}`;
const counts = { password: 0, user: 0, logout: 0 };
let signedOut = false;

const api = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  const target = new URL(request.url, 'http://fixture');
  let body = ''; for await (const chunk of request) body += chunk;
  const input = JSON.parse(body || '{}');
  const fail = (status, code) => { response.statusCode = status; response.end(JSON.stringify({ code, message: 'Fixture refusal' })); };
  if (target.pathname === '/auth/v1/token' && target.searchParams.get('grant_type') === 'password') {
    counts.password++;
    if (input.email !== user.email || input.password !== password) return fail(400, 'invalid_credentials');
    signedOut = false;
    response.end(JSON.stringify({ access_token: access, refresh_token: 'fixture-refresh-private', token_type: 'bearer', expires_in: 900, expires_at: Math.floor(Date.now() / 1000) + 900, user }));
    return;
  }
  if (target.pathname === '/auth/v1/user') {
    counts.user++;
    if (signedOut || request.headers.authorization !== `Bearer ${access}`) return fail(401, 'invalid_token');
    response.end(JSON.stringify(user)); return;
  }
  if (target.pathname === '/auth/v1/logout') { counts.logout++; signedOut = true; response.statusCode = 204; response.end(); return; }
  fail(404, 'not_found');
});

let app, browser, page, log = '';
try {
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  // SvelteKit 3 fixes the trusted origin (CSRF checks, url.origin) at build time.
  const port = 20000 + Math.floor(Math.random() * 20000), origin = `http://127.0.0.1:${port}`;
  const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { cwd: example, env: { ...process.env, ORIGIN: origin }, encoding: 'utf8', timeout: 180000 });
  assert.equal(build.status, 0, `SvelteKit build failed:\n${build.stdout}\n${build.stderr}`);

  app = spawn(process.execPath, ['build'], {
    cwd: example,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, NELCOTA_URL: `http://127.0.0.1:${api.address().port}`, NELCOTA_SESSION_KEY: randomBytes(32).toString('base64url') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', chunk => { log += chunk; }); app.stderr.on('data', chunk => { log += chunk; });
  for (let attempt = 0; ; attempt++) {
    try { await fetch(origin); break; } catch { if (attempt > 100) throw new Error(`SvelteKit server did not start:\n${log}`); await new Promise(resolve => setTimeout(resolve, 100)); }
  }

  browser = await { chromium, firefox, webkit }[engine].launch();
  page = await browser.newPage();
  // A protected page without a session goes to the login page, keeping its target.
  await page.goto(`${origin}/dashboard`);
  assert.equal(new URL(page.url()).pathname, '/login');
  assert.equal(new URL(page.url()).searchParams.get('next'), '/dashboard');
  const bootstrap = (await page.context().cookies()).find(cookie => cookie.name.includes('nelcota'));
  assert(bootstrap?.httpOnly, 'the login page issues an HttpOnly bootstrap cookie');

  // Wrong password: the form action reports it, no session is published.
  await page.fill('input[name=email]', user.email);
  await page.fill('input[name=password]', 'wrong-password');
  await page.click('button[type=submit]');
  await page.waitForSelector('[role=alert]');
  assert.equal(new URL(page.url()).pathname, '/login');

  // The failed POST rendered a fresh form; its required email is empty again.
  await page.fill('input[name=email]', user.email);
  await page.fill('input[name=password]', password);
  await page.click('button[type=submit]');
  await page.waitForURL(`${origin}/dashboard`);
  assert.equal(await page.textContent('[data-testid=email]'), user.email);
  const cookies = await page.context().cookies();
  const session = cookies.find(cookie => cookie.name === bootstrap.name);
  assert(session && session.httpOnly && session.sameSite === 'Lax', 'the session cookie is HttpOnly and SameSite=Lax');
  assert.notEqual(session.value, bootstrap.value, 'sign-in rotates the bootstrap ID');
  assert(!cookies.some(cookie => cookie.value.includes('private')), 'no token reaches a browser cookie');
  assert(!(await page.content()).includes('private'), 'no token reaches the rendered page');
  const response = await page.request.get(`${origin}/dashboard`);
  assert.match(response.headers()['cache-control'] ?? '', /private, no-store/);

  // A cross-site form post is refused by the session core (and SvelteKit's own check).
  const forged = await fetch(`${origin}/logout`, { method: 'POST', headers: { origin: 'https://evil.example', cookie: `${session.name}=${session.value}`, 'content-type': 'application/x-www-form-urlencoded' }, body: '', redirect: 'manual' });
  assert(forged.status >= 400, `cross-site logout must fail, got ${forged.status}`);
  assert.equal(counts.logout, 0);

  await page.click('text=Sign out');
  await page.waitForURL(url => new URL(url).pathname === '/login');
  assert.equal(counts.logout, 1);
  await page.goto(`${origin}/dashboard`);
  assert.equal(new URL(page.url()).pathname, '/login', 'signed out: the dashboard is protected again');

  console.log(JSON.stringify({ framework: 'SvelteKit 3 production adapter-node build', node: process.version, browser: `${engine} ${browser.version()}`, counts, authorization: 'not tested: local auth fixture' }, null, 2));
} catch (error) {
  console.error(`server log:\n${log}\npage ${page?.url()}:\n${await page?.content().catch(() => '')}`);
  throw error;
} finally {
  await browser?.close();
  app?.kill();
  api.close();
}
