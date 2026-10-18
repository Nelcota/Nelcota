"""Strict numeric publication oracle for concurrent browser/backend auth."""
import math
import re

CHECKPOINTS = {'runtime-prepare', 'source-create', 'source-restart', 'consumer-start',
               'fixture-schema', 'proxy-start', 'proxy-reconfigure', 'profile-complete',
               'untrusted-browser', 'live-browser', 'auth-census', 'final-resource-check', 'done'}
FAILURE_KINDS = {'other', 'native-dependency-closure', 'runtime-dependency-root',
                 'ambiguous-library-name', 'python-dependency-missing',
                 'browser-or-sdk-missing', 'proxy-configuration', 'app-readiness', 'docker-operation'}


def failure_receipt(checkpoint, error):
    """Classify fixed preparation failures without publishing exception payloads."""
    require(isinstance(checkpoint,str) and checkpoint in CHECKPOINTS, 'Unknown browser failure checkpoint')
    category = 'other'
    text = str(error)
    fixed = {'Unexpected resolved browser runtime dependency path':'runtime-dependency-root',
             'Ambiguous browser runtime library names':'ambiguous-library-name',
             'A required installed browser dependency is missing':'python-dependency-missing',
             'Native Chromium and freshly built SDK are required':'browser-or-sdk-missing',
             'Unexpected owned proxy configuration':'proxy-configuration'}
    category = fixed.get(text, category)
    component = re.fullmatch(r'Native browser dependency closure is incomplete: ([A-Za-z0-9_.+-]{1,128})', text)
    if component is not None:
        category = 'native-dependency-closure'
    if re.fullmatch(r'Owned project listener did not become ready: project-[01]', text):
        category = 'app-readiness'
    if text.startswith('Docker operation failed: '):
        category = 'docker-operation'
    kind = 'Exception'
    for cls in [OSError, ValueError, RuntimeError]:
        if isinstance(error, cls):
            kind = cls.__name__
            break
    result = {'checkpoint':checkpoint, 'type':kind, 'kind':category}
    if component is not None:
        result['component'] = component[1]
    return validate_failure_receipt(result)


def validate_failure_receipt(value):
    require(isinstance(value,dict) and set(value) in [
        {'checkpoint','type','kind'}, {'checkpoint','type','kind','component'}], 'Unknown browser failure fields')
    require(all(isinstance(value[key],str) for key in ['checkpoint','type','kind'])
            and value['checkpoint'] in CHECKPOINTS and value['type'] in {'Exception','OSError','ValueError','RuntimeError'}
            and value['kind'] in FAILURE_KINDS, 'Invalid fixed browser failure category')
    if 'component' in value:
        require(value['kind']=='native-dependency-closure' and isinstance(value['component'],str)
                and re.fullmatch(r'[A-Za-z0-9_.+-]{1,128}',value['component']) is not None,
                'Invalid bounded browser dependency name')
    return dict(value)

PROFILE = {'cycles':5, 'accounts_per_cycle':8, 'requests_per_cycle':112,
           'maximum_inflight':8, 'maximum_arrivals_per_second':16,
           'maximum_response_bytes':65536, 'maximum_cycle_seconds':40,
           'mutation_retries':0, 'login_p95_ms':750, 'login_p99_ms':1500,
           'read_refresh_p95_ms':200, 'read_refresh_p99_ms':500,
           'scope':'Concurrent with existing navigation pressure, two real auth consumers, verified owned HTTPS. SMTP/OAuth and public ingress remain separate.'}
COUNTS = {'signup':8, 'login':8, 'invalid_password':8, 'user':8, 'rls':16,
          'refresh':32, 'reuse_rejected':8, 'family_revoked':8, 'logout':8,
          'logout_refresh_rejected':8}
SUCCESS = {name:COUNTS[name] for name in ['signup','login','user','rls','refresh','logout']}
SLOS = {'login':(750,1500), 'refresh':(200,500), 'user':(200,500), 'rls':(200,500)}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def finite(value):
    return type(value) in {int,float} and math.isfinite(value)


