// Native k6 runner: the backend and benchmark runner require no Node runtime.
import http from 'k6/http';
import execution from 'k6/execution';
import { sha256 } from 'k6/crypto';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const configuration = JSON.parse(__ENV.FIXTURE);
const projects = configuration.projects ?? [configuration];
let fixture = projects[0];
const objectBytes=fixture.object_bytes ?? 17;
if (!Number.isSafeInteger(objectBytes) || objectBytes<1 || objectBytes>1048576) { throw new Error('Object payload exceeds its bounded fixture range'); }
function payload() {
  if (fixture.marker) { return fixture.marker+' payload'; }
  if (objectBytes===17) { return 'benchmark payload'; }
  return 'x'.repeat(objectBytes);
}
let base = fixture.base;
let projectIndex = 0;
const fleet = __ENV.FLEET === 'true';
const sessionCanary = __ENV.SESSION_CANARY === 'true';
if (!Array.isArray(projects) || projects.length<1 || projects.length>10) { throw new Error('Invalid bounded project fixture'); }
function scenarios() {
  if (fleet) {
    const rates = (__ENV.PROJECT_RATES || '').split(',').map(Number);
    if (projects.length < 1 || projects.length > 10 || rates.length !== projects.length || rates.some(value => !Number.isSafeInteger(value) || value < 1) || rates.reduce((a,b) => a+b,0) > 10000) { throw new Error('Invalid bounded fleet rates'); }
    return Object.fromEntries(projects.map((project,index) => ['project-'+index, { executor:'constant-arrival-rate', rate:rates[index], timeUnit:'1s', duration, preAllocatedVUs:Math.floor(128/projects.length), maxVUs:Math.floor(128/projects.length), exec:'project'+index }]));
  }
  if (rate > 0) {
    if (sessionCanary) { return { traffic:{ executor:'constant-arrival-rate',rate,timeUnit:'1s',duration,preAllocatedVUs:127,maxVUs:127 }, 'session-canary':{executor:'constant-vus',vus:1,duration,exec:'sessionProbe'} }; }
    return { traffic:{ executor:'constant-arrival-rate',rate,timeUnit:'1s',duration,preAllocatedVUs:128,maxVUs:128 } };
  }
  return { traffic:{ executor:'constant-vus',vus,duration } };
}
const kind = __ENV.WORKLOAD || 'mixed';
const vus = Number(__ENV.VUS || 16);
const rate = Number(__ENV.RATE || 0);
if (!Number.isSafeInteger(vus) || vus < 1 || vus > 128 || !Number.isSafeInteger(rate) || rate < 0 || rate > 10000) {
  throw new Error('VUS/RATE are outside campaign budgets');
}
const duration = __ENV.DURATION || '30s';
export const options = {
  scenarios: scenarios(),
  setupTimeout: '120s',
  systemTags: ['status', 'method', 'group', 'check', 'error_code', 'scenario'],
  tags: { run_id: __ENV.RUN_ID || 'standalone', project:'single' },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  // Keep bodies only for credential rotation and explicit RLS invariants.
  discardResponseBodies: true,
  thresholds: { unexpected: [{ threshold: 'rate==0', abortOnFail: true, delayAbortEval: '1s' }] },
};
const unexpected = new Rate('unexpected');
const successfulOperations = new Counter('successful_operations');
const accessRenewals=new Counter('access_renewals');
const successfulDuration = new Trend('successful_duration', true);
const assertionsPassed = new Counter('assertions_passed');
const assertionsFailed = new Counter('assertions_failed');
const expectedRejections = new Counter('expected_rejections');
const overloadRejections = new Counter('overload_rejections');
const invariantFailures = new Counter('invariant_failures');
const bootstrapSessions = new Counter('bootstrap_sessions');
function fail(reason = 'assertion', workload = 'invariant', status = 0) {
  assertionsFailed.add(1);
  unexpected.add(true);
  // Fixed operation labels and numeric status only: no URLs, bodies or tokens.
  invariantFailures.add(1, { reason, workload, status: String(status) });
  execution.test.abort(`Stress invariant failed: ${reason}; workload=${workload}; status=${status}`);
}
const timings = Object.fromEntries(['read','rls','panel','storage','login','refresh','write'].map(name => [name, new Trend(`latency_${name}`, true)]));
let refreshToken;
let accessToken;
let accessExpiresAt = 0;
const clientSessions = new Map();

