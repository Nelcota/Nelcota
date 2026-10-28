import type { Page } from '@playwright/test'

export async function fixture(page: Page, contentLanguage: 'pt-BR' | 'en' = 'pt-BR') {
  const stamp = '2026-10-08T10:30:00Z';
  const rls = { state: 'ok', label: 'RLS enabled', enabled: true, forced: false, policies: 1 };
  const tables = ['notes', 'profiles', 'tasks'].map(name => ({ name, kind: 'table', has_pk: true, rls }));
  const columns = [
    { name: 'id', type: 'uuid', full_type: 'uuid', category: 'U', nullable: false, has_default: true, generated: false, enum_values: [], is_pk: true, comment: null, references: null },
    { name: 'title', type: 'text', full_type: 'text', category: 'S', nullable: false, has_default: false, generated: false, enum_values: [], is_pk: false, comment: null, references: null },
    { name: 'body', type: 'text', full_type: 'text', category: 'S', nullable: true, has_default: false, generated: false, enum_values: [], is_pk: false, comment: null, references: null },
    { name: 'created_at', type: 'timestamptz', full_type: 'timestamp with time zone', category: 'D', nullable: false, has_default: true, generated: false, enum_values: [], is_pk: false, comment: null, references: null },
  ];
  const grants = { anon: ['SELECT'], authenticated: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] };
  const noteTitles = contentLanguage === 'en' ? ['Weekly planning', 'API integration', 'Panel review'] : ['Planejamento da semana', 'Integração com a API', 'Revisão do painel'];
  const noteBody = contentLanguage === 'en' ? 'Example content for reviewing the interface.' : 'Texto de exemplo para revisão visual da interface.';
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, title: noteTitles[i % 3], body: noteBody, created_at: stamp }));
  const projects = [{ name: 'nelcota-demo', url: null, current: true }, { name: 'loja-demo', url: 'https://shop.example.test', current: false }];
  const bucket = { id: 'documents', public: true, file_size_limit: 10485760, allowed_mime_types: null, created_at: stamp, files: 3, bytes: 1258291 };
  await page.unrouteAll({behavior:'ignoreErrors'});
  await page.route('**/admin/api/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.slice('/admin/api'.length);
    const search = url.searchParams.get('q') ?? '';
    const reply = (json: unknown) => route.fulfill({ status: 200, json });
    if (path === '/tokens/deploy' && req.method() === 'GET') return reply({ tokens: [] });
    if (path === '/profile') return reply({ avatar: null });
    if (path === '/session' || path === '/login') return reply({ email: 'admin@example.test' });
    if (path === '/whoami') return reply({ project: 'nelcota-demo' });
    if (path === '/projects') return reply({ current: 'nelcota-demo', sso: true, projects });
    if (path === '/projects/status') return reply({ current: 'nelcota-demo', projects: projects.map(p => ({ ...p, healthy: true, version: '0.1.0', latency_ms: 18 })) });
    if (path === '/overview') return reply({ schema: 'public', counts: { tables: 3, users: 12, signed_in_users: 0, policies: 3, functions: 2 }, exposed_without_rls: [], tables: tables.map(t => ({ ...t, comment: null, rows: 12, rows_exact: true, grants })) });
    if (path === '/tables' && req.method() === 'GET') return reply({ schema: 'public', tables });
    if (path === '/schema') return reply({ schema: 'public', tables: Object.fromEntries(tables.map(t => [t.name, columns.map(c => c.name)])) });
    if (path === '/types') return reply({ base: ['text', 'uuid', 'bigint', 'boolean', 'jsonb', 'timestamptz'], enums: [] });
    if (/^\/tables\/[^/]+\/structure$/.test(path)) return reply({ name: path.split('/')[2], comment: 'Dados de exemplo', rls_enabled: true, primary_key: ['id'], primary_key_constraint: 'notes_pkey', columns: columns.map(c => ({ name: c.name, data_type: c.full_type, nullable: c.nullable, default: c.name === 'id' ? 'gen_random_uuid()' : c.has_default ? 'now()' : null, identity: null, generated: false, primary_key: c.is_pk, unique: null, references: null, comment: null })), grants: [{ role: 'anon', privileges: ['select'] }, { role: 'authenticated', privileges: ['select', 'insert', 'update', 'delete'] }, { role: 'service_role', privileges: ['select', 'insert', 'update', 'delete'] }] });
    if (/^\/tables\/[^/]+$/.test(path) && req.method() === 'GET') return reply({ table: { ...tables[0], name: path.split('/')[2], comment: null, primary_key: ['id'], editable: true, insertable: true, exposed_without_rls: false, columns }, rows, page: 0, size: 50, has_next: false, total: 12, total_exact: true });
    if (path === '/users' && req.method() === 'GET') return reply({ page: 0, users: Array.from({ length: 6 }, (_, i) => ({ id: rows[i].id, email: ['ana@example.test', 'bruno@example.test', 'carla@example.test'][i % 3], created_at: stamp, last_sign_in_at: i % 2 ? null : stamp, email_confirmed_at: i === 1 ? null : stamp, sessions: i, has_password: i % 3 !== 2, providers: i === 0 ? ['google'] : i % 3 === 2 ? ['github'] : [] })).filter(u => !search || u.email.includes(search)), total: 6, has_next: false });
    if (path === '/policies') return reply({ schema: 'public', exposed_without_rls: [], tables: tables.map(t => ({ ...t, exposed_without_rls: false, policies: [{ name: 'owner_access', permissive: true, roles: ['authenticated'], command: 'ALL', using: 'owner = auth.uid()', check: 'owner = auth.uid()' }] })), anon_functions: [] });
    if (path === '/storage') return reply({ enabled: true, backend: 'disk', max_file_size: 52428800, max_total_size: null, public_url: null, buckets: [bucket] });
    if (path === '/storage/buckets/documents') return reply(bucket);
    if (path === '/storage/buckets/documents/access' && req.method() === 'GET') return reply({ bucket: 'documents', public: false, policies: [{ name: 'documents_own_folder', command: 'ALL', roles: ['authenticated'], using: "((bucket_id = 'documents'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text))", check: "((bucket_id = 'documents'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text))", all_buckets: false }] });
    if (path === '/metrics') {
      const hourly = url.searchParams.get('range') === '1h'
      const count = hourly ? 60 : 96, step = hourly ? 60 : 900, end = Date.parse(stamp)
      const points = Array.from({ length: count }, (_, i) => ({ at: new Date(end - (count - 1 - i) * step * 1000).toISOString(), requests: 40 + (i % 12) * 9, refused: i % 5, errors: 0, p95_ms: 25 }))
      return reply({ range: hourly ? '1h' : '24h', step_secs: step, since: stamp, points, totals: { requests: points.reduce((a, p) => a + p.requests, 0), refused: points.reduce((a, p) => a + p.refused, 0), errors: 0, rest: 900, auth: 40, storage: 12, p95_ms: 25 } });
    }
    if (path === '/denied') return reply({ capacity: 100, requests: [{ at: stamp, method: 'GET', path: '/rest/v1/notes', status: 401, code: 'db_error', message: 'permission denied for table notes (42501)', role: 'anon', user_id: null, email: null }] });
    if (path === '/sign-in') return reply({ signup_enabled: true, email: false, email_confirmation: false, password_recovery: false, magic_link: false, providers: { google: false, github: true }, redirect_urls: ['https://app.example.test/auth/callback'], callback_url: 'https://api.example.test/auth/v1/callback', access_ttl_secs: 900, refresh_ttl_days: 30, rate_limit_per_minute: 30 });
    if (path === '/storage/buckets/documents/file' && req.method() === 'GET') {
      const name = url.searchParams.get('name');
      if (name?.endsWith('.png')) return route.fulfill({contentType:'image/png', body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')});
      if (name?.endsWith('.pdf')) return route.fulfill({contentType:'application/pdf', body:'%PDF-1.4\n1 0 obj<</Type /Catalog>>endobj\n%%EOF'});
      return route.fulfill({contentType:'text/plain', body:'Arquivo de exemplo\nPrévia em texto com acentos.'});
    }
    if (/\/objects$/.test(path)) return reply({ folders: url.searchParams.get('prefix') ? [] : ['reports'], objects: ['readme.txt', 'screenshot.png', 'report.pdf'].map((name, i) => ({ id: rows[i].id, name, size: 32768 * (i + 1), mime_type: ['text/plain', 'image/png', 'application/pdf'][i], owner: null, updated_at: stamp })), has_next: false });
    if (path === '/migrations' && req.method() === 'GET') return reply({ migrations: [{ version: 1, name: 'initial_schema', applied_on: stamp, in_folder: true, from_panel: false }, { version: 2, name: 'add_notes', applied_on: stamp, in_folder: false, from_panel: true }], pending: [{ id: 1, applied_at: stamp, summary: 'Add title column', statements: ['ALTER TABLE public.notes ADD COLUMN title text'], kind: 'add_column', target: 'title' }], next_version: 3, folder: '/app/migrations' });
    if (path === '/migrations') return reply({version:3,filename:'V3__changes.sql',message:'Migration exported',sql:'ALTER TABLE public.notes ADD COLUMN title text;',in_folder:false});
    if (path === '/sql') return reply({ results_truncated: false, results: [{ columns: ['id', 'title'], rows: rows.map(r => [r.id, r.title]), count: rows.length, truncated: false }] });
    if (req.method() !== 'GET') return reply({ applied: false, catalog_pending: false, sql: ['-- Prévia fictícia para revisão da interface'], count: 1 });
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Mock endpoint not configured' }) });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/admin/');
}