def _measurement(value, index, status):
    require(isinstance(value,dict) and value.get('status')==status and type(value.get('cycle')) is int
            and value['cycle']==index and 0<=index<5, 'Missing successful auth pressure cycle')
    for key in ['requests_attempted','requests_completed','independent_browser_request_count']:
        require(type(value.get(key)) is int and value[key]==112, 'Auth pressure request census differs')
    require(type(value.get('maximum_inflight')) is int and 1<=value['maximum_inflight']<=8
            and type(value.get('maximum_arrivals_per_second')) is int and 1<=value['maximum_arrivals_per_second']<=16,
            'Auth pressure exceeded its admission/arrival boundary')
    require(type(value.get('accounts_created')) is int and value['accounts_created']==8
            and type(value.get('mutation_retries')) is int and value['mutation_retries']==0,
            'Auth fixture/mutation accounting changed')
    require(finite(value.get('elapsed_seconds')) and 0<value['elapsed_seconds']<40,
            'Auth pressure exceeded its monotonic cycle deadline')
    require(type(value.get('response_bytes_consumed')) is int and 0<value['response_bytes_consumed']<=112*65536,
            'Invalid auth pressure response-byte accounting')
    counts=value.get('counts')
    require(isinstance(counts,dict) and set(counts)==set(COUNTS)
            and all(type(counts[name]) is int and counts[name]==expected for name,expected in COUNTS.items()),
            'Auth expected positive/rejection denominators differ')
    latencies=value.get('successful_latency')
    require(isinstance(latencies,dict) and set(latencies)==set(SUCCESS), 'Missing successful-only auth latency classes')
    for name,expected in SUCCESS.items():
        row=latencies[name]
        require(isinstance(row,dict) and set(row)=={'samples','p50_ms','p95_ms','p99_ms'}
                and type(row['samples']) is int and row['samples']==expected
                and all(finite(row[key]) for key in ['p50_ms','p95_ms','p99_ms'])
                and 0<row['p50_ms']<=row['p95_ms']<=row['p99_ms']<=value['elapsed_seconds']*1000,
                'Invalid successful auth latency evidence')
    fields=['cycle','status','requests_attempted','requests_completed','independent_browser_request_count',
            'maximum_inflight','maximum_arrivals_per_second','accounts_created','counts',
            'successful_latency','elapsed_seconds','response_bytes_consumed','mutation_retries']
    return {key:value[key] for key in fields}


def measurement(value, index):
    """Retain complete numeric observations before the browser asserts its SLOs."""
    return _measurement(value, index, 'measured')


def cycle(value, index):
    result = _measurement(value, index, 'passed')
    for name, (p95, p99) in SLOS.items():
        row = result['successful_latency'][name]
        require(row['p95_ms']<=p95 and row['p99_ms']<=p99, 'Auth missed its declared SLO')
    return result


def failed_cycle(value, reason):
    """A failed SLO needs full denominators and its actual measured violation."""
    require(isinstance(value,dict), 'Missing failed auth measurement')
    result = measurement(value, value.get('cycle'))
    names = {f'g05_auth_{name}_slo':name for name in SLOS}
    require(isinstance(reason,str) and reason in names, 'Unknown fixed auth SLO failure')
    violations = [name for name, (p95, p99) in SLOS.items()
                  if result['successful_latency'][name]['p95_ms']>p95
                  or result['successful_latency'][name]['p99_ms']>p99]
    require(violations and names[reason]==violations[0], 'Auth failure contradicts measured SLOs')
    result.update(status='failed', failed_SLO_classes=violations)
    return result


def singleflight_control(value):
    fields={'simultaneous_refresh_callers','actual_refresh_requests','shared_access_token_digest_matches',
            'all_tabs_returned_session','callers_started_per_tab','first_real_response_held_until_late_callers_started',
            'held_refresh_locks','queued_refresh_locks','real_auth_consumers'}
    require(isinstance(value,dict) and set(value)==fields, 'Unknown browser singleflight control fields')
    for key,maximum in [('simultaneous_refresh_callers',48),('actual_refresh_requests',48),
                        ('held_refresh_locks',3),('queued_refresh_locks',128)]:
        require(type(value[key]) is int and 0<=value[key]<=maximum, 'Invalid browser singleflight count')
    for key in ['shared_access_token_digest_matches','all_tabs_returned_session','first_real_response_held_until_late_callers_started']:
        require(type(value[key]) is bool, 'Invalid browser singleflight state')
    callers=value['callers_started_per_tab']
    require(isinstance(callers,list) and len(callers)==3
            and all(type(count) is int and 0<=count<=16 for count in callers)
            and sum(callers)==value['simultaneous_refresh_callers'], 'Invalid per-tab caller accounting')
    consumers=value['real_auth_consumers']
    require(isinstance(consumers,dict) and set(consumers)<={'0','1'}
            and all(type(count) is int and 0<=count<=12000 for count in consumers.values()),
            'Invalid browser singleflight consumer accounting')
    return value


def complete(values):
    require(isinstance(values,list) and len(values)==5, 'Missing complete five-cycle auth pressure evidence')
    return [cycle(value,index) for index,value in enumerate(values)]