export function setup() {
  if (!fleet && !['mixed','rls','refresh'].includes(kind) && !sessionCanary) { return null; }
  let slots=vus;
  if (fleet || rate>0 || sessionCanary) { slots=128; }
  const sessions=projects.map(() => Array(slots));
  const jobs=[];
  for (let slot=0;slot<slots;slot++) {
    for (let project=0;project<projects.length;project++) { jobs.push({project,slot}); }
  }
  for (let offset=0;offset<jobs.length;offset+=4) {
    const batch=jobs.slice(offset,offset+4);
    const responses=http.batch(batch.map(job => {
      const project=projects[job.project];
      return {method:'POST',url:project.base+'/auth/v1/token?grant_type=password',body:JSON.stringify({email:project.email,password:project.password}),params:{headers:{'Content-Type':'application/json'},responseType:'text',timeout:'12s',tags:{project:'bootstrap',workload:'client_bootstrap'}}};
    }));
    for (let index=0;index<batch.length;index++) {
      const job=batch[index];
      const response=responses[index];
      if (response.status!==200 || response.error_code!==0) { fail('client_bootstrap_status','bootstrap',response.status); }
      let value;
      try { value=response.json(); } catch { fail('client_bootstrap_json','bootstrap',response.status); }
      if (!value || typeof value.access_token!=='string' || !value.access_token || typeof value.refresh_token!=='string' || !value.refresh_token || !Number.isSafeInteger(value.expires_in) || value.expires_in<=0 || !Number.isSafeInteger(Date.now()+value.expires_in*1000) || value.user?.id!==projects[job.project].user) { fail('client_bootstrap_contract','bootstrap',response.status); }
      sessions[job.project][job.slot]=[value.access_token,value.refresh_token,Date.now()+value.expires_in*1000];
      bootstrapSessions.add(1,{project:'bootstrap'});
    }
  }
  return {sessions};
}

function hydrateSession(data) {
  if (!data?.sessions) { return; }
  let state=clientSessions.get(projectIndex);
  if (!state) {
    const prepared=data.sessions[projectIndex]?.[__VU-1];
    if (!Array.isArray(prepared) || prepared.length!==3 || typeof prepared[0]!=='string' || !prepared[0] || typeof prepared[1]!=='string' || !prepared[1] || !Number.isFinite(prepared[2]) || prepared[2]<=0) { fail('missing_bootstrap_session','bootstrap'); }
    state={access:prepared[0],refresh:prepared[1],expires:prepared[2]};
    clientSessions.set(projectIndex,state);
  }
  accessToken=state.access;refreshToken=state.refresh;accessExpiresAt=state.expires;
}

