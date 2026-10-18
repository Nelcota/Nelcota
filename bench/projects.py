"""Independent disposable project clusters for the G05 host-scale matrix."""
import os
from pathlib import Path
import secrets
import time
import urllib.error

from campaign import docker, free_port, owns_listener, request, token
from watchdog import LABEL
from ownership import OwnedDocker
from ports import published_port

FIXED_USER = '00000000-0000-4000-8000-000000000001'


def cpu_arguments(count, period_micros, policy='quota'):
    if isinstance(count,bool) or not isinstance(count,int) or not 1<=count<=10 or isinstance(period_micros,bool) or not isinstance(period_micros,int) or period_micros not in (10000,100000) or policy not in ('quota','shared'):
        raise ValueError('Invalid independent-project CPU policy')
    if policy=='shared':
        count=1
    if period_micros==100000:
        return ['--cpus',str(1/count)]
    quota,remainder=divmod(period_micros,count)
    if remainder or quota<1000:
        raise ValueError('CPU period cannot represent the declared project fraction')
    return ['--cpu-period',str(period_micros),'--cpu-quota',str(quota)]


class Project:
    def __init__(self, identity, index, count, binary, directory, cpus, cpu_period_micros=100000, cpu_policy='quota'):
        self.cpu_limits=cpu_arguments(count,cpu_period_micros,cpu_policy)
        self.label = f'project-{index}'
        self.app = identity + f'-app-{index}'
        self.pg = identity + f'-pg-{index}'
        self.volume = identity + f'-data-{index}'
        self.identity = identity
        self.docker=OwnedDocker(identity,docker)
        self.binary = binary
        self.storage = directory / self.label
        self.storage.mkdir(parents=True)
        self.cpus = cpus
        self.quota = str(1 / count)
        if cpu_policy=='shared':self.quota='1'
        self.jwt = secrets.token_urlsafe(48)
        self.password = secrets.token_urlsafe(32)
        self.admin_email = f'operator-{index}@example.test'
        self.email = 'stress-user@example.test'
        self.base = f'http://127.0.0.1:{free_port()}'
        self.port = int(self.base.rsplit(':', 1)[1])
        self.environment = {}
        self.fixture = None
        self.ephemeral_storage_mib = None
        self.ephemeral_storage_inodes = None
        self.extra_labels = {}
        self.webhooks_enabled = False
        self.setup_stage = 'constructed'

    def sql(self, statement):
        return self.docker('exec', '-i', '-e', 'PGOPTIONS=-cstatement_timeout=15000', self.pg, 'psql', '-Atq', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', stdin=statement)

    def database_ready(self, password):
        if not isinstance(password,str) or not password:
            raise ValueError('Owned database readiness requires its generated credential')
        return self.docker('exec', '-i', '-e', 'PGPASSWORD', '-e', 'PGCONNECT_TIMEOUT=2',
                           '-e', 'PGOPTIONS=-cstatement_timeout=2000', self.pg,
                           'psql', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres',
                           '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1',
                           stdin='SELECT 1', env={'PGPASSWORD':password}) == '1'

    def start_app(self):
        self.setup_stage = 'app-starting'
        command = ['run', '-d', '--name', self.app, '--label', LABEL+'='+self.identity, '--pids-limit', '128', '--network', 'host', '--user', f'{os.getuid()}:{os.getgid()}', *self.cpu_limits, '--cpuset-cpus', str(self.cpus[0]), '--memory', '128m', '--memory-swap', '128m', '-v', str(self.binary)+':/usr/local/bin/nelcota:ro']
        if self.ephemeral_storage_mib is None:
            command.extend(['-v',str(self.storage)+':/storage'])
        if self.ephemeral_storage_mib is not None:
            if not 8 <= self.ephemeral_storage_mib <= 64:
                raise ValueError('Ephemeral fault filesystem must be 8..64 MiB')
            options=f'/storage:rw,noexec,nosuid,size={self.ephemeral_storage_mib}m,uid={os.getuid()},gid={os.getgid()},mode=0700'
            if self.ephemeral_storage_inodes is not None:
                if not 32 <= self.ephemeral_storage_inodes <= 256:
                    raise ValueError('Fault inode quota must be 32..256')
                options+=f',nr_inodes={self.ephemeral_storage_inodes}'
            command.extend(['--tmpfs',options])
        for key,value in self.extra_labels.items():
            command.extend(['--label',key+'='+value])
        if self.environment.get('NELCOTA_STORAGE_BACKEND')=='s3':
            trust=Path('/etc/ssl/certs/ca-certificates.crt')
            if not trust.is_file() or trust.stat().st_size==0:
                raise RuntimeError('S3 fixture needs the verified system trust bundle')
            command.extend(['-v',str(trust)+':/etc/ssl/certs/ca-certificates.crt:ro'])
        for key in self.environment:
            command.extend(['-e', key])
        command.extend(['ubuntu:24.04', '/usr/local/bin/nelcota', 'serve'])
        created=self.docker(*command, env=self.environment)
        for _ in range(120):
            try:
                if owns_listener(created, self.port):
                    request(self.base, '/auth/v1/.well-known/jwks.json')
                    self.setup_stage = 'app-ready'
                    return
            except (RuntimeError, urllib.error.URLError):
                pass
            time.sleep(.25)
        raise RuntimeError('Owned project listener did not become ready: '+self.label)

    def create(self):
        self.setup_stage = 'database-create'
        password = secrets.token_urlsafe(32)
        self.pg_port=free_port()
        self.docker('volume', 'create', '--label', LABEL+'='+self.identity, self.volume)
        self.docker('run', '-d', '--name', self.pg, '--label', LABEL+'='+self.identity, '--pids-limit', '128', *self.cpu_limits, '--cpuset-cpus', str(self.cpus[1]), '--memory', '256m', '--memory-swap', '256m', '-e', 'POSTGRES_PASSWORD', '-p', f'127.0.0.1:{self.pg_port}:5432', '--mount', f'type=volume,source={self.volume},destination=/var/lib/postgresql/data', 'postgres:17-alpine', 'postgres', '-c', 'max_connections=32', '-c', 'shared_buffers=32MB', '-c', 'max_wal_size=64MB', '-c', 'min_wal_size=32MB', env={'POSTGRES_PASSWORD': password})
        self.setup_stage = 'database-readiness'
        port = published_port(self.docker,self.pg,5432,self.pg_port)
        for attempt in range(120):
            try:
                if self.database_ready(password):
                    break
            except RuntimeError:
                pass
            if attempt == 119:
                raise RuntimeError('Owned project database readiness deadline')
            time.sleep(.25)
        self.environment = {'TOKIO_WORKER_THREADS':'2', 'RUST_LOG':'warn', 'NELCOTA_DATABASE_URL':f'postgres://postgres:{password}@127.0.0.1:{port}/postgres', 'NELCOTA_AUTHENTICATOR_PASSWORD':secrets.token_urlsafe(32), 'NELCOTA_JWT_SECRET':self.jwt, 'NELCOTA_LISTEN':self.base.removeprefix('http://'), 'NELCOTA_DB_POOL_SIZE':'4', 'NELCOTA_AUTH_RATE_LIMIT_PER_MINUTE':'100000', 'NELCOTA_REQUEST_TIMEOUT_SECS':'5', 'NELCOTA_STATEMENT_TIMEOUT_SECS':'3', 'NELCOTA_STORAGE_BACKEND':'disk', 'NELCOTA_STORAGE_DIR':'/storage', 'NELCOTA_STORAGE_MIN_FREE_BYTES':'0'}
        if self.webhooks_enabled:
            self.environment['NELCOTA_WEBHOOKS_ALLOW_LOOPBACK'] = 'true'
        self.start_app()
        self.setup_stage = 'auth-signup'
        request(self.base, '/auth/v1/signup', {'email':self.admin_email,'password':self.password})
        self.setup_stage = 'admin-credentials'
        self.environment['NELCOTA_ADMIN_EMAIL'] = self.admin_email
        self.environment['NELCOTA_ADMIN_PASSWORD_HASH'] = self.sql('SELECT encrypted_password FROM auth.users LIMIT 1')
        self.sql("INSERT INTO auth.users SELECT (json_populate_record(NULL::auth.users, (to_jsonb(u)||jsonb_build_object('id','"+FIXED_USER+"','email','"+self.email+"'))::json)).* FROM auth.users u LIMIT 1;")
        self.docker('rm', '-f', self.app)
        self.start_app()
        self.setup_stage = 'admin-login'
        _, headers = request(self.base, '/admin/api/login', {'email':self.admin_email,'password':self.password}, {'Origin':self.base})
        cookie = headers['Set-Cookie'].split(';',1)[0]
        self.setup_stage = 'fixture-data'
        self.sql("CREATE TABLE public.bench_products(id integer PRIMARY KEY,name text,stock integer); INSERT INTO public.bench_products SELECT i,'"+self.label+":'||i,i%50 FROM generate_series(1,1000)i; CREATE INDEX ON public.bench_products(stock,id); GRANT SELECT ON public.bench_products TO anon; GRANT SELECT,UPDATE ON public.bench_products TO service_role; CREATE TABLE public.bench_private(id integer PRIMARY KEY,user_id uuid,body text); INSERT INTO public.bench_private SELECT i,CASE WHEN i%2=0 THEN '"+FIXED_USER+"'::uuid ELSE gen_random_uuid() END,'"+self.label+"' FROM generate_series(1,1000)i; CREATE INDEX ON public.bench_private(user_id,id); ALTER TABLE public.bench_private ENABLE ROW LEVEL SECURITY; CREATE POLICY own ON public.bench_private TO authenticated USING(user_id=auth.uid()); GRANT SELECT ON public.bench_private TO authenticated; INSERT INTO storage.buckets(id,public) VALUES('bench',true); ANALYZE public.bench_products; ANALYZE public.bench_private; NOTIFY nelcota,'reload schema';")
        service = token(self.jwt, {'role':'service_role','exp':int(time.time())+7200})
        time.sleep(.25)
        self.setup_stage = 'fixture-object'
        request(self.base, '/storage/v1/object/bench/fixture.txt', self.label+': payload', {'Authorization':'Bearer '+service}, method='PUT')
        self.fixture = {'label':self.label,'marker':self.label+':','base':self.base,'email':self.email,'password':self.password,'service':service,'cookie':cookie,'user':FIXED_USER,'invalid_access':token(secrets.token_urlsafe(48),{'role':'authenticated','sub':FIXED_USER,'exp':int(time.time())+7200})}
        self.setup_stage = 'ready'
        return self.fixture

    def assert_foreign_denied(self, foreign):
        try:
            request(self.base,'/rest/v1/bench_products?limit=1',headers={'Authorization':'Bearer '+foreign['service']})
        except urllib.error.HTTPError as error:
            if error.code == 401:
                return
            raise RuntimeError('Unexpected cross-project rejection class') from None
        raise RuntimeError('Cross-project credential was accepted')
