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
  Web Locks and `BroadcastChannel`, and runs in browsers, Bun, Node 22+ and
  Deno. Edge hosts need the same Web APIs and host-specific validation.
  ESM only, side-effect free, with subpath exports
  (`/rest`, `/auth`, `/storage`).
- **Typed from your schema** by `nelcota types`, down to the embeds in a
  `select` string.
- **Safe by construction.** Input never becomes query syntax, storage paths
  cannot climb out of their bucket, and a `service_role` token is refused in
  a browser.

```sh
bun add @nelcota/client@0.2.5   # or: npm install @nelcota/client@0.2.5
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

This guide targets 0.2.5. Installation commands pin the published 0.2.5 baseline;
its REST builders already support `.execute()`, so the examples work there too.
The current checkout makes `.execute()` mandatory (awaiting a builder rejects);
it also exposes untyped row fields as `unknown`. Those breaking changes are
unreleased and require the next package release, not a reinstall of 0.2.5.
Version 0.2.4 is the previous published baseline.
The patch parses JSON in large responses about 8 to 12 times faster, with the
same results: the pass that keeps unsafe integers and long decimals exact is
skipped when no number in the response can lose digits.
Earlier session, refresh, query and transport corrections remain included; see
the [changelog](CHANGELOG.md) and [upgrade notes](docs/contract.md#upgrading-from-020).
Version 0.2.5 is available on npm; [registry receipts](https://github.com/Nelcota/Nelcota/pull/202#issuecomment-6445288705)
record integrity and consumer checks. Updating the server does not update installed clients. Node is SDK tooling/runtime, not a backend requirement.

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
  `network_error` (no answer), `response_body_error` (an answer whose body
  could not be read: a write may have committed), `timeout`, `aborted`,
  `invalid_response`, `not_single`, `session_missing`, `session_unavailable`
  (session storage failed; `cause` holds the original error), `refresh_pending`
  (another tab is rotating the session), `pkce_missing`, `oauth_error` (an
  unknown OAuth redirect error, kept in `details`). A response without a JSON body (a HEAD
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

A few calls throw instead of returning a result, by design:

- `auth.accessToken()` returns the token or throws the `NelcotaError`; it is
  a token source (`{ accessToken: () => auth.accessToken() }`).
- `auth.setSession(session)` and the sign-in and sign-out methods reject when
  the session storage itself fails. `getSession()`, `refreshSession()` and
  requests return such a failure as `session_unavailable` instead.
- A caller-supplied `accessToken` function or `fetch` may throw its own errors.

A response returned by `storage.from(bucket).open()` is caller-owned: handle
errors while reading its stream.

REST builders send a request only when `.execute()` is called. Builders are
not promises: awaiting one, returning it from an async function or passing it
to `Promise.all` rejects with a `NelcotaUsageError`, and TypeScript types the
awaited value as `never`. Auth, storage and RPC methods already return promises.

```ts
const { data, error } = await nelcota.from('notes').select('id,body').execute();
if (error) console.error(error.code, error.message);
```

To use exceptions instead, call `.throwOnError()` on a query (its result
type then has no error branch) or pass any result to `unwrap`, which
returns `data` or throws the `NelcotaError`:

```ts
import { unwrap } from '@nelcota/client';

const { data: notes } = await nelcota.from('notes').select('id,body').throwOnError().execute();
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
  .range(0, 19).execute();
// data: { id: number | string; total: number | string; customer: { name: string } | null;
//         items: { product: string; qty: number }[] }[]

// One row: an error (not_single) unless exactly one matches.
const { data: order } = await nelcota.from('orders').select().eq('id', 10).single().execute();

// Only the count (a HEAD request, no rows).
const { count: open } = await nelcota.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'open').execute();

// Groups: conditions are built with typed calls, never strings.
await nelcota.from('products').select().or((c) => [
  c.eq('status', 'featured'),
  c.and([c.gt('price', 100), c.not(c.is('archived', true))]),
]).execute();

// Writes return nothing unless you ask for the rows with select().
await nelcota.from('notes').insert({ body: 'hi' }).execute();
const { data: created } = await nelcota.from('notes').insert({ body: 'hi' }).select('id').single().execute();
await nelcota.from('notes').update({ body: 'edited' }).eq('id', 1).execute();
await nelcota.from('notes').delete().in('id', [1, 2, 3]).execute();
await nelcota.from('products').upsert(rows, { onConflict: 'slug' }).execute();      // or ignoreDuplicates: true

