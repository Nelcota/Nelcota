// Real Next/browser transport smoke. The local API is a fixture, NOT RLS evidence.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from '../../typescript/node_modules/playwright-core/index.mjs';
import { Pool } from 'pg';
import { buildExample, example, linkPackage, nextBin } from './example.mjs';

const output = createWriteStream(process.env.NELCOTA_NEXT_LOG ?? '/tmp/nelcota-next-framework.log', { mode: 0o600 });
const children = [];
let browser, admin, databaseCreated = false;
const databaseName = `nelcota_next_test_${randomBytes(8).toString('hex')}`;
const profile = (id, email) => ({ id, email, email_confirmed_at: null, user_metadata: {}, created_at: '', last_sign_in_at: null });
const user = profile('next-fixture-user', 'next@example.test');
// Every fixture credential contains `-private`, so one substring check covers all of them.
const users = new Map([[user.email, { user, tag: 'next' }], ['alice@example.test', { user: profile('alice', 'alice@example.test'), tag: 'alice' }], ['bob@example.test', { user: profile('bob', 'bob@example.test'), tag: 'bob' }]]);
const tokens = new Map([...users.values()].map(row => [`Bearer fixture-access-private-${row.tag}`, row.user]));
const counts = { password: 0, user: 0, logout: 0, refresh: 0, signup: 0, verify: 0 };
const password = randomBytes(24).toString('base64url');
const emailLinks = new Map();
const oauthCodes = new Map();
let requireRefresh = false;
const session = row => ({ access_token: `fixture-access-private-${row.tag}`, refresh_token: `fixture-refresh-private-${row.tag}`, token_type: 'bearer', expires_in: 900, expires_at: Math.floor(Date.now() / 1000) + 900, user: row.user });
const tokenRow = request => users.get(tokens.get(request.headers.authorization ?? '')?.email);
/** Emails in the order the password grant reached the API (the lineage lock orders them). */
const grants = [];
const api = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  const path = new URL(request.url, 'http://fixture').pathname;
  const target = new URL(request.url, 'http://fixture');
  let body = ''; for await (const chunk of request) body += chunk;
  const input = JSON.parse(body || '{}');
  const reply = value => response.end(JSON.stringify(value));
  const invalid = () => { response.statusCode = 400; reply({ code: 'invalid_grant', message: 'Invalid fixture credential' }); };
  if (path === '/auth/v1/token') {
    if (target.searchParams.get('grant_type') === 'refresh_token') {
      counts.refresh++;
      const row = [...users.values()].find(row => session(row).refresh_token === input.refresh_token);
      if (!row) { invalid(); return; }
      reply(session(row)); return;
    }
    if (target.searchParams.get('grant_type') === 'pkce') {
      const challenge = oauthCodes.get(input.auth_code); oauthCodes.delete(input.auth_code);
      const { createHash } = await import('node:crypto');
      if (!challenge || createHash('sha256').update(input.code_verifier ?? '').digest('base64url') !== challenge) { invalid(); return; }
      reply(session(users.get(user.email))); return;
    }
    counts.password++;
    const row = users.get(input.email);
    if (!row) { response.statusCode = 400; response.end(JSON.stringify({ code: 'invalid_credentials', message: 'Invalid login' })); return; }
    grants.push(row.user.email);
    reply(session(row)); return;
  }
  if (path === '/auth/v1/signup') {
    counts.signup++;
    const row = { user: profile(`signup-${counts.signup}`, input.email), tag: `signup-${counts.signup}` };
    users.set(input.email, row); tokens.set(`Bearer ${session(row).access_token}`, row.user);
    const token = randomBytes(32).toString('base64url'); emailLinks.set(token, { row, type: 'signup' });
    reply({ user: row.user, session: null }); return;
  }
  if (['/auth/v1/recover', '/auth/v1/magiclink', '/auth/v1/resend'].includes(path)) {
    const row = users.get(input.email);
    if (row) emailLinks.set(randomBytes(32).toString('base64url'), { row, type: path.endsWith('recover') ? 'recovery' : path.endsWith('resend') ? 'signup' : 'magiclink' });
    reply(null); return;
  }
  if (path === '/auth/v1/verify') {
    const link = emailLinks.get(input.token);
    if (!link || link.type !== input.type) { invalid(); return; }
    emailLinks.delete(input.token); counts.verify++;
    reply(session(link.row)); return;
  }
  if (path === '/auth/v1/authorize') {
    const redirect = new URL(target.searchParams.get('redirect_to'));
    const code = randomBytes(24).toString('base64url');
    oauthCodes.set(code, target.searchParams.get('code_challenge'));
    redirect.searchParams.set('code', code);
    response.statusCode = 302; response.setHeader('location', redirect.href); response.end(); return;
  }
  if (path === '/auth/v1/user' && request.method === 'PUT') {
    const row = tokenRow(request);
    if (!row) { invalid(); return; }
    row.user.user_metadata = input.data; reply(row.user); return;
  }
  if (path === '/auth/v1/user') {
    counts.user++;
    if (requireRefresh) { requireRefresh = false; response.statusCode = 401; reply({ code: 'invalid_token', message: 'Expired fixture session' }); return; }
    const known = tokens.get(request.headers.authorization ?? '');
    if (!known) { response.statusCode = 401; response.end(JSON.stringify({ code: 'invalid_token', message: 'Not signed in' })); return; }
    response.end(JSON.stringify(known)); return;
  }
  if (path === '/auth/v1/logout') { counts.logout++; response.statusCode = 204; response.end(); return; }
  response.statusCode = 404; response.end(JSON.stringify({ code: 'not_found', message: 'Fixture route not found' }));
});
// Replayed outside the browser: drop transport headers and keep bodies uncompressed.
const hopByHop = new Set(['host', 'connection', 'content-length', 'keep-alive', 'transfer-encoding', 'upgrade', 'expect', 'accept-encoding', 'content-encoding']);
/**
 * Holds every `/api/login` request of a browser context until `expected` have
 * arrived, replays them to Next concurrently (as the browser sent them, cookie
 * included), then hands responses to the browser in an order chosen by `deliver`.
 * Chromium therefore processes the Set-Cookie headers in that order, as it would
 * after network reordering. `deliver` receives the responses in password-grant
 * order, i.e. the order in which the server accepted the identities.
 */
