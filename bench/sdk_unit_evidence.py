"""Publish fixed SDK regression identities and counts without result payloads."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys

TITLE = 'isolated default server clients keeps an independent cached session readable during another client sign-in (Web Locks='


def project(value, source):
    if not isinstance(source, str) or re.fullmatch('[0-9a-f]{40}', source) is None:
        raise ValueError('Invalid SDK unit source')
    if not isinstance(value, dict) or type(value.get('success')) is not bool:
        raise ValueError('Invalid SDK unit framework verdict')
    names = ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests']
    if any(type(value.get(name)) is not int or not 0 <= value[name] <= 1000 for name in names):
        raise ValueError('Invalid SDK unit counts')
    if value['numTotalTests'] != sum(value[name] for name in names[1:]):
        raise ValueError('Incomplete SDK unit counts')
    found = []
    for enabled in ['false', 'true']:
        matches = [test for suite in value['testResults'] for test in suite['assertionResults']
                   if test.get('fullName') == TITLE + enabled + ')']
        if len(matches) != 1 or matches[0].get('status') not in {'passed', 'failed', 'pending', 'skipped'}:
            raise ValueError('Missing independent-client regression evidence')
        found.append({'web_locks': enabled == 'true', 'status': matches[0]['status']})
    return {'source_commit': source, 'tests': value['numTotalTests'], 'passed': value['numPassedTests'],
            'failed': value['numFailedTests'], 'pending': value['numPendingTests'],
            'independent_server_clients': found,
            'framework_successful': value['success'],
            'successful': value['success'] and value['numFailedTests'] == value['numPendingTests'] == 0
                          and all(item['status'] == 'passed' for item in found),
            'scope': 'SDK unit regressions only; no backend load or G05 effective-time credit.'}


if __name__ == '__main__':
    path = Path(sys.argv[1])
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 2 * 1024 ** 2:
        raise SystemExit('Missing bounded SDK unit report')
    raw = path.read_bytes()
    report = project(json.loads(raw), os.environ.get('GITHUB_SHA', ''))
    report['original_report_sha256'] = hashlib.sha256(raw).hexdigest()
    print('::notice title=SDK unit regression summary::' + json.dumps(report, separators=(',', ':'), allow_nan=False))
