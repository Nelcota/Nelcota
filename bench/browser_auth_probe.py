#!/usr/bin/env python3
"""Bounded final-ELF browser/auth pressure on a fresh disposable Actions VM."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time

from browser_auth import PROFILE, complete, validate_failure_receipt, singleflight_control, failed_cycle
from browser_diagnostics import validate as validate_diagnostics
from browser_owners import complete as complete_owners
from campaign import docker
from matrix_probe import export_resources, input_artifact, kernel_budget, read_receipt, require
from native_evidence import notices
from native_preflight import inventory
from ownership import LABEL
from watchdog import atomic_json, cleanup

ROOT=Path(__file__).resolve().parents[1]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact',type=Path,required=True)
    parser.add_argument('--sdk',type=Path,required=True)
    parser.add_argument('--chrome-executable',type=Path,required=True)
    args=parser.parse_args()
    available=inventory()
    require(os.getuid()!=0 and available['cpu_affinity_slots']>=4
            and not docker('ps','-aq') and not docker('volume','ls','-q'),
            'Browser auth needs its empty nonroot disposable four-CPU VM')
    run,attempt=os.environ.get('GITHUB_RUN_ID',''),os.environ.get('GITHUB_RUN_ATTEMPT','')
    require(re.fullmatch('[0-9]{1,20}',run) is not None and re.fullmatch('[0-9]{1,4}',attempt) is not None,
            'Missing immutable browser diagnostic identity')
    identity='native-browser-auth-'+run+'-'+attempt
    proof=input_artifact(args.artifact,read_receipt(ROOT/'docs/goals/results/stress/final-local-candidate.json'),
                         read_receipt(ROOT/'docs/goals/results/stress/native-final-suite/index.json'))
    budget=kernel_budget(run+'-'+attempt,'g05-browser-auth-')
    output=ROOT/'target/stress-g05'/identity
    public=output.with_name(output.name+'-public');private=output.with_name(output.name+'-operator')
    require(not output.exists() and not public.exists() and not private.exists(),'Preserve prior browser evidence')
    private.mkdir(parents=True,mode=0o700)
    args.artifact.joinpath('nelcota').chmod(0o555)
    report={'identity':identity,'source':available['source'],'binary_sha256':proof['binary_sha256'],
            'scenario':'browser-auth-concurrency','certifies_g05':False,'status':'failed','cleanup_confirmed':False,
            'checks':{'product_artifact':proof,'controller_kernel_budget':budget,'auth_profile':PROFILE,
                      'local_load_checkpoint_credit_seconds':0,'observer_and_proxy_share_one_CPU_explicitly':True,
                      'configured_total_component_CPUs':3.75,'OS_CPU_headroom':0.25,
                      'observer_plus_proxy_configured_quota_on_one_slot':1.25,
                      'scope':'Separate VM with four CPU slots, distinct app/database/browser slots; observer and proxy share slot3. Existing local five-slot browser profile is separate. No SMTP/OAuth/public ingress or full G05 certification.'}}
    began=time.monotonic();child=None;ownership=None
    try:
        command=[sys.executable,str(ROOT/'bench/launch.py'),'--run-id',identity,'--kind','browser',
                 '--binary',str(args.artifact.resolve()/'nelcota'),'--sdk',str(args.sdk.resolve()),
                 '--session-seconds','1080','--auth-pressure','--four-cpu-actions',
                 '--chrome-executable',str(args.chrome_executable.resolve())]
        log=private/'browser.private.log'
        with log.open('x') as stream:
            child=subprocess.Popen(command,cwd=ROOT,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
            deadline=time.monotonic()+2400
            while child.poll() is None:
                require(log.stat().st_size<=16*1024**2 and time.monotonic()<deadline,'Browser launcher exceeded log/time boundary')
                try:child.wait(timeout=5)
                except subprocess.TimeoutExpired:pass
        require(child.returncode==0,'Browser/auth lifecycle failed')
        closure=read_receipt(output/'completion.json')
        require(closure['status']=='passed' and closure['cleanup_confirmed'] is True,'Missing successful browser closure')
        value=read_receipt(output/'browser-invariants.json')
        require(value['untrusted_control']['untrusted_CA_rejected'] is True,'Untrusted browser CA was not rejected')
        live=value['live']
        require(live['status']=='passed' and live['cross_tab_refresh_coalesced'] is True
                and live['actual_credential_renewal'] is True and live['actual_expired_access_status']==401
                and live['logout_refresh_status']==400 and live['disposed_clients_collected'] is True
                and live['external_requests_blocked']==0 and live['page_errors']==0,'Incomplete live auth/browser invariants')
        cycles=complete(live['auth_pressure'])
        require(live.get('auth_measurement_cycles')==list(range(5)), 'Missing five persisted numeric auth measurements')
        report['checks']['auth_measurement_cycles']=live['auth_measurement_cycles']
        census=read_receipt(output/'auth-pressure-census.json')
        require(census=={'created_users':40,'unrevoked_sessions':0},'Auth row/session owners did not reconcile')
        report['checks']['auth_cycles']=cycles;report['checks']['auth_census']=census
        fields=['browser_version','tabs','pressure_rest_cycles','navigation_samples','authoritative_visual_feedback_p95_ms',
                'feedback_SLO_ms','api_requests','decoded_network_bytes','auth_grants','auth_consumers','sdk_RLS_reads',
                'actual_expired_access_status','actual_expires_in_seconds','auth_observation_seconds','logout_refresh_status',
                'cross_tab_refresh_coalesced','actual_credential_renewal','disposed_clients_collected','page_errors','external_requests_blocked']
        report['checks']['browser']={key:live[key] for key in fields}
        control=singleflight_control(read_receipt(output/'live-panel-SDK/browser-auth-controls.json'))
        require(control['simultaneous_refresh_callers']==48 and control['callers_started_per_tab']==[16,16,16]
                and control['actual_refresh_requests']==1 and control['shared_access_token_digest_matches'] is True
                and control['all_tabs_returned_session'] is True and control['held_refresh_locks']==1
                and control['queued_refresh_locks']>=2
                and control['first_real_response_held_until_late_callers_started'] is True,
                'Actual overlapping browser refreshes did not coalesce')
        report['checks']['singleflight_control']=control
        report['checks']['browser_owners']=complete_owners(read_receipt(output/'live-panel-SDK/browser-plateaus.json'))
        require(live['authoritative_visual_feedback_p95_ms']<=1000,'Browser feedback missed its original SLO')
        report['status']='passed'
    except Exception as error:
        report['failure']={'type':type(error).__name__}
        control=output/'live-panel-SDK/browser-auth-controls.json'
        if control.exists():
            try:
                report['checks']['singleflight_control']=singleflight_control(read_receipt(control))
            except Exception:
                report['checks']['singleflight_control_invalid']=True
        diagnostic=output/'browser-diagnostics.json'
        if diagnostic.exists():
            try:
                report['checks']['failure_diagnostics']=validate_diagnostics(read_receipt(diagnostic))
            except Exception:
                report['checks']['failure_diagnostics_invalid']=True
        original = output/'browser-failure.json'
        if original.exists():
            try:
                report['failure'] = validate_failure_receipt(read_receipt(original))
            except Exception:
                report['checks']['failure_receipt_invalid'] = True
        critical=output/'live-panel-SDK/browser-critical.json'
        if critical.is_file() and not critical.is_symlink() and critical.stat().st_size<=16384:
            value=json.loads(critical.read_text());reason=value.get('reason')
            if isinstance(reason,str) and re.fullmatch('[a-z0-9_]{1,100}',reason):
                report['failure']['reason']=reason
                measured = output/'live-panel-SDK/browser-auth-measurement.json'
                if reason in {'g05_auth_login_slo','g05_auth_refresh_slo','g05_auth_user_slo','g05_auth_rls_slo'} and measured.exists():
                    try:
                        report['checks']['failed_auth_pressure'] = failed_cycle(read_receipt(measured), reason)
                    except Exception:
                        report['checks']['failed_auth_pressure_invalid'] = True
    finally:
        if child is not None and child.poll() is None:
            child.send_signal(signal.SIGTERM)
            try:child.wait(timeout=60)
            except subprocess.TimeoutExpired:
                child.kill();child.wait(timeout=10)
        try:
            ownership=read_receipt(output/'ownership.json')
            require(re.fullmatch('nelcota-browser-[a-f0-9]{32}',ownership.get('identity','')) is not None
                    and ownership['output']==str(output),'Browser cleanup ownership differs')
            cleanup(ownership)
            remaining=docker('ps','-aq','--filter','label='+LABEL+'='+ownership['identity'])
            volumes=docker('volume','ls','-q','--filter','label='+LABEL+'='+ownership['identity'])
            for directory in output.glob('fixture-*'):
                require(directory.is_dir() and not directory.is_symlink()
                        and directory.resolve().parent==output.resolve(),'Browser cleanup directory escaped its run')
                shutil.rmtree(directory)
            report['cleanup_confirmed']=not remaining and not volumes and not list(output.glob('fixture-*'))
            if report['cleanup_confirmed']:(output/'watchdog-disarmed').touch()
        except Exception as error:
            report['checks']['cleanup_failure_type']=type(error).__name__
        if not report['cleanup_confirmed']:report['status']='failed'
        public.mkdir(mode=0o755)
        try:
            require(ownership is not None,'Missing owned browser resource context')
            prefix=ownership['identity']
            roles={prefix+'-app-0':'app-0',prefix+'-app-1':'app-1',prefix+'-pg-0':'pg-0',prefix+'-proxy':'proxy','browser':'browser'}
            resource=export_resources(output/'resources.jsonl',public,roles)
            report['checks']['resource_evidence']=resource;report['resource_samples']=resource['samples']
            require(resource['maximum_gap_seconds']<=30,'Browser resource evidence exceeded its unchanged gap')
        except Exception as error:
            report['diagnostic_failure_type']=type(error).__name__;report['status']='failed'
        report['elapsed_seconds_including_preparation']=time.monotonic()-began
        target=public/'browser-auth.json';atomic_json(target,report);target.chmod(0o644)
        for line in notices(report):
            print(line.replace('title=Native VM summary','title=Browser auth summary').replace('title=Native VM evidence','title=Browser auth evidence'),flush=True)
    if report['status']!='passed':raise SystemExit(1)


if __name__=='__main__':main()
