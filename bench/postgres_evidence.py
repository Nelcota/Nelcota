"""Bounded private PostgreSQL diagnostics before an owned fixture is removed."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time

from watchdog import atomic_json,host_reserves

STATISTICS_SQL="""
SELECT json_build_object(
 'database',(SELECT row_to_json(s) FROM pg_stat_database s WHERE datname=current_database()),
 'wal',(SELECT row_to_json(s) FROM pg_stat_wal s),
 'checkpointer',(SELECT row_to_json(s) FROM pg_stat_checkpointer s),
 'tables',(SELECT coalesce(json_agg(t),'[]'::json) FROM (
   SELECT schemaname,relname,n_live_tup,n_dead_tup,n_tup_ins,n_tup_upd,n_tup_del,n_tup_hot_upd,n_mod_since_analyze,
     vacuum_count,autovacuum_count,analyze_count,autoanalyze_count,last_autovacuum,
     pg_total_relation_size(relid) AS total_bytes
   FROM pg_stat_user_tables ORDER BY schemaname,relname LIMIT 128)t),
 'activity',(SELECT coalesce(json_agg(t),'[]'::json) FROM (
   SELECT pid,state,wait_event_type,wait_event,
     extract(epoch FROM clock_timestamp()-xact_start) AS transaction_age_seconds,
     pg_blocking_pids(pid) AS blockers
   FROM pg_stat_activity WHERE datname=current_database() ORDER BY pid LIMIT 64)t)
)
"""


def retain_failure(output,owned,postgres,sql,unsafe=False):
    """No extra database work when a critical guard has already stopped load."""
    output=Path(output)
    result={'scope':'private synthetic-fixture postmortem, no production data','snapshot_byte_limit':64*1024*1024,'snapshot_deadline_seconds':30,'status':'skipped'}
    began=time.monotonic()
    try:
        if unsafe or host_reserves(output):
            result['reason']='critical_resource_stop'
            return result
        atomic_json(output/'failure-postgres.json',json.loads(sql(STATISTICS_SQL)))
        logs=output/'failure-postgres.log'
        logs.write_text(owned('logs','--tail','500',postgres,include_stderr=True))
        logs.chmod(0o600)
        limiter=shutil.which('prlimit')
        if limiter is None:
            result['reason']='file_size_limiter_unavailable'
            return result
        archive=output/'failure-database.dump'
        identifier=owned.require(postgres)
        with archive.open('xb') as destination:
            archive.chmod(0o600)
            completed=subprocess.run([limiter,'--fsize=67108864:67108864','--','docker','exec',identifier,'pg_dump','-U','postgres','-Fc','--no-owner'],stdout=destination,stderr=subprocess.PIPE,stdin=subprocess.DEVNULL,timeout=30)
        result.update({'status':'incomplete_snapshot','snapshot_bytes':archive.stat().st_size,'dump_exit_code':completed.returncode})
        if completed.returncode==0 and 0<archive.stat().st_size<=result['snapshot_byte_limit']:
            with archive.open('rb') as source:
                result['snapshot_sha256']=hashlib.file_digest(source,'sha256').hexdigest()
            result['status']='retained'
            result['private_snapshot_relative_path']=archive.name
    except Exception as error:
        result.update({'status':'diagnostic_failure','error_type':type(error).__name__})
    finally:
        result['elapsed_seconds']=time.monotonic()-began
        try:
            atomic_json(output/'failure-diagnostics.json',result)
        except OSError:
            pass  # A failed diagnostic filesystem must never prevent teardown.
    return result
