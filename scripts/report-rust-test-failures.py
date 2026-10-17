"""Expose bounded failed-test identities without publishing assertion payloads."""
from pathlib import Path
import re
import sys

MAX_BYTES = 16 * 1024 * 1024
MAX_FAILURES = 32
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
FAILED = re.compile(r'^test ([A-Za-z0-9_:]{1,200}) \.\.\. FAILED$')


def failed_tests(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
        return []
    names = []
    with path.open(errors='replace') as source:
        for line in source:
            match = FAILED.fullmatch(ANSI.sub('', line.strip()))
            if match is None or match[1] in names:
                continue
            names.append(match[1])
            if len(names) == MAX_FAILURES:
                break
    return names


def annotations(path):
    names = failed_tests(path)
    if not names:
        return ['::error title=Rust test step failed::No named failure was recovered from the bounded log; retain the original failed step.']
    return ['::error title=Rust reported a failed test::' + name for name in names]


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Provide the owned Rust test log path')
    for annotation in annotations(sys.argv[1]):
        print(annotation)