// Functions run with the caller's role.
const { data: total } = await nelcota.rpc('cart_total', { cart_id: 7 });
```

With column-level GRANTs, merging an upsert needs `UPDATE` on **every payload
column, including the conflict key**. For `upsert({ id, name })`, grant both:

```sql
GRANT INSERT (id, name), UPDATE (id, name) ON public.products TO authenticated;
```

The server includes the conflict key in `ON CONFLICT ... DO UPDATE SET`, even
when its value stays the same. `UPDATE (name)` alone returns SQLSTATE `42501`.
`ignoreDuplicates: true` uses `DO NOTHING` and does not need the UPDATE grant;
it keeps the existing row unchanged. SELECT grants and RLS policies still apply.


Filters: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`,
`is` (`null`, `true`, `false`, `'unknown'`), `not(column, op, value)`,
`match({...})`, `or(...)` and `and(...)`. A column path such as
`orders.total` filters an embed. Builders are immutable, so a base query can
be reused.

`like`/`ilike` read `*` (or `%`) as "any text". Wrap text a person typed in
`escapeLike` so `%`, `_`, `*` and `\` match literally. A typed `*` is sent as
`\*`, which needs a server that reads it as a literal `*`; older servers read
it as a literal `%`:

```ts
import { escapeLike } from '@nelcota/client';
nelcota.from('products').select().ilike('name', `*${escapeLike(search)}*`);
```

`update` and `delete` need at least one filter; the server refuses them
otherwise. They change every matching row, so `order`, `limit`, `offset` and
`range` throw a `NelcotaUsageError` on them, as filters do on `insert` and
`upsert`. Modifiers aimed at an embed of `.select()`, such as
`limit(5, { referencedTable: 'comments' })`, remain allowed. `count: 'exact'`
scans every matching row, so ask for it only when you show it.

HEAD queries return `data: null`. `single()` and `maybeSingle()` require
rows: use `.select()` on inserts first, and omit `head: true`. They throw on
`update`/`delete`, which would change every matching row before the client
could count them: filter on a unique key and check the returned rows instead.
A wrong row count returns `not_single`; the error has `status: 0` and the
result keeps the real HTTP status.

### Paging

The server returns at most `NELCOTA_MAX_ROWS` rows per request (1000 by
default), even without a `limit`. Page with `range(from, to)` or
`limit(n)` + `offset(n)`, and read `range` (the rows returned, from
`Content-Range`) and `count` (with `count: 'exact'`) to know whether more
rows exist:

```ts
const { data, range, count } = await nelcota
  .from('notes').select('id,body', { count: 'exact' }).order('id').range(0, 49).execute();
const more = range !== null && count !== null && range.to + 1 < count;
```

To walk every row, `pages(size)` requests one page after another until an
empty one, so a server cap below `size` cannot cut it short. A `limit` (or
`range`) already on the query caps the total number of rows. Order by a
unique column so pages neither overlap nor skip rows; a failed page throws
its `NelcotaError`:

```ts
for await (const page of nelcota.from('notes').select('id,body').order('id').pages(500)) {
  for (const note of page) console.log(note.id);
}
```

For optimistic concurrency, include the expected version in the filters and
request an affected-row count. Zero affected rows is a successful outcome:

```ts
const result = await nelcota.from('notes')
  .update({ title: 'Revised', version: expectedVersion + 1 }, { count: 'exact' })
  .eq('id', id).eq('version', expectedVersion).execute();
