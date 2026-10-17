"""Fixed setup diagnostics for owned fixtures; never raw logs or environment."""
import json

STAGES = {'constructed', 'database-create', 'database-readiness', 'app-starting',
          'app-ready', 'auth-signup', 'admin-credentials', 'admin-login',
          'fixture-data', 'fixture-object', 'ready'}
PATTERNS = {'database-authentication':['password authentication failed'],
            'database-unavailable':['connection refused','database unavailable'],
            'permission':['permission denied'], 'bind':['address already in use'],
            'native-loader':['error while loading shared libraries','exec format error'],
            'configuration':['invalid configuration','configuration error'],
            'panic':['panicked at'], 'disk-full':['no space left on device']}


def require(condition):
    if not condition:
        raise ValueError('Invalid fixed owned-project setup diagnostic')


def component(call, name):
    try:
        value = json.loads(call('inspect',name))[0]
        state = value['State']
        result = {'available':True, 'running':state['Running'], 'oom_killed':state['OOMKilled'],
                  'exit_code':state['ExitCode'], 'restart_count':value['RestartCount'], 'logs_available':False}
        try:
            raw = call('logs','--tail','80',name,include_stderr=True).encode()
            text = raw[-65536:].decode('utf-8',errors='replace').casefold()
            result.update(logs_available=True, observed_log_bytes=min(len(raw),65536), log_truncated=len(raw)>65536,
                          categories={key:sum(text.count(pattern) for pattern in patterns) for key,patterns in PATTERNS.items()})
        except Exception:
            pass
        validate_component(result)
        return result
    except Exception:
        return {'available':False}


def validate_component(value):
    require(isinstance(value,dict) and type(value.get('available')) is bool)
    if value['available'] is False:
        require(set(value)=={'available'})
        return
    fields={'available','running','oom_killed','exit_code','restart_count','logs_available'}
    require(type(value.get('logs_available')) is bool)
    if value['logs_available']:
        fields.update({'observed_log_bytes','log_truncated','categories'})
    require(set(value)==fields and type(value['running']) is bool and type(value['oom_killed']) is bool)
    require(type(value['exit_code']) is int and 0<=value['exit_code']<=255
            and type(value['restart_count']) is int and 0<=value['restart_count']<=1000000)
    if value['logs_available']:
        require(type(value['observed_log_bytes']) is int and 0<=value['observed_log_bytes']<=65536
                and type(value['log_truncated']) is bool and isinstance(value['categories'],dict)
                and set(value['categories'])==set(PATTERNS)
                and all(type(count) is int and 0<=count<=65536 for count in value['categories'].values()))


def snapshot(project):
    return validate({'stage':project.setup_stage,'app':component(project.docker,project.app),
                     'postgres':component(project.docker,project.pg)})


def validate(value):
    require(isinstance(value,dict) and set(value)=={'stage','app','postgres'}
            and isinstance(value['stage'],str) and value['stage'] in STAGES)
    for role in ['app','postgres']:
        validate_component(value[role])
    return value
