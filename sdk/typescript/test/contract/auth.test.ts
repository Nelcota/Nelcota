import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createClient, memoryStorage, type FetchLike } from '../../src/index.js';
import { URL_, emailLink, signedIn, skip, visitor } from './setup.js';

describe.skipIf(skip)('auth against the server', () => {
  it.each(['refresh', 'query', 'getSession'] as const)('cancels %s promptly while persisting an accepted shared rotation', async kind => {
    const { client: original } = await signedIn();
    const session = (await original.auth.getSession()).data!;
    let accepted!: () => void, release!: () => void;
    const begun = new Promise<void>(resolve => { accepted = resolve; });
    let requestSignal: AbortSignal | null | undefined;
    let first = true;
    const transport: FetchLike = async (url, init) => {
      const response = await fetch(url, init);
      if (!first || !String(url).includes('/auth/v1/token')) return response;
      first = false;
      requestSignal = init?.signal;
      const body = await response.text(); // the real server has spent the old token
      const wait = new Promise<void>((resolve, reject) => {
        const abort = (): void => reject(init?.signal?.reason);
        release = () => { init?.signal?.removeEventListener('abort', abort); resolve(); };
        init?.signal?.addEventListener('abort', abort, { once: true });
      });
      accepted();
      await wait;
      return new Response(body, { status: response.status, headers: response.headers });
    };
    const client = createClient(URL_, { fetch: transport, auth: { autoRefresh: false } });
    try {
      await client.auth.setSession({ ...session, expires_at: Math.floor(Date.now() / 1000) + 1 });
      const controller = new AbortController();
      const pending = kind === 'refresh' ? client.auth.refreshSession({ signal: controller.signal })
        : kind === 'query' ? client.from('customers').select().abortSignal(controller.signal).execute()
          : client.auth.getSession({ signal: controller.signal });
      await begun;
      const survivor = client.auth.refreshSession();
      controller.abort();
      expect((await pending).error?.code).toBe('aborted');
      expect(requestSignal?.aborted).not.toBe(true);
      release();
      const rotated = await survivor;
      expect(rotated.error).toBeNull();
      expect(rotated.data!.refresh_token).not.toBe(session.refresh_token);
      expect((await client.auth.getSession()).data?.refresh_token).toBe(rotated.data!.refresh_token);
      expect((await client.auth.refreshSession()).error).toBeNull();
    } finally { release?.(); client.dispose(); original.dispose(); }
  });

  it('signs up, reads the user, signs in again', async () => {
    const { client, email, password, id } = await signedIn();
    expect((await client.auth.getUser()).data).toMatchObject({ id, email });
    const again = visitor();
    const { data, error } = await again.auth.signInWithPassword({ email, password });
    expect(error).toBeNull();
    expect(data?.user.id).toBe(id);
    const wrong = await visitor().auth.signInWithPassword({ email, password: 'nope-nope-nope' });
    expect(wrong.error).toMatchObject({ status: 400, code: 'invalid_grant' });
    // An unknown email gets the same answer, so the response does not reveal which was wrong.
    const unknown = await visitor().auth.signInWithPassword({ email: `nobody-${randomUUID()}@example.com`, password });
    expect(unknown.error).toMatchObject({ status: 400, code: 'invalid_grant' });
    const duplicate = await visitor().auth.signUp({ email, password });
    expect(duplicate.error).toMatchObject({ status: 409, code: 'user_already_exists' });
  });

  it('updates metadata and changes the password with the current one', async () => {
    const { client, email, password } = await signedIn();
    const meta = await client.auth.updateUser({ data: { plan: 'pro', tmp: 1 } });
    expect(meta.error).toBeNull();
    expect(meta.data!.user_metadata).toEqual({ plan: 'pro', tmp: 1 });
    expect((await client.auth.updateUser({ data: { tmp: null } })).data!.user_metadata).toEqual({ plan: 'pro' });

    const other = visitor();
    expect((await other.auth.signInWithPassword({ email, password })).error).toBeNull();
    const next = `pw-${randomUUID()}`;
    expect((await client.auth.updateUser({ password: next })).error?.code).toBe('validation_failed');
    expect((await client.auth.updateUser({ password: next, currentPassword: 'wrong-password' })).error?.code).toBe('invalid_grant');
    expect((await client.auth.updateUser({ password: 'short', currentPassword: password })).error?.code).toBe('weak_password');
    expect((await client.auth.updateUser({ password: next, currentPassword: password })).error).toBeNull();

    // The other session ends; this one keeps refreshing.
    expect((await other.auth.refreshSession()).error?.code).toBe('invalid_grant');
    expect((await client.auth.refreshSession()).error).toBeNull();
    expect((await visitor().auth.signInWithPassword({ email, password: next })).error).toBeNull();
  });

  it('rotates refresh tokens, and a reused one ends the session (as the server enforces)', async () => {
    const { client } = await signedIn();
    const first = (await client.auth.getSession()).data!;
    const second = await client.auth.refreshSession();
    expect(second.error).toBeNull();
    expect(second.data!.refresh_token).not.toBe(first.refresh_token);
    // Rotate once more so the replay below is not a retry inside the grace window.
    expect((await client.auth.refreshSession()).error).toBeNull();

    // Another client replaying the old token: the server ends the session.
    const replay = visitor();
    await replay.auth.setSession(first);
    expect((await replay.auth.refreshSession()).error?.code).toBe('invalid_grant');
    expect((await replay.auth.getSession()).data).toBeNull();
    expect((await client.auth.refreshSession()).error?.code).toBe('invalid_grant');
  });

  it('many concurrent requests near expiry refresh once and keep the session alive', async () => {
    const { client } = await signedIn();
    const session = (await client.auth.getSession()).data!;
    await client.auth.setSession({ ...session, expires_at: Math.floor(Date.now() / 1000) + 5 });
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() => client.rpc('whoami')));
    for (const { error } of results) expect(error).toBeNull();
    const after = (await client.auth.getSession()).data!;
    expect(after.refresh_token).not.toBe(session.refresh_token);
    expect((await client.auth.refreshSession()).error).toBeNull();
  });

  it('two tabs sharing storage refresh one at a time', async () => {
    const storage = memoryStorage();
    const tab = () => createClient(URL_, { auth: { storage, autoRefresh: false } });
    const a = tab();
    const email = `sdk-${randomUUID()}@example.com`;
    await a.auth.signUp({ email, password: 'pw-shared-tabs-1' });
    const session = (await a.auth.getSession()).data!;
    await a.auth.setSession({ ...session, expires_at: Math.floor(Date.now() / 1000) + 5 });
    const b = tab();
    const [ra, rb] = await Promise.all([a.auth.getSession(), b.auth.getSession()]);
    expect(ra.error).toBeNull();
    expect(rb.error).toBeNull();
    expect(ra.data?.refresh_token).toBe(rb.data?.refresh_token);
    expect((await b.auth.refreshSession()).error).toBeNull();
  });

  it('sign-out revokes the refresh token on the server', async () => {
    const { client } = await signedIn();
    const session = (await client.auth.getSession()).data!;
    expect((await client.auth.signOut()).error).toBeNull();
    expect((await client.auth.getSession()).data).toBeNull();
    const replay = visitor();
    await replay.auth.setSession(session);
    expect((await replay.auth.refreshSession()).error?.code).toBe('invalid_grant');
  });

  it('signs in with a magic link from a real email', async () => {
    const { email, id } = await signedIn();
    const nelcota = visitor();
    expect((await nelcota.auth.sendMagicLink(email)).error).toBeNull();
    const link = nelcota.auth.readEmailLink(await emailLink(email, 'https://app.example.com/signed-in'));
    expect(link?.type).toBe('magiclink');
    const { data, error } = await nelcota.auth.verifyEmailLink({ type: 'magiclink', token: link!.token });
    expect(error).toBeNull();
    expect(data?.user.id).toBe(id);
    const reused = await visitor().auth.verifyEmailLink({ type: 'magiclink', token: link!.token });
    expect(reused.error?.status).toBeGreaterThanOrEqual(400);
  });

  it('resets a password from a recovery email', async () => {
    const { email } = await signedIn();
    const nelcota = visitor();
    expect((await nelcota.auth.requestPasswordReset(email)).error).toBeNull();
    expect((await nelcota.auth.requestPasswordReset(`nobody-${randomUUID()}@example.com`)).error).toBeNull();
    const link = nelcota.auth.readEmailLink(await emailLink(email, 'https://app.example.com/new-password'));
    expect(link?.type).toBe('recovery');
    const reset = await nelcota.auth.resetPassword({ token: link!.token, password: 'a-brand-new-password' });
    expect(reset.error).toBeNull();
    expect((await visitor().auth.signInWithPassword({ email, password: 'a-brand-new-password' })).error).toBeNull();
  });

  it('OAuth: unconfigured providers and bogus codes come back as errors', async () => {
    const nelcota = visitor();
    const { data } = await nelcota.auth.signInWithOAuth({ provider: 'github', redirectTo: 'https://app.example.com/back', redirect: false });
    const response = await fetch(data!.url, { redirect: 'manual' });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const exchange = await nelcota.auth.exchangeCode('not-a-real-code');
    expect(exchange.error?.status).toBe(400);
  });
});
