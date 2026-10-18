# @nelcota/client

JavaScript and TypeScript client for [Nelcota](https://github.com/Nelcota/Nelcota/): the
REST API under RLS, auth and storage.

Start with the [quickstart](https://github.com/Nelcota/Nelcota/blob/main/docs/quickstart.md)
(also in [Portuguese](docs/quickstart.pt-BR.md)), the
[runnable examples](examples/) (their schema is
[examples/notes.sql](https://github.com/Nelcota/Nelcota/blob/main/examples/notes.sql))
or the [client contract](docs/contract.md). Empty results, 401/403 or a
1000-row cap? See [troubleshooting](https://github.com/Nelcota/Nelcota/blob/main/docs/troubleshooting.md).

- **Thin.** Operations map directly to HTTP; session refresh and read retries
  may add requests. There is no hidden data cache, and
  Postgres (GRANTs and RLS) decides what a call may do.
- **No runtime dependencies.** It uses `fetch`, Web Crypto, `AbortSignal`,
  Web Locks and `BroadcastChannel`, and runs in browsers, Node 22+, Deno,
  Bun. Edge hosts need the same Web APIs and host-specific validation.
  ESM only, side-effect free, with subpath exports
  (`/rest`, `/auth`, `/storage`).
- **Typed from your schema** by `nelcota types`, down to the embeds in a
  `select` string.
- **Safe by construction.** Input never becomes query syntax, storage paths
  cannot climb out of their bucket, and a `service_role` token is refused in
  a browser.

```sh
npm install @nelcota/client@0.2.0
nelcota types -o src/database.ts
```

```ts
import { createClient } from '@nelcota/client';
import type { Database } from './database';

export const nelcota = createClient<Database>('https://api.example.com');
```

In plain JavaScript, omit the generated type and generic parameter:

```js
import { createClient } from '@nelcota/client';
const nelcota = createClient('https://api.example.com');
```

## Version scope

This checkout prepares 0.2.0; the registry command above requires its successful
publication. Until then, install a locally packed archive. Published 0.1.2 lacks
native IndexedDB session/PKCE journaling, exact numeric preservation and the
latest cancellation/sign-out cleanup fixes. Read each package's bundled README
for its contract. Updating the server does not update installed clients.
Node is SDK tooling/runtime, not a backend requirement.

## Independent modules

```js
import { createAuthClient } from '@nelcota/client/auth';
import { createRestClient } from '@nelcota/client/rest';
import { createStorageClient } from '@nelcota/client/storage';

const auth = createAuthClient('https://api.example.com');
const options = { accessToken: () => auth.accessToken() };
const rest = createRestClient('https://api.example.com', options);
const storage = createStorageClient('https://api.example.com', options);
```

Each entry includes its transport without importing the other feature modules.
`createRestClient<Database>(url)` also accepts generated schema types.

## Results and errors

Every call resolves to `{ data, error }` and never throws for HTTP or
network failures. `error` is a `NelcotaError`:

- `status`: the HTTP status, or `0` when no response arrived.
- `code`: the server's code untouched (`user_already_exists`,
  `invalid_grant`, `db_error`, `rate_limited`...), or a client code:
  `network_error`, `timeout`, `aborted`, `invalid_response`, `not_single`,
  `session_missing`, `pkce_missing`. A response without a JSON body (a HEAD
  count, a proxy page) gets `unauthorized`, `forbidden`, `not_found`,
  `rate_limited`, `unavailable` or `http_<status>`. The `NelcotaErrorCode`
  type lists the known codes and still accepts any string.
- `retryAfter`: seconds to wait, after a 429 or 503.
- `sqlstate`, `details`, `hint`, `constraint`: what Postgres reported for a
  `db_error` (`23505`, `Key (slug)=(a) already exists.`, `notes_slug_key`),
  when the server sends them; `undefined` otherwise.

A programming mistake (an invalid column name, a `..` in a file path, a
`service_role` token in a browser) throws a `NelcotaUsageError` before
anything is sent.

Custom token/storage adapters may throw their own errors. A response returned
by `storage.open()` is caller-owned: handle errors while reading its stream.

```ts
const { data, error } = await nelcota.from('notes').select('id,body');
if (error) console.error(error.code, error.message);
```

To use exceptions instead, call `.throwOnError()` on a query (its result
type then has no error branch) or pass any result to `unwrap`, which
returns `data` or throws the `NelcotaError`:

```ts
import { unwrap } from '@nelcota/client';

const { data: notes } = await nelcota.from('notes').select('id,body').throwOnError();
const user = unwrap(await nelcota.auth.getUser());
const blob = unwrap(await nelcota.storage.from('files').download('a.txt'));
```

## Tables, views and functions

```ts
// Read: columns, *, embeds in either direction, filters, order, paging.
const { data, count } = await nelcota
  .from('orders')
  .select('id,total,customer:customers(name),items(product,qty)', { count: 'exact' })
  .eq('status', 'paid')
  .gte('items.qty', 2)                                  // filters the embedded rows
  .order('created_at', { ascending: false })
  .order('qty', { referencedTable: 'items' })
  .range(0, 19);
// data: { id: number | string; total: number | string; customer: { name: string } | null;
//         items: { product: string; qty: number }[] }[]

// One row: an error (not_single) unless exactly one matches.
const { data: order } = await nelcota.from('orders').select().eq('id', 10).single();

// Only the count (a HEAD request, no rows).
const { count: open } = await nelcota.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'open');

// Groups: conditions are built with typed calls, never strings.
await nelcota.from('products').select().or((c) => [
  c.eq('status', 'featured'),
  c.and([c.gt('price', 100), c.not(c.is('archived', true))]),
]);

// Writes return nothing unless you ask for the rows with select().
await nelcota.from('notes').insert({ body: 'hi' });
const { data: created } = await nelcota.from('notes').insert({ body: 'hi' }).select('id').single();
await nelcota.from('notes').update({ body: 'edited' }).eq('id', 1);
await nelcota.from('notes').delete().in('id', [1, 2, 3]);
await nelcota.from('products').upsert(rows, { onConflict: 'slug' });      // or ignoreDuplicates: true

// Functions run with the caller's role.
const { data: total } = await nelcota.rpc('cart_total', { cart_id: 7 });
```

Filters: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`,
`is` (`null`, `true`, `false`, `'unknown'`), `not(column, op, value)`,
`match({...})`, `or(...)` and `and(...)`. A column path such as
`orders.total` filters an embed. Builders are immutable, so a base query can
be reused.

`like`/`ilike` read `*` (or `%`) as "any text". Wrap text a person typed in
`escapeLike` so `%` and `_` match literally:

```ts
import { escapeLike } from '@nelcota/client';
nelcota.from('products').select().ilike('name', `*${escapeLike(search)}*`);
```

`update` and `delete` need at least one filter; the server refuses them
otherwise. `count: 'exact'` scans every matching row, so ask for it only
when you show it.

HEAD queries return `data: null`. `single()` and `maybeSingle()` require
rows: use `.select()` on writes first, and omit `head: true`.

### Paging

The server returns at most `NELCOTA_MAX_ROWS` rows per request (1000 by
default), even without a `limit`. Page with `range(from, to)` or
`limit(n)` + `offset(n)`, and read `range` (the rows returned, from
`Content-Range`) and `count` (with `count: 'exact'`) to know whether more
rows exist:

```ts
const { data, range, count } = await nelcota
  .from('notes').select('id,body', { count: 'exact' }).order('id').range(0, 49);
const more = range !== null && count !== null && range.to + 1 < count;
```

To walk every row, `pages(size)` requests one page after another until an
empty one, so a server cap below `size` cannot cut it short. Order by a
unique column so pages neither overlap nor skip rows; a failed page throws
its `NelcotaError`:

```ts
for await (const page of nelcota.from('notes').select('id,body').order('id').pages(500)) {
  for (const note of page) console.log(note.id);
}
```

## Auth

```ts
await nelcota.auth.signUp({ email, password, data: { name: 'Ana' } });  // session is null while the email awaits confirmation
await nelcota.auth.signInWithPassword({ email, password });
await nelcota.auth.signOut();

const { data: session } = await nelcota.auth.getSession();   // refreshed first when about to expire
const { data: user } = await nelcota.auth.getUser();         // the server's view, now
await nelcota.auth.updateUser({ data: { plan: 'pro' } });     // merged into user_metadata; null removes a key
await nelcota.auth.updateUser({ password: next, currentPassword: password }); // ends the other sessions

const stop = nelcota.auth.onChange((event, session) => {
  // 'signed_in' | 'signed_out' | 'refreshed' | 'user_updated', also from other tabs
});
```

**Sessions.** In browsers, native `localStorage` uses an IndexedDB journal
as the authoritative session state and mirrors committed sessions to
`localStorage`. Elsewhere sessions stay in memory. Pass `auth: { storage }`
to use a custom adapter, for example a cookie adapter for server-side
rendering. Anything with `getItem`/`setItem`/`removeItem` works, sync or async.

Browser storage can be read by any script on the page, so the usual XSS
hygiene applies (a Content Security Policy, no untrusted HTML). The session
holds a short-lived access token (15 minutes by default) and a refresh
token that rotates on every use.

**Refresh.** The access token is refreshed in the background before it
expires, and again right before a request when needed.

The server ends a session whose refresh token is used twice, so refreshes
are coordinated:

- One refresh at a time in a process, however many requests are waiting.
- Across tabs, a Web Lock serializes refreshes. A committed IndexedDB
  receipt hands the replacement to the next owner even when its
  `localStorage` view is stale. A reservation is committed before HTTP.

Native browser persistence requires IndexedDB. Storage failures reject
explicit auth calls; observe automatic refresh failures with
`auth.onBackgroundError`. If an owner disappears during rotation or cannot
save its replacement, another client refuses to reuse the reserved token.
Retry from the owning client, sign in again, or call `signOut()` to clear it.

Without Web Locks, a local queue coordinates clients in the same module
instance. The native journal prevents competing owners from spending a
reserved token, but cannot make them wait for the replacement. Custom shared
adapters need Web Locks or external coordination; use
`auth: { storage: sessionStorage }` for separate per-tab sessions.
Keep the same storage key when sharing a session adapter.

On upgrade, the journal imports the existing `localStorage` session once.
Reload all open tabs to avoid mixing old and new coordination protocols.
Use `signOut()` or clear all site data to remove native sessions; editing
only `localStorage` no longer changes authoritative session state.
Signing out also clears the pending OAuth verifier from the journal and
its storage mirror, including when no session exists or server logout fails.

Failed sign-in/logout publication keeps the newer local state while the exact
prior journal revision remains current, even if another client wrote that
prior revision. A new committed revision supersedes it, including an explicit
publication of the same value.

If a refresh fails for a transient reason, the old token is still sent. The
request then fails with 401 instead of silently running as a visitor.

**OAuth (Google, GitHub)** uses PKCE, with the verifier kept in this
browser:

```ts
// Login page: navigates to the provider.
await nelcota.auth.signInWithOAuth({ provider: 'github', redirectTo: 'https://app.example.com/auth/callback' });

// On the callback page: reads ?code= (or ?error=), cleans the address bar, signs in.
const { data, error } = await nelcota.auth.handleRedirect();
```

`redirectTo` must be listed in the server's `NELCOTA_OAUTH_REDIRECT_URLS`.
Each storage key holds one pending OAuth verifier: starting another sign-in
replaces the previous attempt. Verifier publication, navigation and callback
consumption use the same lock so asynchronous work cannot reorder them. Use
separate storage keys for independent login flows.

Native PKCE publication and consumption also use the IndexedDB journal, so
stale localStorage cannot supply an older verifier or reuse a consumed one.
An already cancelled exchange keeps its verifier. Once consumption begins,
the bounded exchange persists an accepted session even if its caller cancels
the wait; the first exchange's timeout still applies.

**Email links** arrive as `https://your.app/page#type=...&token=...`.
`readEmailLink()` takes the token and removes it from the address bar and
history:

```ts
const link = nelcota.auth.readEmailLink();
if (link?.type === 'magiclink' || link?.type === 'signup') await nelcota.auth.verifyEmailLink(link);
if (link?.type === 'recovery') await nelcota.auth.resetPassword({ token: link.token, password: newPassword });

await nelcota.auth.sendMagicLink(email);
await nelcota.auth.requestPasswordReset(email);   // same answer whether or not the account exists
await nelcota.auth.resendConfirmation(email);
```

**On a server**, forward the caller's token instead of keeping a session:

```ts
// Validate the header in middleware before constructing the client.
const nelcota = createClient<Database>(url, { accessToken: () => validatedCallerToken });
```

Create this client per request. `validatedCallerToken` is a token or null from
middleware that validates Bearer syntax and returns 401 for malformed headers.
Only an absent header means anonymous; do not turn malformed auth into a visitor.
The runnable [server example](examples/server.mjs) demonstrates validation and
forwarding to RLS. `accessToken` disables automatic session refresh; explicitly
called auth methods still store sessions.

Auth HTTP methods take `{ signal, timeout }` as their last argument. Concurrent
refresh calls share the first caller's timeout; each caller can cancel its own
wait independently. Once rotation starts, it finishes and saves the new token
even if a waiter cancels. REST/storage cancellation also covers waiting for a
token or session refresh. `signOut()` waits for a
pending refresh. Call `nelcota.dispose()` (or `auth.dispose()` for the standalone
client) to stop timers and close channels when the client is no longer used.

A `service_role` token bypasses RLS. Use it only on a trusted server; in a
browser the client refuses it.

## Storage

```ts
const files = nelcota.storage.from('avatars');

await files.upload(`${user.id}/me.png`, file);                       // 409 object_exists if taken
await files.upload(`${user.id}/me.png`, file, { upsert: true });     // replace
const { data: blob } = await files.download(`${user.id}/me.png`);
const { data: listing } = await files.list({ prefix: `${user.id}/` });
await files.remove(`${user.id}/me.png`);

const { data: url } = await files.createSignedUrl('reports/q1.pdf', 3600);  // anyone with the URL, for an hour
files.publicUrl('logo.png');                                                 // public buckets, no request
```

- **Uploads** send the bytes as they are (no multipart). A `ReadableStream`
  is streamed without buffering where the runtime supports it (Node, Deno,
  Bun; browsers over HTTP/2).
- **`open(name, { range, ifNoneMatch, download })`** returns the raw
  `Response`, for streaming `response.body`, resuming with ranges (206) or
  revalidating with ETags (304).
- **Names** are normalized to NFC and encoded segment by segment. Empty,
  `.` and `..` segments, control characters and backslashes are refused.
- **Buckets** are managed with `createBucket`, `updateBucket`,
  `deleteBucket`, `getBucket` and `listBuckets`, usually as `service_role`.
  `updateBucket` replaces every setting and requires all three fields:

```ts
await nelcota.storage.updateBucket('avatars', {
  public: true,
  file_size_limit: 5_000_000,
  allowed_mime_types: ['image/png', 'image/jpeg'],
});
```

Use explicit `null` to clear a size or MIME limit. Partial updates are refused
before HTTP, so an omitted field cannot silently clear an existing restriction.

Who may read or write which file is up to the policies on
`storage.objects`; see the server's
[storage docs](https://github.com/Nelcota/Nelcota/blob/main/docs/storage.md).

## Recipes

### Polling for changes

There is no realtime channel. For a UI showing the latest 100 notes, refresh a
bounded snapshot. This example assumes an initialized `nelcota` client and a
`render` function that replaces the displayed list:

```ts
async function poll(signal: AbortSignal) {
  const { data, error } = await nelcota.from('notes')
    .select('id,body,created_at').order('id', { ascending: false })
    .limit(100).abortSignal(signal);
  if (error) return error.retryAfter ?? 30;
  render(data);
  return 5;
}

function delay(seconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, seconds * 1000);
    signal.addEventListener('abort', finish, { once: true });
  });
}

const controller = new AbortController();
const finished = (async () => {
  while (!controller.signal.aborted) {
    const wait = document.hidden ? 60 : await poll(controller.signal);
    await delay(wait, controller.signal);
  }
})();
// On page/component teardown: controller.abort(); await finished; nelcota.dispose();
```

This refreshes visible UI state; it is not durable event delivery or a complete
history export. Do not infer exactly-once delivery from timestamps or increasing
IDs: equal timestamps, page caps and transaction commit order can skip rows in
cursor recipes. Use stable ordering for pagination. For committed changes, use
the server's webhook contract with durable receiver deduplication.

### Server-side rendering with cookies

On a server that renders pages for signed-in users, keep the session in
cookies instead of memory, with a client created **per request**. The adapter
below works with any framework's cookie API (Next.js `cookies()`, Express
`req.cookies`/`res.cookie`, Hono, SvelteKit...):

```ts
import { createClient, type SessionStorage } from '@nelcota/client';

interface CookieJar {
  get(name: string): string | undefined;
  set(name: string, value: string, options: Record<string, unknown>): void;
  delete(name: string): void;
}

export function cookieStorage(jar: CookieJar): SessionStorage {
  // Normalize this application's chosen key into a cookie name.
  // Use distinct fixed storageKey values; this mapping is not collision-free.
  const name = (key: string) => key.replace(/[^\w-]/g, '_');
  return {
    getItem: (key) => {
      const value = jar.get(name(key));
      return value === undefined ? null : decodeURIComponent(value);
    },
    setItem: (key, value) =>
      jar.set(name(key), encodeURIComponent(value), {
        httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30,
      }),
    removeItem: (key) => jar.delete(name(key)),
  };
}

// In a request handler:
const nelcota = createClient<Database>(process.env.NELCOTA_URL!, {
  auth: { storage: cookieStorage(jar), storageKey: 'nelcota', autoRefresh: false },
});
const { data: notes } = await nelcota.from('notes').select('id,body');
```

`httpOnly` keeps tokens away from page scripts. This adapter is illustrative:
user metadata can make a session exceed the browser's cookie-size limit, and
percent encoding increases its size. Use bounded sessions or a server-side store
with an opaque cookie identifier; handle decoding and storage failures. Framework
handlers must be allowed to write/delete cookies with matching path/domain flags.
Protect state-changing routes from CSRF. Never authorize from cached user metadata
alone; the server must verify the caller's token.

Refreshes from separate requests need shared coordination. An in-process lock
cannot serialize several server instances; centralize rotation in a shared
coordinator and let handlers reuse the accepted replacement.
`autoRefresh: false` (already the default outside browsers) keeps background
timers out of a request-scoped client; a token about to expire is still
refreshed before a request.

## Options

```ts
createClient<Database>(url, {
  auth: { storage, storageKey, autoRefresh, refreshMargin },
  accessToken,           // () => token | null, replaces the session
  fetch,                 // custom fetch (tests, tracing)
  headers,               // extra headers (browsers only send what CORS allows)
  timeout: 30_000,       // ms per attempt, including buffered bodies; file transfers default to none
  retries: 2,            // reads only, on 429/503 and network errors, honouring Retry-After
});
```

Every builder takes `.abortSignal(signal)` and `.timeout(ms)`; the other
calls take `{ signal, timeout }`.

Retries wait up to 30 seconds for `Retry-After`. A longer delay returns the
error immediately with `retryAfter`, allowing the app to decide when to retry.

## Compatibility

| @nelcota/client | Server baseline | Support |
|---|---|---|
| 0.2.x | Server `v0.3.0` or later | Full contract suite, OAuth routes, `updateUser`, exposed CORS headers and generated `Relationships` |
| 0.2.x | Server `v0.2.0` | Not supported: lacks the OAuth routes, `PUT /auth/v1/user`, the JSON error contract, generated `Relationships` and the newer exposed headers |

Release verification covers Node 22/24/26, Bun, Deno and the Chromium, Firefox
and WebKit engines. Other runtimes need their own validation.

## Development

```sh
npm ci
npm run check && npm test && npm run test:types   # types, unit and type-level tests
npm run build && npm run size                     # dist/ and the size budget per entry
npm run test:package                              # install the tarball in JS/TS consumers
node test/runtime/smoke.mjs
bun test/runtime/smoke.mjs
deno run --allow-net --allow-read --allow-env test/runtime/smoke.mjs
cargo build -p nelcota-server
npx playwright-core install chromium firefox webkit
npm run test:contract -- --browser                # against the real binary (Docker), plus Chromium
```

The contract run starts Postgres and Mailpit in containers and the server
from `target/debug`, applies `test/contract/fixture.sql` and generates the
types with `nelcota types`. It then runs the contract tests (including a
fuzz of the query encoding) and, with `--browser`, a Chromium page on
another origin.

Set `NELCOTA_SDK_BROWSERS=chromium,firefox,webkit` to exercise all browser
engines. Browser checks include the runnable demo, simultaneous refresh across
two real tabs and sign-out broadcasts. Each run owns unique container names
and dynamically assigned ports, so it can coexist with development services.

See [releasing.md](https://github.com/Nelcota/Nelcota/blob/main/sdk/typescript/docs/releasing.md) (in the repository) for the account setup, candidate checks
and tagged release procedure. [CHANGELOG.md](CHANGELOG.md) tracks SDK changes.