function request(name, method, path, { body = null, token, cookie, prefer } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) { headers.Authorization = `Bearer ${token}`; }
  if (cookie) { headers.Cookie = cookie; }
  if (prefer) { headers.Prefer = prefer; }
  const began = execution.instance.currentTestRunDuration;
  const response = http.request(method, base + path, body, { headers, responseType:'text', timeout: '12s', tags: { workload: name } });
  const logicalDuration = execution.instance.currentTestRunDuration - began;
  if (!Number.isFinite(logicalDuration) || logicalDuration < 0) { fail('latency_clock', name, response.status); return response; }
  const successStatus = response.status >= 200 && response.status < 300;
  const allowedStatuses = [200];
  if (name === 'storage' && method === 'PUT') { allowedStatuses.push(201); }
  if (successStatus && !allowedStatuses.includes(response.status)) { fail('unexpected_success_status', name, response.status); return response; }
  const ok = allowedStatuses.includes(response.status) && response.error_code === 0;
  if (ok) {
    timings[name].add(logicalDuration);
    successfulOperations.add(1, { workload: name });
    successfulDuration.add(logicalDuration);
  }
  const bounded = __ENV.OVERLOAD === 'true' && [429, 503, 504].includes(response.status) && [0, 1000 + response.status].includes(response.error_code);
  overloadRejections.add(0);
  if (bounded) { overloadRejections.add(1); }
  assertionsFailed.add(0);
  if (successStatus && !ok) { fail('http_transport', name, response.status); }
  if (!ok && !bounded) { fail('unexpected_http_status', name, response.status); }
  assertionsPassed.add(1);
  unexpected.add(false);
  check(response, { [`${name}: bounded response`]: () => ok || bounded });
  return response;
}

