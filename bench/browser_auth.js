/* Bounded raw auth traffic, concurrent with navigation against owned HTTPS. */
(async ({ password, cycle }) => {
  const require = (condition, reason) => {
    if (!condition) throw new Error(`g05_auth_${reason}`);
  };
  require(typeof password === 'string' && password.length >= 32, 'fixture_password');
  require(Number.isSafeInteger(cycle) && cycle >= 0 && cycle < 5, 'fixture_cycle');
  const began = performance.now();
  const arrivals = [];
  const timings = {};
  const counts = {};
  let attempted = 0;
  let completed = 0;
  let inflight = 0;
  let maximumInflight = 0;
  let maximumArrivals = 0;
  let consumedBytes = 0;
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const record = (name) => { counts[name] = (counts[name] || 0) + 1; };
  const request = async (name, method, path, body, expected, access, graceDeadline) => {
    require(path.startsWith('/auth/v1/') || path.startsWith('/rest/v1/'), 'request_scope');
    require(!path.includes('//') && !path.includes('#'), 'request_path');
    require(attempted < 112, 'request_ceiling');
    attempted += 1;
    for (;;) {
      const now = performance.now();
      require(now - began < 40000, 'cycle_deadline');
      while (arrivals.length && arrivals[0] <= now - 1000) arrivals.shift();
      if (arrivals.length < 16) {
        arrivals.push(now);
        maximumArrivals = Math.max(maximumArrivals, arrivals.length);
        break;
      }
      await delay(25);
    }
    inflight += 1;
    maximumInflight = Math.max(maximumInflight, inflight);
    require(inflight <= 8, 'inflight_ceiling');
    const start = performance.now();
    try {
      const headers = { 'Content-Type': 'application/json', 'X-G05-Auth-Pressure': String(cycle) };
      if (access) headers.Authorization = `Bearer ${access}`;
      const options = { method, headers, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000) };
      if (body !== undefined) options.body = JSON.stringify(body);
      const response = await fetch(path, options);
      const reader = response.body?.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let text = '';
      let received = 0;
      try {
        if (reader) {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            received += chunk.value.byteLength;
            consumedBytes += chunk.value.byteLength;
            require(received <= 65536 && consumedBytes <= 112 * 65536, 'response_byte_ceiling');
            text += decoder.decode(chunk.value, { stream: true });
          }
        }
        text += decoder.decode();
      } finally {
        if (reader) {
          await reader.cancel();
          reader.releaseLock();
        }
      }
      const elapsed = performance.now() - start;
      require(Number.isFinite(elapsed) && elapsed > 0 && performance.now() - began < 40000, 'response_deadline');
      if (graceDeadline !== undefined) require(performance.now() < graceDeadline, 'retry_grace_precondition');
      require(response.status === expected, `${name}_http_${response.status}`);
      let value = null;
      if (text) value = JSON.parse(text);
      completed += 1;
      record(name);
      if (expected < 300) (timings[name] ||= []).push(elapsed);
      return value;
    } finally {
      inflight -= 1;
    }
  };
  const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
  const session = (value, user, email) => {
    require(value && !Array.isArray(value) && value.token_type === 'bearer', 'session_shape');
    require(typeof value.access_token === 'string' && value.access_token.length > 0 && value.access_token.length <= 4096, 'access_shape');
    require(typeof value.refresh_token === 'string' && value.refresh_token.length > 0 && value.refresh_token.length <= 4096, 'refresh_shape');
    require(Number.isSafeInteger(value.expires_in) && value.expires_in > 0 && value.expires_in <= 900, 'expiry_shape');
    require(uuid(value.user?.id) && value.user.email === email, 'session_identity');
    require(!['encrypted_password', 'password_hash', 'token_hash', 'password'].some((key) => key in value.user), 'private_session_field');
    if (user) require(value.user.id === user, 'foreign_session');
    const segments = value.access_token.split('.');
    require(segments.length === 3, 'jwt_segments');
    const claims = JSON.parse(atob(segments[1].replaceAll('-', '+').replaceAll('_', '/')));
    require(uuid(claims.session_id) && claims.sub === value.user.id, 'session_claims');
    return { ...value, family: claims.session_id };
  };
  const refresh = async (token, user, email) => session(await request('refresh', 'POST', '/auth/v1/token?grant_type=refresh_token', { refresh_token: token }, 200), user, email);
  const invalidGrant = async (name, path, body) => {
    const value = await request(name, 'POST', path, body, 400);
    require(value?.code === 'invalid_grant', `${name}_code`);
  };
  await Promise.all(Array.from({ length: 8 }, async () => {
    const email = `g05-${cycle}-${crypto.randomUUID()}@example.test`;
    const first = session(await request('signup', 'POST', '/auth/v1/signup', { email, password }, 201), null, email);
    const user = first.user.id;
    const second = session(await request('login', 'POST', '/auth/v1/token?grant_type=password', { email, password }, 200), user, email);
    require(second.family !== first.family, 'independent_family');
    await invalidGrant('invalid_password', '/auth/v1/token?grant_type=password', { email, password: `${password}-wrong` });
    const me = await request('user', 'GET', '/auth/v1/user', undefined, 200, first.access_token);
    require(me?.id === user && me.email === email, 'user_canary');
    require(!['encrypted_password', 'password_hash', 'token_hash', 'password'].some((key) => key in me), 'private_user_field');
    const rows = await request('rls', 'GET', '/rest/v1/bench_private?limit=1', undefined, 200, first.access_token);
    require(Array.isArray(rows) && rows.length === 0, 'private_rows_exposed');
    const rotationBegan = performance.now();
    const rotated = await refresh(first.refresh_token, user, email);
    const retried = session(await request('refresh', 'POST', '/auth/v1/token?grant_type=refresh_token', { refresh_token: first.refresh_token }, 200, undefined, rotationBegan + 10000), user, email);
    require(performance.now() - rotationBegan < 10000, 'retry_grace_precondition');
    require(rotated.refresh_token !== retried.refresh_token && rotated.family === first.family && retried.family === first.family, 'retry_family');
    const latest = await refresh(retried.refresh_token, user, email);
    require(latest.family === first.family, 'rotation_family');
    await invalidGrant('reuse_rejected', '/auth/v1/token?grant_type=refresh_token', { refresh_token: first.refresh_token });
    await invalidGrant('family_revoked', '/auth/v1/token?grant_type=refresh_token', { refresh_token: latest.refresh_token });
    const independent = await refresh(second.refresh_token, user, email);
    require(independent.family === second.family, 'other_family_revoked');
    await request('logout', 'POST', '/auth/v1/logout', {}, 204, independent.access_token);
    await invalidGrant('logout_refresh_rejected', '/auth/v1/token?grant_type=refresh_token', { refresh_token: independent.refresh_token });
    const after = await request('rls', 'GET', '/rest/v1/bench_private?limit=1', undefined, 200, independent.access_token);
    require(Array.isArray(after) && after.length === 0, 'logout_access_contract');
  }));
  require(attempted === 112 && completed === 112 && inflight === 0, 'request_accounting');
  const latencies = {};
  for (const [name, values] of Object.entries(timings)) {
    values.sort((a, b) => a - b);
    const percentile = (fraction) => values[Math.max(0, Math.ceil(values.length * fraction) - 1)];
    latencies[name] = { samples: values.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95), p99_ms: percentile(0.99) };
  }
  const measurement = { cycle, status: 'measured', requests_attempted: attempted, requests_completed: completed,
    maximum_inflight: maximumInflight, maximum_arrivals_per_second: maximumArrivals, accounts_created: 8,
    counts, successful_latency: latencies, elapsed_seconds: (performance.now() - began) / 1000,
    response_bytes_consumed: consumedBytes,
    mutation_retries: 0 };
  require(typeof globalThis.g05RecordAuthMeasurement === 'function', 'measurement_bridge');
  await globalThis.g05RecordAuthMeasurement(measurement);
  require(latencies.login.p95_ms <= 750 && latencies.login.p99_ms <= 1500, 'login_slo');
  for (const name of ['refresh', 'user', 'rls']) require(latencies[name].p95_ms <= 200 && latencies[name].p99_ms <= 500, `${name}_slo`);
  return { ...measurement, status: 'passed', elapsed_seconds: (performance.now() - began) / 1000,
    scope: 'Raw backend auth across both real consumers; expected retry grace and stale-token reuse are distinct. SMTP/OAuth not exercised.' };
})
