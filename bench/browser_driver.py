"""Live Chromium panel/SDK probes; run only inside its owned staging container."""
import asyncio
from collections import Counter, deque
import json
import math
import os
import re
import runpy
from pathlib import Path
import time
import urllib.parse

from playwright.async_api import async_playwright, Error


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def save(path, value):
    temporary = path.with_suffix('.writing')
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False)+'\n')
    temporary.replace(path)


async def main():
    fixture = json.loads(Path('/fixture.json').read_text())
    output = Path('/evidence')
    base = fixture['base']
    origin = urllib.parse.urlsplit(base)
    require(origin.scheme == 'https' and origin.hostname == 'localhost', 'browser_requires_owned_verified_local_HTTPS')
    require(Path.home() == Path('/home/ubuntu'), 'unexpected_container_home')
    require(900 <= fixture['session_seconds'] <= 1500, 'invalid_browser_session_budget')
    state = {'phase':'startup', 'api_requests':0, 'decoded_network_bytes':0,
             'external_requests_blocked':0, 'page_errors':0}
    paths, grants, consumers, uploads = Counter(), Counter(), Counter(), Counter()
    raw_auth_requests = Counter()
    arrivals = deque()
    def fatal(reason):
        save(output/'browser-critical.json', {'reason':reason, **state})
        os._exit(77)  # PID 1 exit also stops its private PID namespace children.
    def request_seen(request):
        parsed = urllib.parse.urlsplit(request.url)
        if (parsed.scheme, parsed.netloc) != (origin.scheme, origin.netloc):
            fatal('unexpected_browser_request_origin')
        if parsed.path.startswith('/admin/api/') or parsed.path.startswith('/auth/') or parsed.path.startswith('/rest/'):
            state['api_requests'] += 1
            paths[parsed.path] += 1
            now = time.monotonic()
            arrivals.append(now)
            while arrivals and arrivals[0] < now-1:
                arrivals.popleft()
            if state['api_requests'] > 12000 or len(arrivals) > 64:
                fatal('browser_request_budget')
        if parsed.path == '/auth/v1/token':
            grant = urllib.parse.parse_qs(parsed.query).get('grant_type', ['unknown'])[0]
            if grant not in ('password', 'refresh_token'):
                fatal('unexpected_browser_auth_grant')
            grants[grant] += 1
        raw_cycle = request.headers.get('x-g05-auth-pressure')
        if raw_cycle is not None:
            if raw_cycle not in {'0', '1', '2', '3', '4'} or not fixture.get('auth_pressure'):
                fatal('invalid_raw_auth_pressure_marker')
            raw_auth_requests[raw_cycle] += 1
            if raw_auth_requests[raw_cycle] > 112:
                fatal('raw_auth_pressure_request_ceiling')
    def received(event):
        size = event.get('dataLength')
        if isinstance(size, bool) or not isinstance(size, (int, float)) or not math.isfinite(size) or size < 0:
            fatal('invalid_browser_network_evidence')
        state['decoded_network_bytes'] += size
        if state['decoded_network_bytes'] > 128*1024*1024:
            fatal('browser_traffic_byte_budget')
    def response_seen(response):
        parsed = urllib.parse.urlsplit(response.url)
        if parsed.path == '/admin/api/storage/buckets/bench/upload':
            replacing = urllib.parse.parse_qs(parsed.query).get('replace', ['false'])[0]
            uploads[str(response.status)+'-'+replacing] += 1
        if parsed.path.startswith(('/auth/', '/rest/')):
            upstream = response.headers.get('x-g05-upstream')
            if upstream not in fixture['upstreams']:
                fatal('missing_auth_consumer_evidence')
            consumers[str(fixture['upstreams'].index(upstream))] += 1
    async def route(request):
        parsed = urllib.parse.urlsplit(request.request.url)
        if (parsed.scheme, parsed.netloc) != (origin.scheme, origin.netloc):
            state['external_requests_blocked'] += 1
            await request.abort('blockedbyclient')
            return
        if parsed.path.startswith('/g05-sdk/'):
            path = (Path('/runtime/sdk')/parsed.path.removeprefix('/g05-sdk/')).resolve()
            if not path.is_relative_to('/runtime/sdk') or not path.is_file() or path.suffix != '.js' or path.stat().st_size > 2*1024*1024:
                fatal('invalid_owned_SDK_asset')
            await request.fulfill(path=str(path), content_type='text/javascript')
            return
        await request.continue_()
    async def navigate(page, table, marker):
        start = await page.evaluate('performance.now()')
        await page.bring_to_front()
        require(await page.evaluate('document.visibilityState==="visible"'), 'visual_feedback_requires_foreground_tab')
        await page.evaluate('(table) => {history.pushState(null,"","/admin/tables/"+table); dispatchEvent(new PopStateEvent("popstate"));}', table)
        await page.wait_for_function('(marker) => document.querySelector(\'[data-cell="0:1"]\')?.textContent?.includes(marker)', arg=marker, timeout=10000)
        await page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        elapsed = await page.evaluate('performance.now()')-start
        require(math.isfinite(elapsed) and elapsed > 0, 'invalid_visual_feedback_evidence')
        return elapsed
    async def sdk_read(page):
        value = await page.evaluate('''async ({user,body}) => {
          const result=await window.g05Client.from('bench_private').select('id,user_id,body').order('id').limit(20);
          return !result.error && Array.isArray(result.data) && result.data.length===20 && result.data.every((row,index)=>row.id===2*(index+1)&&row.user_id===user&&row.body===body);
        }''', {'user':fixture['user'], 'body':fixture['label']})
        require(value, 'live_browser_SDK_RLS_oracle')
    plateaus, timings = [], []
    auth_jobs, auth_pressure, auth_measurements = set(), [], set()
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path='/runtime/chrome/chromium', headless=True,
            chromium_sandbox=False, args=['--disable-gpu', '--disable-background-networking', '--no-first-run'])
        try:
            context = await browser.new_context(locale='pt-BR', ignore_https_errors=False, service_workers='block', viewport={'width':1440, 'height':900})
            await context.route('**/*', route)
            page = await context.new_page()
            profilers = []
            async def instrument(page):
                profiler = await context.new_cdp_session(page)
                await profiler.send('Network.enable')
                profiler.on('Network.dataReceived', received)
                profilers.append(profiler)
            await instrument(page)
            if fixture.get('untrusted_control'):
                try:
                    await page.goto(base+'/admin/', timeout=15000)
                except Error as error:
                    require('ERR_CERT_AUTHORITY_INVALID' in str(error), 'untrusted_browser_TLS_wrong_rejection')
                    save(output/'browser-result.json', {'status':'passed', 'scope':'untrusted CA negative control only', 'untrusted_CA_rejected':True})
                    await context.close()
                    return
                raise RuntimeError('untrusted_browser_CA_accepted')
            context.on('request', request_seen)
            context.on('response', response_seen)
            def page_error(_):
                state['page_errors'] += 1
            context.on('page', lambda page: page.on('pageerror', page_error))
            page.on('pageerror', page_error)
            state['phase'] = 'live-panel-login'
            await page.goto(base+'/admin/tables/bench_products', timeout=15000)
            await page.get_by_label('Email', exact=True).fill(fixture['admin_email'])
            await page.get_by_label('Senha', exact=True).fill(fixture['password'])
            await page.get_by_role('button', name='Entrar', exact=True).click()
            await page.wait_for_function('() => document.querySelector(\'[data-cell="0:1"]\')?.textContent?.includes("project-0:")', timeout=15000)
            pages = [page, await context.new_page(), await context.new_page()]
            for page in pages[1:]:
                await instrument(page)
                await page.goto(base+'/admin/tables/bench_products', timeout=15000)
            for page in pages:
                await page.evaluate('''async ({base,key}) => {
                  const sdk=await import('/g05-sdk/index.js'); window.g05SDK=sdk;
                  window.g05Client=sdk.createClient(base,{retries:2,auth:{storageKey:key}});
                }''', {'base':base, 'key':fixture['storage_key']})
            signin = await pages[0].evaluate('''async ({email,password,user}) => {
              const value=await window.g05Client.auth.signInWithPassword({email,password});
              return {valid:!value.error&&value.data?.user?.id===user,expires:value.data?.expires_in};
            }''', {key:fixture[key] for key in ['email', 'password', 'user']})
            require(signin['valid'] and not isinstance(signin['expires'], bool) and isinstance(signin['expires'], int) and 0 < signin['expires'] <= fixture['session_seconds']-120, 'actual_auth_TTL_exceeds_browser_profile')
            await asyncio.sleep(.5)
            for page in pages:
                await sdk_read(page)
            delayed = []
            async def hold_actual_response(pattern, action, continuation):
                """Pause verified real response headers, never substitute a body.

                CDP pauses after the server has replied through trusted HTTPS.
                The browser can cancel that real response while a new view or
                caller completes. Only that explicit cancellation may make its
                continuation fail. All pauses have an independent short expiry.
                """
                profiler = profilers[0]
                seen, release, finished = asyncio.Event(), asyncio.Event(), asyncio.Event()
                observation = {'server_status':None, 'cancelled':False, 'continued':False, 'error':False}
                network_id = None
                def failed(event):
                    if event.get('requestId')==network_id and event.get('canceled') is True:
                        observation['cancelled'] = True
                async def paused(event):
                    nonlocal network_id
                    if seen.is_set():
                        observation['error'] = True
                        await profiler.send('Fetch.continueResponse', {'requestId':event['requestId']})
                        return
                    observation['server_status'] = event.get('responseStatusCode')
                    network_id = event.get('networkId')
                    seen.set()
                    try:
                        await asyncio.wait_for(release.wait(), timeout=5)
                        await profiler.send('Fetch.continueResponse', {'requestId':event['requestId']})
                        observation['continued'] = True
                    except Error:
                        await asyncio.sleep(.1)
                        if not observation['cancelled']:
                            observation['error'] = True
                    except TimeoutError:
                        observation['error'] = True
                    finally:
                        finished.set()
                profiler.on('Network.loadingFailed', failed)
                profiler.on('Fetch.requestPaused', paused)
                await profiler.send('Fetch.enable', {'patterns':[{'urlPattern':pattern, 'requestStage':'Response'}]})
                try:
                    await action()
                    await asyncio.wait_for(seen.wait(), timeout=10)
                    require(observation['server_status']==200, 'delayed_real_response_not_successful')
                    await continuation()
                    release.set()
                    await asyncio.wait_for(finished.wait(), timeout=5)
                    require(not observation['error'] and (observation['continued'] or observation['cancelled']), 'real_response_pause_did_not_retire')
                    delayed.append(observation)
                finally:
                    release.set()
                    await profiler.send('Fetch.disable')
                    profiler.remove_listener('Network.loadingFailed', failed)
                    profiler.remove_listener('Fetch.requestPaused', paused)
            before = grants['refresh_token']
            state['phase'] = 'simultaneous-SDK-refresh'
            refresh_callers = [0, 0, 0]
            overlap = {'held':0, 'pending':0}
            begin_refresh = r"""() => {
              const requests=Array.from({length:16},()=>window.g05Client.auth.refreshSession());
              window.g05OverlappingRefresh=Promise.all(requests).then(async values=>{
                const token=values[0]?.data?.access_token;
                if(!token||values.some(value=>value.error||value.data?.access_token!==token))return null;
                const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
                return Array.from(new Uint8Array(digest)).map(value=>value.toString(16).padStart(2,'0')).join('');
              });
              return requests.length;
            }"""
            async def first_refresh():
                refresh_callers[0] = await pages[0].evaluate(begin_refresh)
            async def late_refreshes():
                for index in [1,2]:
                    refresh_callers[index] = await pages[index].evaluate(begin_refresh)
                overlap.update(await pages[0].evaluate(r"""async name => {
                  const state=await navigator.locks.query();
                  return {held:state.held.filter(value=>value.name===name).length,
                          pending:state.pending.filter(value=>value.name===name).length};
                }""", fixture['storage_key']+'.refresh'))
                require(refresh_callers==[16,16,16] and overlap['held']==1 and overlap['pending']>=2,
                        'cross_tab_refresh_overlap_not_established')
            # Hold the first real HTTPS response, not a mock. Later callers
            # must enter before it completes; task delivery alone is no barrier.
            await hold_actual_response(base+'/auth/v1/token?grant_type=refresh_token', first_refresh, late_refreshes)
            refreshed = await asyncio.gather(*[page.evaluate(r"""async () => {
              const pending=window.g05OverlappingRefresh;delete window.g05OverlappingRefresh;
              return await pending;
            }""") for page in pages])
            save(output/'browser-auth-controls.json', {
                'simultaneous_refresh_callers':sum(refresh_callers),
                'actual_refresh_requests':grants['refresh_token']-before,
                'shared_access_token_digest_matches':len(set(refreshed))==1,
                'all_tabs_returned_session':bool(all(refreshed)),
                'callers_started_per_tab':refresh_callers,
                'first_real_response_held_until_late_callers_started':True,
                'held_refresh_locks':overlap['held'], 'queued_refresh_locks':overlap['pending'],
                'real_auth_consumers':dict(consumers)})
            require(refreshed[0] and len(set(refreshed)) == 1 and grants['refresh_token']-before == 1, 'cross_tab_refresh_did_not_coalesce')
            auth_started = time.monotonic()
            initial = await pages[0].evaluate(r"""async () => {const value=await window.g05Client.auth.getSession();window.g05InitialAccess=value.data?.access_token;return !value.error&&Boolean(window.g05InitialAccess);} """)
            require(initial, 'browser_SDK_session_missing')
            state['phase'] = 'offline-and-reconnect'
            rest_path = '/rest/v1/bench_private'
            before_offline = paths[rest_path]
            try:
                await context.set_offline(True)
                disconnected = await pages[0].evaluate('''async () => {
                  const result=await window.g05Client.from('bench_private').select('id').limit(1).timeout(3000);
                  return {code:result.error?.code,hasData:result.data!==null};
                }''')
                await asyncio.sleep(1)
                offline_attempts = paths[rest_path]-before_offline
                save(output/'browser-offline-read.json', {'actual_attempts':offline_attempts, 'maximum_attempts':3, 'configured_additional_read_retries':2, 'code':disconnected['code'], 'has_data':disconnected['hasData']})
                require(disconnected['code']=='network_error' and not disconnected['hasData'], 'offline_SDK_reported_success')
                require(offline_attempts==3, 'offline_SDK_exceeded_or_missed_declared_read_retry_contract')
                before_mutation = paths[rest_path]
                offline_mutation = await pages[0].evaluate('''async ({user}) => {
                  const result=await window.g05Client.from('bench_private').insert({id:-1,user_id:user,body:'owned-offline-canary'}).timeout(3000);
                  return {code:result.error?.code,hasData:result.data!==null};
                }''', {'user':fixture['user']})
                await asyncio.sleep(1)
                offline_mutation_attempts = paths[rest_path]-before_mutation
                require(offline_mutation['code']=='network_error' and not offline_mutation['hasData'] and offline_mutation_attempts==1, 'offline_SDK_mutation_retry_or_false_success')
            finally:
                await context.set_offline(False)
            for page in pages:
                await sdk_read(page)
                await navigate(page, 'bench_alternate', 'alternate:')
                await navigate(page, 'bench_products', 'project-0:')
            require(await pages[0].evaluate('''async () => {const result=await window.g05Client.from('bench_private').select('id').eq('id',-1);return !result.error&&Array.isArray(result.data)&&result.data.length===0;}'''), 'offline_mutation_was_committed_or_replayed')
            state['phase'] = 'real-response-cancellation'
            async def old_navigation():
                await pages[0].evaluate('''() => {history.pushState(null,'','/admin/tables/bench_alternate');dispatchEvent(new PopStateEvent('popstate'));}''')
            async def new_navigation():
                await navigate(pages[0], 'bench_products', 'project-0:')
            await hold_actual_response(base+'/admin/api/tables/bench_alternate?*', old_navigation, new_navigation)
            await asyncio.sleep(.25)
            require(await pages[0].evaluate('''() => location.pathname==='/admin/tables/bench_products' && document.querySelector('[data-cell="0:1"]')?.textContent?.includes('project-0:')'''), 'late_real_response_overwrote_new_view')
            async def cancellable_read():
                await pages[0].evaluate('''() => {
                  window.g05Abort=new AbortController();
                  window.g05AbortResult=Promise.resolve(window.g05Client.from('bench_private').select('id').limit(1).abortSignal(window.g05Abort.signal));
                }''')
            async def abort_read():
                began = time.monotonic()
                outcome = await pages[0].evaluate('''async () => {window.g05Abort.abort();const value=await window.g05AbortResult;return {code:value.error?.code,hasData:value.data!==null};}''')
                require(outcome['code']=='aborted' and not outcome['hasData'] and time.monotonic()-began < 1, 'live_SDK_cancellation_not_prompt')
            await hold_actual_response(base+'/rest/v1/bench_private?*', cancellable_read, abort_read)
            await sdk_read(pages[0])
            state['phase'] = 'real-upload-conflict-ownership'
            await pages[0].evaluate('''() => {history.pushState(null,'','/admin/storage/bench');dispatchEvent(new PopStateEvent('popstate'));}''')
            dropzone = pages[0].get_by_role('button', name='Arraste arquivos para cá ou clique para selecionar', exact=True)
            await dropzone.wait_for()
            for action in ['Cancelar', 'Substituir']:
                for cycle in range(3):
                    before_upload = sum(uploads.values())
                    files = await pages[0].evaluate_handle('''() => {
                      const data=new DataTransfer();
                      const file=new File(['g05-stress-file\\n'+'x'.repeat(1048576-16)],'fixture.txt',{type:'text/plain'});
                      window.g05File=new WeakRef(file);data.items.add(file);return data;
                    }''')
                    try:
                        await dropzone.dispatch_event('drop', {'dataTransfer':files})
                    finally:
                        await files.dispose()
                    dialog = pages[0].get_by_role('alertdialog')
                    await dialog.wait_for()
                    require(await pages[0].evaluate('window.g05File.deref()!==undefined'), 'live_conflict_did_not_own_its_File')
                    await dialog.get_by_role('button', name=action, exact=True).click()
                    await dialog.wait_for(state='hidden')
                    collect_deadline = time.monotonic()+10
                    collected = False
                    while time.monotonic() < collect_deadline:
                        await profilers[0].send('HeapProfiler.collectGarbage')
                        collected = await pages[0].evaluate('window.g05File.deref()===undefined')
                        if collected:
                            break
                        await asyncio.sleep(.2)
                    require(collected and sum(uploads.values())>before_upload, 'real_upload_File_owner_not_released')
            require(dict(uploads)=={'409-false':6, '200-true':3}, 'real_upload_conflict_or_replace_HTTP_contract')
            file_integrity = await pages[0].evaluate('''async () => {
              const response=await fetch('/admin/api/storage/buckets/bench/file?name=fixture.txt');
              const bytes=await response.arrayBuffer();const text=new TextDecoder().decode(bytes);
              const valid=response.status===200&&bytes.byteLength===1048576&&text==='g05-stress-file\\n'+'x'.repeat(1048576-16);
              const digest=await crypto.subtle.digest('SHA-256',bytes);
              return {valid,size:bytes.byteLength,sha256:Array.from(new Uint8Array(digest)).map(value=>value.toString(16).padStart(2,'0')).join('')};
            }''')
            require(file_integrity['valid'], 'real_browser_uploaded_bytes_corrupt')
            state['phase'] = 'real-file-preview-lifetimes'
            preview_seconds = []
            for cycle in range(5):
                preview_began = time.monotonic()
                await pages[0].get_by_role('button', name='fixture.txt', exact=True).click()
                dialog = pages[0].get_by_role('dialog')
                await dialog.wait_for()
                await pages[0].wait_for_function('''() => document.querySelector('[role="dialog"] pre')?.textContent?.startsWith('g05-stress-file')''', timeout=10000)
                preview_seconds.append(time.monotonic()-preview_began)
                await pages[0].keyboard.press('Escape')
                await dialog.wait_for(state='hidden')
            await navigate(pages[0], 'bench_products', 'project-0:')
            async def sample(label):
                values = []
                for profiler in profilers:
                    await profiler.send('HeapProfiler.collectGarbage')
                    dom = await profiler.send('Memory.getDOMCounters')
                    heap = await profiler.send('Runtime.getHeapUsage')
                    counters = {'documents':dom['documents'], 'nodes':dom['nodes'], 'listeners':dom['jsEventListeners'], 'heap_bytes':heap['usedSize']}
                    require(all(not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and value >= 0 for value in counters.values()), 'invalid_browser_owner_evidence')
                    require(counters['documents'] > 0 and counters['nodes'] > 0 and 0 < counters['heap_bytes'] <= 512*1024*1024, 'browser_page_heap_budget')
                    values.append(counters)
                result = {'phase':label, 'seconds_since_auth':time.monotonic()-auth_started, 'pages':values}
                plateaus.append(result)
                save(output/'browser-plateaus.json', plateaus)
            for page in pages:
                await navigate(page, 'bench_alternate', 'alternate:')
                await navigate(page, 'bench_products', 'project-0:')
            if fixture.get('auth_pressure') is True:
                measure_auth = runpy.run_path('/auth-evidence.py')['measurement']
                def record_auth_measurement(value):
                    require(isinstance(value,dict), 'invalid_auth_measurement')
                    index = value.get('cycle')
                    require(type(index) is int and 0<=index<5, 'invalid_auth_measurement_cycle')
                    require(index not in auth_measurements and state['phase']=='navigation-pressure-'+str(index+1),
                            'duplicate_or_out_of_phase_auth_measurement')
                    proof = measure_auth({**value, 'independent_browser_request_count':raw_auth_requests[str(index)]}, index)
                    save(output/'browser-auth-measurement.json', proof)
                    auth_measurements.add(index)
                await pages[0].expose_function('g05RecordAuthMeasurement', record_auth_measurement)
            await sample('baseline')
            for cycle in range(5):
                state['phase'] = 'navigation-pressure-'+str(cycle+1)
                auth_job = None
                if fixture.get('auth_pressure') is True:
                    auth_job = asyncio.create_task(pages[0].evaluate(Path('/auth-pressure.js').read_text(), {'password':fixture['password'], 'cycle':cycle}))
                    auth_jobs.add(auth_job)
                    def auth_finished(task):
                        if task.cancelled():
                            return
                        error = task.exception()
                        if error is not None:
                            code = re.search(r'g05_auth_[a-z0-9_]{1,80}', str(error))
                            reason = 'backend_auth_pressure_failed'
                            if code is not None:
                                reason = code.group(0)
                            fatal(reason)
                    auth_job.add_done_callback(auth_finished)
                deadline = time.monotonic()+30
                count = 0
                while time.monotonic() < deadline:
                    started = time.monotonic()
                    page = pages[count%3]
                    table, marker = 'bench_products', 'project-0:'
                    if urllib.parse.urlsplit(page.url).path == '/admin/tables/bench_products':
                        table, marker = 'bench_alternate', 'alternate:'
                    timings.append(await navigate(page, table, marker))
                    require(not state['page_errors'], 'live_panel_page_error')
                    count += 1
                    await asyncio.sleep(max(0,.1-(time.monotonic()-started)))
                for page in pages:
                    await page.evaluate('''async ({base,key}) => {
                      window.g05Disposed=[];
                      for(let index=0;index<20;index++){const client=window.g05SDK.createClient(base,{auth:{storageKey:key}});await client.auth.getSession();client.dispose();window.g05Disposed.push(new WeakRef(client));}
                    }''', {'base':base, 'key':fixture['storage_key']})
                if auth_job is not None:
                    proof = await asyncio.wait_for(auth_job, timeout=45)
                    require(proof['status']=='passed' and proof['requests_completed']==112, 'backend_auth_pressure_incomplete')
                    require(raw_auth_requests[str(cycle)]==112, 'backend_auth_pressure_wire_accounting')
                    require(cycle in auth_measurements, 'backend_auth_pressure_measurement_missing')
                    proof['independent_browser_request_count'] = raw_auth_requests[str(cycle)]
                    auth_pressure.append(proof)
                    auth_jobs.discard(auth_job)
                    save(output/'browser-auth-pressure.json', {'status':'in progress', 'cycles':auth_pressure})
                await asyncio.sleep(15)
                await sample('navigation-rest-'+str(cycle+1))
                for page in pages:
                    require(await page.evaluate('window.g05Disposed.length===20&&window.g05Disposed.every(value=>value.deref()===undefined)'), 'disposed_SDK_client_retained')
                save(output/'browser-checkpoint.json', {**state, 'completed_cycles':cycle+1})
            timings.sort()
            p95 = timings[max(0,math.ceil(len(timings)*.95)-1)]
            save(output/'browser-feedback.json', {'samples':len(timings), 'p95_ms':p95, 'SLO_ms':1000, 'foreground_tabs_required':True, 'passed':p95<=1000})
            require(p95<=1000, 'browser_visual_feedback_SLO')
            state['phase'] = 'real-credential-expiry'
            renewals = grants['refresh_token']
            reads = 0
            while time.monotonic()-auth_started < fixture['session_seconds']:
                started = time.monotonic()
                for page in pages:
                    await sdk_read(page)
                    reads += 1
                require(not state['page_errors'], 'live_panel_page_error')
                save(output/'browser-checkpoint.json', {**state, 'sdk_RLS_reads':reads, 'seconds_since_auth':time.monotonic()-auth_started, 'refresh_requests':grants['refresh_token']})
                await asyncio.sleep(max(0,1-(time.monotonic()-started)))
            require(grants['refresh_token'] > renewals, 'no_actual_browser_credential_renewal')
            require(set(consumers) == {'0', '1'}, 'both_real_auth_consumers_not_observed')
            expired = await pages[0].evaluate('''async () => {
              const response=await fetch('/rest/v1/bench_private?limit=1',{headers:{Authorization:'Bearer '+window.g05InitialAccess}});
              return response.status;
            }''')
            require(expired == 401, 'actually_expired_access_not_rejected')
            state['phase'] = 'shared-SDK-signout'
            signed_out = await pages[0].evaluate('''async () => {const current=await window.g05Client.auth.getSession();if(current.error||!current.data)return false;window.g05Last=current.data;const value=await window.g05Client.auth.signOut();return !value.error;}''')
            require(signed_out, 'browser_signout_failed')
            await asyncio.sleep(1)
            for page in pages:
                require(await page.evaluate('(async ()=>{const value=await window.g05Client.auth.getSession();return !value.error&&value.data===null;})()'), 'cross_tab_logout_state_retained')
            revoked = await pages[0].evaluate('''async () => {
              const response=await fetch('/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refresh_token:window.g05Last.refresh_token})});
              return response.status;
            }''')
            require(revoked == 400, 'logout_did_not_revoke_refresh')
            for page in pages:
                await page.evaluate('window.g05Client.dispose()')
            await sample('final-disposed')
            for index in range(3):
                baseline = plateaus[0]['pages'][index]
                final = plateaus[-1]['pages'][index]
                require(final['heap_bytes'] <= baseline['heap_bytes']+8*1024*1024, 'browser_heap_growth_budget')
                require(final['nodes'] <= baseline['nodes']+250 and final['listeners'] <= baseline['listeners']+32, 'browser_owner_growth_budget')
            require(p95 <= 1000 and not state['external_requests_blocked'] and not state['page_errors'], 'browser_visual_or_external_traffic_gate')
            result = {'status':'passed', 'scope':'real local HTTPS panel and built TypeScript SDK, not public WAN capacity',
                      'browser_version':browser.version, 'tabs':3, 'pressure_rest_cycles':5, 'navigation_samples':len(timings),
                      'temporary_clients_checked_per_tab_per_cycle':20, 'navigation_requires_different_table':True,
                      'authoritative_visual_feedback_p95_ms':p95, 'feedback_SLO_ms':1000, 'api_requests':state['api_requests'],
                      'decoded_network_bytes':state['decoded_network_bytes'], 'auth_grants':dict(grants), 'auth_consumers':dict(consumers),
                      'auth_pressure':auth_pressure, 'auth_measurement_cycles':sorted(auth_measurements),
                      'sdk_RLS_reads':reads, 'cross_tab_refresh_coalesced':True, 'actual_credential_renewal':True,
                      'offline_reconnect':True, 'offline_read_error':disconnected['code'],
                      'offline_read_attempts':offline_attempts, 'configured_additional_read_retries':2,
                      'offline_mutation_attempts':offline_mutation_attempts, 'offline_mutation_not_replayed':True,
                      'actual_server_response_controls':delayed, 'late_response_view_preserved':True, 'inflight_SDK_cancellation':True,
                      'upload_conflict_File_ownership_cycles':6, 'real_upload_HTTP_status_counts':dict(uploads),
                      'uploaded_file_integrity':file_integrity, 'real_file_preview_cycles':5,
                      'file_preview_completion_seconds':preview_seconds,
                      'actual_expired_access_status':expired,
                      'actual_expires_in_seconds':signin['expires'], 'auth_observation_seconds':time.monotonic()-auth_started,
                      'logout_refresh_status':revoked, 'access_logout_contract':'Existing access remains valid until its expiry; no immediate access revocation claim',
                      'disposed_clients_collected':True, 'external_requests_blocked':state['external_requests_blocked'], 'page_errors':state['page_errors']}
            for profiler in profilers:
                await profiler.detach()
            await context.close()
            if fixture.get('auth_pressure') is True:
                require(len(auth_pressure)==5, 'backend_auth_pressure_missing_cycles')
                save(output/'browser-auth-pressure.json', {'status':'passed', 'cycles':auth_pressure})
            save(output/'browser-result.json', result)
        finally:
            for job in auth_jobs:
                job.cancel()
            await asyncio.gather(*auth_jobs, return_exceptions=True)
            await browser.close()


if __name__ == '__main__':
    output = Path('/evidence')
    (output/'driver-ready').touch()
    start_deadline = time.monotonic()+30
    while not (output/'driver-start').exists():
        if time.monotonic() > start_deadline:
            raise RuntimeError('Browser owner did not arm the traffic start gate')
        time.sleep(.1)
    try:
        asyncio.run(main())
    except Exception as error:
        save(output/'browser-error.json', {'type':type(error).__name__})
        raise
    (output/'driver-finished').touch()
    deadline = time.monotonic()+30
    while not (output/'driver-release').exists():
        if time.monotonic() > deadline:
            raise RuntimeError('Browser completion was not acknowledged by its owner')
        time.sleep(.1)
