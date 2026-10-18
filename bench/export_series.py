"""Project closed ordinary resource evidence into bounded public numeric series."""
import csv,gzip,hashlib,io,json,math,re,sys
from pathlib import Path
root,output=map(Path,sys.argv[1:])
base=Path('target/stress-g05').resolve(strict=True)
root=root.resolve(strict=True)
if root.parent!=base or not re.fullmatch(r'[a-z][a-z0-9-]{0,79}',root.name):raise RuntimeError('Unknown run root')
if output.exists() or output.with_suffix('.index.json').exists():raise RuntimeError('Preserve existing public series')
completion=json.loads((root/'completion.json').read_text())
cleanup=json.loads((root/'cleanup.json').read_text())
if completion.get('cleanup_confirmed') is not True or cleanup.get('containers')!=[] or cleanup.get('volumes')!=[] or cleanup.get('directory_removed') is not True:raise RuntimeError('Resource series must be closed after confirmed teardown')
metadata=json.loads((root/'metadata.json').read_text())
backend=metadata['storage_backend']
if backend not in ('disk','s3'):raise RuntimeError('Unknown single-project backend')
roles=['app','pg','metrics']
if backend=='s3':roles.append('s3')
fields=['elapsed_seconds','phase','app_rss_kib','app_fds','app_tasks','app_sockets','db_connections','db_active','db_idle_in_transaction','db_waiting_locks','pg_disk_mib','storage_disk_mib','metrics_disk_mib','queue_outstanding','queue_retained','signature_errors']
role_fields=['memory_current_bytes','memory_peak_bytes','memory_anon_bytes','memory_file_bytes','memory_shmem_bytes','pids_current','cpu_usage_usec','cpu_throttled_usec','oom_count','oom_kill_count']
for role in roles:fields.extend(role+'_'+name for name in role_fields)
resource=root/'resources.jsonl'
if resource.is_symlink() or not resource.is_file() or not 0<resource.stat().st_size<=256*1024*1024:raise RuntimeError('Resource file exceeded its closed-evidence byte budget')
def number(value):
 if isinstance(value,bool) or not isinstance(value,(int,float)) or not 0<=value<=2**53 or not math.isfinite(value):raise RuntimeError('Invalid numeric evidence')
 return value
stream=io.StringIO(newline='');writer=csv.DictWriter(stream,fieldnames=fields);writer.writeheader()
count=0;previous=None;first=None;maximum_gap=0;phases={}
with resource.open() as source:
 for line in source:
  if not line.endswith('\n') or len(line)>256*1024:raise RuntimeError('Incomplete or unbounded resource observation')
  row=json.loads(line);elapsed=number(row['elapsed']);phase=row['phase']
  if not isinstance(phase,str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,79}',phase):raise RuntimeError('Invalid phase label')
  if previous is not None:
   if elapsed<=previous:raise RuntimeError('Non-monotonic resource observations')
   maximum_gap=max(maximum_gap,elapsed-previous)
  if first is None:first=elapsed
  previous=elapsed;count+=1
  if count>10000:raise RuntimeError('Resource observation budget exceeded')
  phases[phase]=phases.get(phase,0)+1
  own={}
  for item in row['ownership'].splitlines():
   key,value=item.split()
   if key not in ('fds','tasks','sockets') or key in own:raise RuntimeError('Invalid process owner census')
   own[key]=number(int(value))
  if set(own)!={'fds','tasks','sockets'}:raise RuntimeError('Missing process owner census')
  values={'elapsed_seconds':elapsed,'phase':phase,'app_rss_kib':number(row['app_rss_kib']),'app_fds':own['fds'],'app_tasks':own['tasks'],'app_sockets':own['sockets'],'pg_disk_mib':number(row['pg_disk_mib']),'storage_disk_mib':number(row['storage_disk_mib']),'metrics_disk_mib':number(row['metrics_disk_mib']),'queue_outstanding':number(row['queue']['outstanding']),'queue_retained':number(row['queue']['retained']),'signature_errors':number(row['signature_errors'])}
  for key in ['connections','active','idle_in_transaction','waiting_locks']:values['db_'+key]=number(row['database'][key])
  components={name.rsplit('-',1)[-1]:value for name,value in row['component_cgroups'].items()}
  if set(components)!=set(roles):raise RuntimeError('Missing or ambiguous component roles')
  for role in roles:
   c=components[role]
   projected={'memory_current_bytes':c['memory.current'],'memory_peak_bytes':c['memory.peak'],'memory_anon_bytes':c['memory.stat']['anon'],'memory_file_bytes':c['memory.stat']['file'],'memory_shmem_bytes':c['memory.stat']['shmem'],'pids_current':c['pids.current'],'cpu_usage_usec':c['cpu.stat']['usage_usec'],'cpu_throttled_usec':c['cpu.stat']['throttled_usec'],'oom_count':c['memory.events']['oom'],'oom_kill_count':c['memory.events']['oom_kill']}
   for key,value in projected.items():values[role+'_'+key]=number(value)
  writer.writerow(values)
if count<2:raise RuntimeError('Insufficient observations')
raw=stream.getvalue().encode('ascii')
output.parent.mkdir(parents=True,exist_ok=True)
with output.open('xb') as target:
 with gzip.GzipFile(fileobj=target,filename='',mode='wb',mtime=0) as archive:archive.write(raw)
if gzip.decompress(output.read_bytes())!=raw:raise RuntimeError('Public series round-trip disagreed')
with resource.open('rb') as source:source_hash=hashlib.file_digest(source,'sha256').hexdigest()
index={'run_id':root.name,'status':completion['status'],'certifies_g05':False,'scope':'Allowlisted numeric projection of closed resource observations. No SQL, credentials, request URLs, payloads or object keys are exported. Elapsed values retain the original 0.1s resource timestamp resolution; these observation times do not replace the traffic ledger or closed counter coverage.','source_commit':metadata['git'],'binary_sha256':metadata['binary_sha256'],'harness_sha256':metadata['harness_sha256'],'backend':backend,'object_payload_bytes':metadata['object_payload_bytes'],'dataset':metadata['dataset'],'samples':count,'first_elapsed_seconds':first,'last_elapsed_seconds':previous,'maximum_gap_from_rounded_timestamps_seconds':maximum_gap,'phase_sample_counts':phases,'columns':fields,'csv_encoding':'ASCII, RFC4180 via Python csv, gzip mtime zero','resource_jsonl_sha256':source_hash,'uncompressed_csv_sha256':hashlib.sha256(raw).hexdigest(),'compressed_csv_sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'exporter_source_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
output.with_suffix('.index.json').write_text(json.dumps(index,indent=2,allow_nan=False)+'\n')
print(json.dumps({'output':str(output),'samples':count,'compressed_bytes':output.stat().st_size,'status':completion['status']}))