function jsonResponse(result, name) {
  try { return result.json(); } catch { fail('malformed_'+name, name, result.status); return null; }
}
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function productName(value) {
  if (typeof value !== 'string' || !value) { return false; }
  if (fixture.marker) { return value.startsWith(fixture.marker); }
  return value.startsWith('product ');
}
function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function read() {
  const stock=__ITER % 50;
  const result = request('read','GET',`/rest/v1/bench_products?stock=eq.${stock}&order=id&limit=20`);
  if (result.status !== 200) { return; }
  const rows=jsonResponse(result,'read');
  let first=stock;
  if (first===0) { first=50; }
  if (!Array.isArray(rows) || rows.length!==20 || !rows.every((row,index) => record(row) && row.id===first+index*50 && row.stock===stock && productName(row.name))) { fail('read_predicate_order_or_identity', 'read', result.status); return; }
  if (!fixture.marker && !rows.every(row => Number.isFinite(row.price) && row.price===Number(String(row.id%500)+'.99') && typeof row.created_at==='string' && Number.isFinite(Date.parse(row.created_at)))) { fail('read_fixture_values','read',result.status); return; }
  assertionsPassed.add(1);
}
function rls() {
  if (!ensureAccess()) { return; }
  const result = request('rls','GET','/rest/v1/bench_private?order=id&limit=20',{token:accessToken});
  if (result.status === 200) {
    const rows=jsonResponse(result,'rls');
    let expectedBody='x'.repeat(128);
    if (fixture.marker) { expectedBody=fixture.label; }
    const isolated = Array.isArray(rows) && rows.length === 20 && rows.every((row,index) => record(row) && row.id===2*(index+1) && row.user_id === fixture.user && row.body===expectedBody);
    if (!isolated) { fail('rls_boundary', 'rls', result.status); return; }
    assertionsPassed.add(1);
    check(result, { 'RLS preserves ownership': () => isolated });
  }
}
function panel() {
  const result=request('panel','GET','/admin/api/tables/bench_products?size=20',{cookie:fixture.cookie});
  if (result.status !== 200) { return; }
  const value=jsonResponse(result,'panel');
  if (!record(value) || !record(value.table) || value.table.name!=='bench_products' || value.page!==0 || value.size!==20 || value.has_next!==true || !Array.isArray(value.rows) || value.rows.length!==20 || !value.rows.every((row,index) => record(row) && row.id===String(index+1) && row.stock===String((index+1)%50) && productName(row.name))) { fail('panel_page_contract','panel',result.status); return; }
  if (!fixture.marker && !value.rows.every(row => row.price===String(Number(row.id)%500)+'.99' && typeof row.created_at==='string' && row.created_at.length>0)) { fail('panel_fixture_values','panel',result.status); return; }
  assertionsPassed.add(1);
}
function storage() {
  const operation = __ITER % 3;
  if (operation === 0) {
    const result=request('storage','POST','/storage/v1/object/list/bench',{body:JSON.stringify({prefix:'',limit:20,offset:0}),token:fixture.service});
    if (result.status!==200) { return; }
    const value=jsonResponse(result,'storage_list');
    if (!record(value) || !Array.isArray(value.folders) || value.folders.length!==0 || !Array.isArray(value.objects) || value.objects.length<1 || value.objects.length>20 || !value.objects.every(item => record(item) && uuid(item.id) && typeof item.name==='string' && Number.isSafeInteger(item.size) && item.size>=0 && typeof item.etag==='string' && /^[0-9a-f]{64}$/.test(item.etag))) { fail('storage_listing_contract','storage',result.status); return; }
    if (!fixture.marker && (value.objects.length!==20 || !value.objects.every((item,index) => item.name===String(index+1).padStart(8,'0')+'.txt' && item.size===0 && item.etag===sha256('','hex')))) { fail('storage_listing_fixture','storage',result.status); return; }
    if (fixture.marker && !value.objects.every(item => item.name==='fixture.txt' || /^probe-[0-9]+\.txt$/.test(item.name))) { fail('storage_listing_project','storage',result.status); return; }
    assertionsPassed.add(1);
    return;
  }
  if (operation === 1) {
    const result = request('storage','GET','/storage/v1/object/public/bench/fixture.txt');
    if (result.status >= 200 && result.status < 300 && result.status !== 200) { fail('object_status', 'storage', result.status); }
    if (result.status === 200) {
      let expected=payload();
      if (fixture.marker || objectBytes===17) { expected=JSON.stringify(expected); }
      if (result.body !== expected) { fail('object_bytes', 'storage', result.status); }
      assertionsPassed.add(1);
    }
    return;
  }
  const name=`probe-${__VU}.txt`;
  const body=payload();
  const result=request('storage','PUT',`/storage/v1/object/bench/${name}`,{body,token:fixture.service});
  if (result.status<200 || result.status>=300) { return; }
  const value=jsonResponse(result,'storage_upload');
  if (!record(value) || !uuid(value.id) || value.bucket!=='bench' || value.name!==name || value.size!==body.length || value.etag!==sha256(body,'hex')) { fail('storage_upload_receipt','storage',result.status); return; }
  assertionsPassed.add(1);
}
function installSession(result) {
  if (result.status !== 200) { return false; }
  let value;
  try { value = result.json(); } catch { fail('malformed_session', 'auth', result.status); return false; }
  if (!value || typeof value.access_token !== 'string' || !value.access_token || typeof value.refresh_token !== 'string' || !value.refresh_token || !Number.isSafeInteger(value.expires_in) || value.expires_in <= 0 || !Number.isSafeInteger(Date.now()+value.expires_in*1000) || value.user?.id!==fixture.user) {
    fail('invalid_session_contract', 'auth', result.status);
    return false;
  }
  accessToken = value.access_token;
  refreshToken = value.refresh_token;
  accessExpiresAt = Date.now() + value.expires_in * 1000;
  clientSessions.set(projectIndex,{access:accessToken,refresh:refreshToken,expires:accessExpiresAt});
  return true;
}
function login() {
  return installSession(request('login','POST','/auth/v1/token?grant_type=password',{body:JSON.stringify({email:fixture.email,password:fixture.password})}));
}
function refresh() {
  if (!refreshToken) { return login(); }
  return installSession(request('refresh','POST','/auth/v1/token?grant_type=refresh_token',{body:JSON.stringify({refresh_token:refreshToken})}));
}
function ensureAccess() {
  if (accessToken && Date.now() < accessExpiresAt - 30000) { return true; }
  if (refreshToken) {
    const renewed=refresh();
    if (renewed && sessionCanary && execution.scenario.name==='session-canary') { accessRenewals.add(1); }
    return renewed;
  }
  return login();
}
function write() {
  let name=`product ${__ITER % 1000}`;
  if (fixture.marker) { name=`${fixture.marker}${__ITER % 1000}`; }
  const id=(__ITER%1000)+1;
  const result=request('write','PATCH',`/rest/v1/bench_products?id=eq.${id}`,{body:JSON.stringify({name}),token:fixture.service,prefer:'return=representation'});
  if (result.status!==200) { return; }
  const rows=jsonResponse(result,'write');
  if (!Array.isArray(rows) || rows.length!==1 || !record(rows[0]) || rows[0].id!==id || rows[0].name!==name || rows[0].stock!==id%50) { fail('write_representation','write',result.status); return; }
  assertionsPassed.add(1);
}
const operations = {read,rls,panel,storage,login,refresh,write};
function rejectInvalidCredential() {
  if ((__ITER + __VU) % (fleet ? 10 : 1000) !== 0) { return; }
  const result = http.get(base + '/rest/v1/bench_private?limit=1', { headers: { Authorization: 'Bearer ' + fixture.invalid_access }, responseType: 'none', timeout: '5s', tags: { workload: 'security' } });
  if (result.status !== 401 || ![0,1401].includes(result.error_code)) { fail('invalid_credential_response', 'security', result.status); }
  assertionsPassed.add(1);
  expectedRejections.add(1);
}
export default function runCurrent(data) {
  hydrateSession(data);
  rejectInvalidCredential();
  if (fleet && (__ITER + __VU) % 10 === 0 && projects.length > 1) {
    const foreign = projects[(projectIndex+1)%projects.length];
    const result = http.get(base+'/rest/v1/bench_products?limit=1',{headers:{Authorization:'Bearer '+foreign.service},responseType:'none',timeout:'5s',tags:{workload:'cross-project'}});
    if (result.status !== 401 || ![0,1401].includes(result.error_code)) { fail('foreign_credential_response', 'cross-project', result.status); }
    assertionsPassed.add(1); expectedRejections.add(1);
  }
  if (fleet && projectIndex === 0 && __ENV.HOT_WORKLOAD && __ENV.HOT_WORKLOAD !== 'mixed') { operations[__ENV.HOT_WORKLOAD](); return; }
  if (kind !== 'mixed') {
    operations[kind]();
    return;
  }
  // A global arrival cycle: 50% read, 20% RLS, 10% panel, 5% storage,
  // 5% hashing, 5% rotation and 5% signed webhook-producing writes.
  const step = execution.scenario.iterationInTest % 20;
  if (step < 10) { read(); return; }
  if (step < 14) { rls(); return; }
  if (step < 16) { panel(); return; }
  if (step === 16) { storage(); return; }
  if (step === 17) { login(); return; }
  if (step === 18) { refresh(); return; }
  write();
}

function selectProject(index) {
  if (!projects[index]) { fail(); return; }
  if (projectIndex !== index) {
    projectIndex = index; fixture = projects[index]; base = fixture.base;
    refreshToken = undefined; accessToken = undefined; accessExpiresAt = 0;
  }
  execution.vu.metrics.tags.project = fixture.label;
}
export function project0(data) { selectProject(0); runCurrent(data); }
export function project1(data) { selectProject(1); runCurrent(data); }
export function project2(data) { selectProject(2); runCurrent(data); }
export function project3(data) { selectProject(3); runCurrent(data); }
export function project4(data) { selectProject(4); runCurrent(data); }
export function project5(data) { selectProject(5); runCurrent(data); }
export function project6(data) { selectProject(6); runCurrent(data); }
export function project7(data) { selectProject(7); runCurrent(data); }
export function project8(data) { selectProject(8); runCurrent(data); }
export function project9(data) { selectProject(9); runCurrent(data); }

export function sessionProbe(data) { hydrateSession(data); rejectInvalidCredential(); rls(); sleep(1); }