if (result.error) throw result.error;
if (result.count === 0) {
  // No visible row matched: reload or show that the save could not be applied.
}
```

`insert`, `upsert`, `update` and `delete` accept `count: 'exact'`, including
with `.select()`. The count respects GRANTs and RLS; zero cannot distinguish a
stale version from a missing or RLS-hidden row. It does not disclose hidden data.

For database policy tests, import the standalone `@nelcota/client/testing`
helpers. They reserve a `pg` or Bun SQL connection, impersonate API roles,
create fixture users and always roll back scenarios. See
[Testing RLS](../../docs/testing-rls.md) for the recommended test layout.

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
  // 'initial_session' | 'signed_in' | 'signed_out' | 'refreshed' | 'user_updated'
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

Each `onChange` subscription asynchronously receives `initial_session` once,
after storage is read, with the stored session or `null`. It precedes later
sign-in, refresh and user-update events for that subscription. It is a baseline,
so apps can distinguish restoration from a later identity change. Unsubscribing
or disposing cancels a pending baseline. Listener promises do not block auth.
Storage-read failures go to `onBackgroundError`; resubscribe after repairing
storage to obtain a new baseline.

**Refresh.** The access token is refreshed in the background before it
expires, and again right before a request when needed.

The server ends a session whose refresh token is used twice, so refreshes
are coordinated:

- One refresh at a time in a process, however many requests are waiting.
- Across tabs, a Web Lock serializes refreshes. A committed IndexedDB
  receipt hands the replacement to the next owner even when its
  `localStorage` view is stale. A reservation is committed before HTTP.

Native browser persistence requires IndexedDB. Storage failures reject
sign-in, sign-out and `setSession`; `getSession()`, `refreshSession()` and
requests return them as `session_unavailable`. Observe automatic refresh
failures with the `auth: { onBackgroundError }` option.

A reservation belongs to one client for 10 seconds, the server's
refresh-token retry window. Meanwhile other tabs keep reading the session and
using its access token, and an explicit refresh returns `refresh_pending`. A
reservation older than that (its tab closed or crashed mid-refresh) is taken
over: the next refresh retries the stored token, and the server either rotates
it or, when the lost rotation had already committed, answers `invalid_grant`,
which signs out cleanly.

Without Web Locks, a local queue coordinates clients in the same module
instance. The native journal prevents competing owners from spending a
reserved token, but cannot make them wait for the replacement. Custom shared
adapters need Web Locks or external coordination; use
`auth: { storage: sessionStorage }` for separate per-tab sessions.
Keep the same storage key when sharing a session adapter.

On upgrade, the journal imports the existing `localStorage` session once.
Reload all open tabs to avoid mixing old and new coordination protocols.
Removing the `localStorage` copy of a session (clearing site data or the key)
signs it out: once a stored session is more than five seconds old, a missing
copy clears the journal too.
Signing out also clears the pending OAuth verifier from the journal and
its storage mirror, including when no session exists or server logout fails.

Failed sign-in/logout publication keeps the newer local state while the exact
prior journal revision remains current, even if another client wrote that
prior revision. A new committed revision supersedes it, including an explicit
publication of the same value.

If a refresh fails for a transient reason (network, 429, 5xx, another tab's
pending rotation) while the access token is still valid, reads and requests
keep using it; further attempts wait for `Retry-After` or two seconds instead
of rotating on every request. An expired token is never sent: the request
returns the refresh failure instead of running as a visitor.

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

`handleRedirect()` acts only while a sign-in started here is pending (a stored
verifier): otherwise it returns `null` data and leaves the URL alone, so an
app's own `?code=` parameter is not mistaken for a callback. Server error
codes (`access_denied`, `provider_error`, `email_conflict`...) are kept;
any other `?error=` value becomes `oauth_error` with a sanitized copy in
`details`.

Native PKCE publication and consumption also use the IndexedDB journal, so
stale localStorage cannot supply an older verifier or reuse a consumed one.
The verifier is consumed only once the server answers definitely (a session
or a 4xx refusal): after a network failure, timeout or 5xx the same callback
can retry. An already cancelled exchange keeps its verifier. Once the exchange
starts, it persists an accepted session even if its caller cancels the wait;
the first exchange's timeout still applies.

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

A sign-up awaiting confirmation keeps a PKCE verifier under this storage key
(`<storageKey>.signup`, separate from the OAuth one). `verifyEmailLink()` sends
it with the signup link, which keeps the password chosen at sign-up, and
clears it once the confirmation succeeds; after a failure it stays for a
retry. A link opened in another browser, or a resent link, still confirms the
email and signs in, but the server clears the sign-up password: the person
sets one with `updateUser({ password })` or a recovery email.

**On a server**, forward the caller's token instead of keeping a session:

```ts
// Validate the header in middleware before constructing the client.
const nelcota = createClient<Database>(url, { accessToken: () => validatedCallerToken });
```

Create this client per request. `validatedCallerToken` is a token or null from
middleware that validates Bearer syntax and returns 401 for malformed headers.
Only an absent header means anonymous; do not turn malformed auth into a visitor.
The runnable [server example](examples/server.mjs) demonstrates validation and
forwarding to RLS. `accessToken` disables automatic session refresh in both
combined and standalone auth clients. `getUser()` and `updateUser()` use that
source without reading or updating a stored session; a null source returns
`session_missing` without HTTP. Other explicitly called auth methods can still
store sessions. Use separate clients for caller forwarding and managed login.

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
- **Timeouts.** `upload`, `download` and `open` have no timeout by default,
  unlike every other call (30 seconds per attempt): a large transfer may
  legitimately take longer. Pass `{ timeout }` (it covers the whole transfer,
  including a buffered body) or a `signal` such as `AbortSignal.timeout(ms)`
  to bound them.
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
    .limit(100).abortSignal(signal).execute();
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
import { createClient, type Session, type SessionStorage } from '@nelcota/client';

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
const { data: notes } = await nelcota.from('notes').select('id,body').execute();
```

`httpOnly` keeps tokens away from page scripts. This adapter is illustrative:
user metadata can make a session exceed the browser's cookie-size limit, and
percent encoding increases its size. Use bounded sessions or a server-side store
with an opaque cookie identifier; handle decoding and storage failures. Framework
handlers must be allowed to write/delete cookies with matching path/domain flags.
Protect state-changing routes from CSRF. Never authorize from cached user metadata
alone; the server must verify the caller's token.