async function reorderLogins(context, expected, deliver, destinations = []) {
  const held = [];
  const originalCookies = await context.cookies();
  let release, finish; const ready = new Promise(resolve => { release = resolve; }), finished = new Promise(resolve => { finish = resolve; });
  await context.route('**/api/login', async route => {
    held.push(route); if (held.length === expected) release();
    await finished; // the route stays pending until it is fulfilled or aborted below
  });
  return async () => {
    let timer;
    try { await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Concurrent browser requests did not arrive')), 15000); })]); }
    finally { clearTimeout(timer); }
    const completions = [];
    await Promise.all(held.map(async (route, index) => {
      const request = route.request();
      const headers = Object.fromEntries(Object.entries(await request.allHeaders()).filter(([name]) => !hopByHop.has(name) && !name.startsWith(':')));
      // WebKit reports provisional intercepted headers before adding Cookie.
      // These same-origin fetches use credentials=same-origin. Replay the jar
      // for this exact URL; responses remain held, so neither login changed it.
      if (!headers.cookie && context.browser()?.browserType().name() === 'webkit') {
        headers.cookie = (await context.cookies(request.url())).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
      }
      for (const cookie of sessionCookie(originalCookies)) assert(headers.cookie?.includes(`${cookie.name}=${cookie.value}`), 'replayed login did not carry the browser bootstrap cookie');
      const url = destinations[index] ? new URL(new URL(request.url()).pathname, destinations[index]) : request.url();
      const response = await fetch(url, { method: request.method(), headers, body: request.postDataBuffer(), redirect: 'manual', signal: AbortSignal.timeout(10000) });
      const body = Buffer.from(await response.arrayBuffer());
      completions.push({ route, status: response.status, body, cookies: response.headers.getSetCookie(), headers: Object.fromEntries([...response.headers].filter(([name]) => name !== 'set-cookie' && !hopByHop.has(name))) });
    }));
    const rank = entry => grants.findLastIndex(email => entry.body.toString().includes(email));
    completions.sort((a, b) => rank(a) - rank(b));
    const plan = deliver(completions);
    for (const entry of plan.lost ?? []) await entry.route.abort('connectionreset');
    for (const entry of plan.order) await entry.route.fulfill({ status: entry.status, body: entry.body, headers: { ...entry.headers, ...(entry.cookies.length ? { 'set-cookie': entry.cookies.join('\n') } : {}) } });
    finish(); await context.unroute('**/api/login');
    return completions;
  };
}
const sessionCookie = cookies => cookies.filter(row => row.httpOnly && row.name.startsWith('nelcota-dev-'));
const signIn = (page, email) => page.evaluate(async email => (await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'fixture-password' }) })).status, email).catch(() => 'lost');
/** Signed-in email shown by the verified Server Component, or null when signed out. */
async function shown(page, origin) {
  await page.goto(origin + '/profile');
  if (await page.getByRole('heading', { name: 'Signed out' }).count()) return null;
  return page.getByTestId('email').textContent();
}
try {
  const connectionString = process.env.NELCOTA_NEXT_TEST_DATABASE_URL;
  if (!connectionString) throw new Error('Set NELCOTA_NEXT_TEST_DATABASE_URL to the disposable shared PostgreSQL fixture');
  const database = new URL(connectionString);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)) throw new Error('Only a loopback disposable database is allowed');
  admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2000 });
  admin.on('error', () => { process.exitCode = 1; });
  await admin.query(`CREATE DATABASE "${databaseName}"`); databaseCreated = true;
  database.pathname = `/${databaseName}`;
  const installer = new Pool({ connectionString: database.href, max: 1, connectionTimeoutMillis: 2000 });
  try { await installer.query(await readFile(new URL('../sql/session-store.sql', import.meta.url), 'utf8')); }
  finally { await installer.end(); }
  await linkPackage();
  const build = buildExample();
  output.write(build.stdout + build.stderr);
  assert.equal(build.status, 0, 'example production build failed; see private log');
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const origin = `http://localhost:${port}`;
  const key = randomBytes(32).toString('base64url'), destinations = [];
  for (let instance = 0; instance < 2; instance++) {
    const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const nextPort = instance === 0 ? port : probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const destination = `http://localhost:${nextPort}`; destinations.push(destination);
    const child = spawn(process.execPath, [nextBin, 'start', '-p', String(nextPort), '-H', '127.0.0.1'], {
      cwd: example, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NELCOTA_URL: `http://127.0.0.1:${api.address().port}`, APP_ORIGIN: origin, NELCOTA_SESSION_KEY: key, NELCOTA_NEXT_SESSION_DATABASE_URL: database.href }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child); child.stdout.pipe(output); child.stderr.pipe(output);
    for (let attempt = 0; ; attempt++) {
      try { const ready = await fetch(destination, { signal: AbortSignal.timeout(1000) }); if (ready.ok) break; } catch {}
      if (attempt >= 100 || child.exitCode !== null) throw new Error('Next fixture startup failed; see private log');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const denied = await fetch(origin + '/api/login', { method: 'POST', headers: { origin: 'https://foreign.test', 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password: 'fixture-password' }) });
  assert.equal(denied.status, 500); assert.equal(counts.password, 0);
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password: 'fixture-password' }) });
  assert.equal(login.status, 200);
  const payload = await login.text(); assert(!payload.includes('-private'));
  const cookie = login.headers.get('set-cookie'); assert(cookie); assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=lax/i);
  assert.match(login.headers.get('cache-control'), /private.*no-store/);
  const profilePage = await fetch(origin + '/profile', { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(profilePage.status, 200); assert((await profilePage.text()).includes(user.email));
  // Proxy: signed-out visitors are routed to login; a signed-in one reaches the page.
  const guarded = await fetch(origin + '/account', { redirect: 'manual' });
  assert.equal(guarded.status, 303); assert.equal(new URL(guarded.headers.get('location'), origin).pathname, '/login');
  assert.match(guarded.headers.get('cache-control'), /private.*no-store/);
  const account = await fetch(origin + '/account', { headers: { cookie: cookie.split(';')[0] }, redirect: 'manual' });
  assert.equal(account.status, 200); assert((await account.text()).includes(user.email));

  const engine = process.env.NELCOTA_NEXT_BROWSER ?? 'chromium';
  const launcher = { chromium, firefox, webkit }[engine];
  if (!launcher) throw new Error('Unknown NELCOTA_NEXT_BROWSER');
  browser = await launcher.launch({ headless: true, ...(engine === 'chromium' ? { args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) } : {}) });
  const context = await browser.newContext(); const page = await context.newPage();
  await page.goto(origin + '/login');
  const bootstrap = sessionCookie(await context.cookies());
  assert.equal(bootstrap.length, 1, 'login page issued a bootstrap ID'); assert.equal(bootstrap[0].value.length, 43);
  await page.getByLabel('Email').fill(user.email); await page.getByLabel('Password').fill('fixture-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(origin + '/profile');
  assert.equal(await page.getByTestId('email').textContent(), user.email);
  const cookies = sessionCookie(await context.cookies()); assert.equal(cookies.length, 1); assert.equal(cookies[0].value.length, 43);
  assert.notEqual(cookies[0].value, bootstrap[0].value, 'sign-in moved to a fresh ID');
  const source = await page.content(); assert(!source.includes('-private'));
  const loggedOut = await page.evaluate(async () => (await fetch('/api/logout', { method: 'POST' })).status);
  assert.equal(loggedOut, 200); await page.reload(); await page.getByRole('heading', { name: 'Signed out' }).waitFor();
  await context.close();

  // The actual Route Handler and callback run against a local auth transport
  // fixture. Backend email delivery/token semantics have a separate contract.
  const flows = await browser.newContext(), flowPage = await flows.newPage();
  await flowPage.goto(origin + '/login');
  const invoke = async (operation, input = {}) => {
    const result = await flowPage.evaluate(async ({ operation, input }) => {
      const response = await fetch('/api/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, ...input }) });
      return { status: response.status, cache: response.headers.get('cache-control'), body: await response.text() };
    }, { operation, input });
    assert.match(result.cache, /private.*no-store/);
    assert(!result.body.includes('-private'), 'auth response exposed credentials');
    return { status: result.status, ...JSON.parse(result.body) };
  };
  const flowEmail = 'flow@example.test';
  const registered = await invoke('signup', { email: flowEmail, password });
  assert.equal(registered.status, 200); assert.equal(registered.data.confirmationRequired, true);
  assert.equal(await shown(flowPage, origin), null, 'unconfirmed signup is signed out');
  assert.equal((await invoke('resend', { email: flowEmail })).status, 200);
  const linkFor = type => [...emailLinks].findLast(([, link]) => link.row.user.email === flowEmail && link.type === type)[0];
  const confirmation = linkFor('signup');
  assert.equal((await invoke('verify', { type: 'magiclink', token: confirmation })).status, 400);
  assert.equal((await invoke('verify', { type: 'signup', token: confirmation })).data.email, flowEmail);
  assert.equal((await invoke('verify', { type: 'signup', token: confirmation })).status, 400, 'confirmation cannot replay');
  assert.equal(await shown(flowPage, origin), flowEmail);
  const updated = await invoke('update', { displayName: 'SDK example' });
  assert.equal(updated.data.user_metadata.display_name, 'SDK example');
  requireRefresh = true;
  assert.equal((await invoke('refresh')).data.user.email, flowEmail); assert.equal(counts.refresh, 1);
  assert.equal((await invoke('recover', { email: flowEmail })).status, 200);
  const recovery = linkFor('recovery');
  assert.equal((await invoke('reset', { token: recovery, password })).data.email, flowEmail);
  assert.equal((await invoke('reset', { token: recovery, password })).status, 400, 'recovery cannot replay');
  await flowPage.evaluate(() => fetch('/api/logout', { method: 'POST' }));
  assert.equal((await invoke('magiclink', { email: flowEmail })).status, 200);
  const magic = linkFor('magiclink');
  assert.equal((await invoke('verify', { type: 'magiclink', token: magic })).data.email, flowEmail);
  assert.equal((await invoke('verify', { type: 'magiclink', token: magic })).status, 400, 'magic link cannot replay');
  const oauth = await invoke('oauth', { returnTo: '/profile' });
  assert.equal(oauth.status, 200);
  const provider = new URL(oauth.data.url);
  assert.equal(provider.searchParams.get('code_challenge_method'), 'S256');
  const authorized = await fetch(provider, { redirect: 'manual' });
  assert.equal(authorized.status, 302);
  const callbackUrl = authorized.headers.get('location');
  const stolen = await fetch(callbackUrl, { redirect: 'manual' });
  assert.equal(stolen.status, 500, 'callback without its browser cookie is refused');
  await flowPage.goto(callbackUrl); await flowPage.waitForURL(origin + '/profile');
  assert.equal(await flowPage.getByTestId('email').textContent(), user.email);
  const replay = await flows.request.get(callbackUrl, { maxRedirects: 0 });
  assert.equal(replay.status(), 500, 'OAuth callback cannot replay');
  assert(!(await flowPage.content()).includes('-private'));
  const cookieBytes = sessionCookie(await flows.cookies()).reduce((size, cookie) => size + Buffer.byteLength(`${cookie.name}=${cookie.value}`), 0);
  assert(cookieBytes < 256, 'opaque session cookie remains bounded');
  const started = performance.now();
  for (let index = 0; index < 100; index++) {
    const response = await flows.request.get(origin + '/profile');
    assert.equal(response.status(), 200); assert(!(await response.text()).includes('-private')); await response.dispose();
  }
  const repeatedReadMs = performance.now() - started;
  assert(repeatedReadMs < 30000, '100 session reads exceeded the bounded fixture deadline');
  const locks = await admin.query("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=$1)", [databaseName]);
  assert.equal(locks.rows[0].count, '0', 'completed requests released every session advisory lock');
  await flows.close();

  // N01 in a real browser: two tabs (one cookie jar) that loaded /login sign in concurrently.
  const tabs = async () => {
    const shared = await browser.newContext(); const one = await shared.newPage(), two = await shared.newPage();
    await one.goto(origin + '/login'); await two.goto(origin + '/login');
    const ids = sessionCookie(await shared.cookies()); assert.equal(ids.length, 1, 'tabs share one bootstrap ID');
    return { shared, one, two };
  };
  const race = async ({ shared, one, two }, deliver) => {
    const start = grants.length;
    const replay = await reorderLogins(shared, 2, deliver, destinations);
    const statuses = Promise.all([signIn(one, 'alice@example.test'), signIn(two, 'bob@example.test')]);
    const completions = await replay();
    const received = await statuses;
    assert(received.every(status => status === 200 || status === 'lost'), `concurrent login failed: ${received.join(', ')}`);
    const [older, newer] = grants.slice(start); assert(older && newer && older !== newer);
    return { older, newer, completions };
  };
  const byEmail = (completions, email) => completions.find(entry => entry.body.toString().includes(email));
  const multiTab = {};
  {
    // Responses reach the browser in reverse order: the older sign-in's cookie lands last.
    const tab = await tabs();
    const { older, newer } = await race(tab, completions => ({ order: [...completions].reverse() }));
    const seen = await shown(tab.one, origin);
    assert.notEqual(seen, older, 'stale identity won silently'); assert.equal(seen, null);
    assert.equal(await shown(tab.two, origin), null);
    await tab.one.goto(origin + '/account'); assert.equal(new URL(tab.one.url()).pathname, '/login');
    multiTab.reversed = { older, newer, browserShows: 'signed out (superseded)' };
    await tab.shared.close();
  }
  {
    // Natural order: the newer sign-in's cookie lands last and is the live identity.
    const tab = await tabs();
    const { older, newer } = await race(tab, completions => ({ order: completions }));
    assert.equal(await shown(tab.one, origin), newer); assert.equal(await shown(tab.two, origin), newer);
    multiTab.natural = { older, newer, browserShows: newer };
    await tab.shared.close();
  }
  {
    // Lost winning response: the newer response never reaches the browser.
    const tab = await tabs();
    const { older, newer, completions } = await race(tab, completions => ({ order: completions.slice(0, 1), lost: completions.slice(1) }));
    assert.equal(await shown(tab.one, origin), null, 'stale identity won after a lost response');
    // Documented residual: the lost winner's row stays live until a later sign-in/out of the lineage.
    const lostCookie = byEmail(completions, newer).cookies[0].split(';')[0];
    const lostView = async () => (await (await fetch(origin + '/profile', { headers: { cookie: lostCookie } })).text()).includes(newer);
    assert.equal(await lostView(), true);
    assert.equal(await signIn(tab.one, older), 200);
    assert.equal(await shown(tab.one, origin), older);
    assert.equal(await lostView(), false, 'a later lineage sign-in retires the lost winner');
    multiTab.lostResponse = { older, newer, browserShows: 'signed out (superseded)', lostRowLiveUntilNextLineageSignIn: true };
    await tab.shared.close();
  }
  {
    // Documented residual, pinned: without a bootstrap ID (cookie-less tabs that skipped
    // /login) the two sign-ins are unrelated sessions and the last delivered one stays.
    const shared = await browser.newContext(); const one = await shared.newPage(), two = await shared.newPage();
    await one.goto(origin + '/'); await two.goto(origin + '/');
    assert.equal(sessionCookie(await shared.cookies()).length, 0);
    const { older } = await race({ shared, one, two }, completions => ({ order: [...completions].reverse() }));
    multiTab.cookielessResidual = { browserShows: await shown(one, origin), olderIdentity: older, note: 'documented residual: no lineage without a cookie' };
    await shared.close();
  }
  console.log(JSON.stringify({ framework: 'Next 16.4.3 production webpack / React 19.3.1', node: process.version, browser: `${engine} ${browser.version()}`, processes: children.length, sessionStore: 'shared disposable PostgreSQL', authFlows: ['password Server Action', 'signup awaiting confirmation', 'resend', 'confirmation and replay', 'update user', 'refresh after 401', 'recovery and replay', 'magic link and replay', 'OAuth S256 PKCE callback, browser binding and replay', 'logout'], resources: { cookieBytes, repeatedReads: 100, repeatedReadMs: Math.round(repeatedReadMs), retainedAdvisoryLocks: 0 }, checks: ['cross-origin request refused before API', 'Route Handler HttpOnly cookie merged', 'private response cache', 'Server Component verified user', 'proxy routes signed-out visitor to login', 'proxy bootstrap ID on login page', 'Server Action redirect retains cookie', 'HTML contains no session credentials', 'logout clears browser session', 'N01 two tabs/processes, reversed delivery: signed out, never the older identity', 'N01 two tabs/processes, natural delivery: newer identity', 'N01 lost winning response: signed out; lost row retired by next lineage sign-in'], multiTab, counts, authorization: 'not tested: local transport fixture' }, null, 2));
} finally {
  await browser?.close();
  for (const child of children.filter(child => child.exitCode === null)) {
    const stopped = once(child, 'close'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await stopped; clearTimeout(timer);
  }
  if (databaseCreated) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin?.end();
  await new Promise(resolve => api.close(resolve)); output.end();
}