**Keep one refresh owner.** A refresh token works once. When two requests carry
the same cookie and both refresh, the server answers both (a retry within a few
seconds still succeeds), but only the newest token stays valid. The browser
keeps whichever `Set-Cookie` it processes last. If that is the older one, the
next refresh presents a rotated token and the server ends the whole session.
One page load easily sends several requests at once (the document, prefetches,
data calls), so do not let every handler refresh:

- In render paths, read the cookie and send its access token without
  refreshing (as below). An expired token then answers 401 instead of rotating.
- Refresh in one place, such as a POST route the browser calls before the
  token expires, and serialize it per session with a lock that every server
  instance shares (for example a PostgreSQL advisory lock keyed by session).
  An in-process lock only covers one instance.
- Better, keep the tokens in a server-side store and put only an opaque random
  ID in the cookie, so a stale response can never bring back an older token.

```ts
// Render path: read the session cookie, never refresh it.
const stored = jar.get('nelcota');
const session = stored === undefined ? null : (JSON.parse(decodeURIComponent(stored)) as Session);
const nelcota = createClient<Database>(url, { accessToken: () => session?.access_token ?? null });
```

The repository's [Next.js integration](https://github.com/Nelcota/Nelcota/blob/main/sdk/nextjs/README.md)
follows this design: read-only Server Components, a refresh route and a shared
PostgreSQL session store with per-session locks. It is published as
`@nelcota/nextjs` 0.1.2, and its README documents each trade-off.

`autoRefresh: false` (already the default outside browsers) keeps background
timers out of a request-scoped client. A client with session storage still
refreshes a token about to expire before a request, so use it only where
refreshing is allowed.

## Options

```ts
createClient<Database>(url, {
  auth: { storage, storageKey, autoRefresh, refreshMargin, onBackgroundError },
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

Release verification covers Bun 1.4.3, the primary runtime, plus Node 22/24/26,
Deno and the Chromium, Firefox and WebKit engines. Other runtimes need their own validation.

## Development

```sh
bun install --frozen-lockfile
bun run check && bun run test && bun run test:types   # types, unit and type-level tests
bun run test:node                                     # the same unit tests on Node
bun run build && bun run size                         # dist/ and the size budget per entry
npm run test:package                                  # npm pack + install, as npm publishes and consumers install
bun run test:runtime && bun run test:runtime:node     # the built package on Bun, then Node
deno run --allow-net --allow-read --allow-env test/runtime/smoke.mjs
cargo build -p nelcota-server
bunx playwright-core install chromium firefox webkit
bun run test:contract -- --browser                    # against the real binary (Docker), plus Chromium
```

The contract run needs OpenSSL and builds a contract-only server from the
unchanged production entrypoint with lettre's native certificate loader.
It starts Postgres and Mailpit in containers, requires STARTTLS with a fresh
local CA trusted only by that server process, applies `test/contract/fixture.sql`
and generates the types with `nelcota types`. It then runs the contract tests (including a
fuzz of the query encoding) and, with `--browser`, a Chromium page on
another origin.

The supplied `target/debug` binary (or `NELCOTA_BIN`) still runs CLI type
generation and is not replaced. Ordinary production builds keep bundled Mozilla
roots. No certificate or hostname verification is disabled; the disposable
certificates and keys are removed with the fixture unless `--keep` is selected.

Set `NELCOTA_SDK_BROWSERS=chromium,firefox,webkit` to exercise all browser
engines. Browser checks include the runnable demo, simultaneous refresh across
two real tabs and sign-out broadcasts. Each run owns unique container names
and dynamically assigned ports, so it can coexist with development services.

See [releasing.md](https://github.com/Nelcota/Nelcota/blob/main/sdk/typescript/docs/releasing.md) (in the repository) for the account setup, candidate checks
and tagged release procedure. [CHANGELOG.md](CHANGELOG.md) tracks SDK changes.


## Reliable lifecycle and streaming

Create a server-side client per request or provide a per-request token source;
never share a user's mutable auth session across server requests. Dispose clients
when their owner ends. Since 0.2.2, async auth listener errors are reported to
`auth: { onBackgroundError }`; listeners can call auth without holding its lock.
If a custom session adapter fails, repair it and explicitly persist the retained
session before sharing it with other clients. Never log the session to diagnose
storage failures.

For a total request deadline, pass `AbortSignal.timeout(15_000)` to
`.abortSignal(...)`. The per-attempt timeout remains separate. For large files,
use `storage.from(bucket).open(name, { signal })`, consume `response.body` with
backpressure and cancel the body in `finally` if consumption stops early.
`download()` intentionally buffers a Blob. These patterns do not change the
server's upload limits or authorization rules.
