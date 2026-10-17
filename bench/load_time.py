"""Conservatively count completed traffic intervals, excluding preparation/rest."""
import argparse
import json
import math
from pathlib import Path
import re


def finite(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def interval(row):
    if row.get('completed') is not True:
        return None
    requested, elapsed, began, ended = [row.get(name) for name in ['requested_seconds', 'elapsed_seconds', 'started_monotonic', 'ended_monotonic']]
    if not all(finite(value) for value in [requested, elapsed, began, ended]):
        raise ValueError('Missing or non-finite completed interval')
    if not 0 < requested <= 21600 or elapsed < requested or began < 0 or ended <= began or ended-began < requested or abs((ended-began)-elapsed) > 5:
        raise ValueError('Inconsistent completed interval bounds')
    phase = row.get('phase')
    if not isinstance(phase, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,79}', phase):
        raise ValueError('Invalid bounded traffic phase')
    return {'began':began, 'ended':ended, 'load_seconds':requested, 'phase':phase}


def bounded_object(path):
    if not path.exists():
        return {}
    if path.is_symlink() or path.stat().st_size > 4*1024*1024:
        raise ValueError('Invalid structured time evidence path')
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError('Structured time evidence must be an object')
    return value


def lower_bound(values):
    """Overlapping driver windows contribute only their largest measured load.

    A driver's wall window includes setup/drain, so its exact timed sub-window
    is unknown. Grouping connected overlapping windows and taking the largest
    duration avoids counting concurrent tests twice, at the cost of possible
    under-counting. Monotonic values from unknown boot epochs remain grouped
    conservatively; no wall-clock conversion invents extra load time.
    """
    total = 0
    end = best = None
    for value in sorted(values, key=lambda value:value['began']):
        if end is None:
            end, best = value['ended'], value['load_seconds']
            continue
        if value['began'] < end:
            end = max(end, value['ended'])
            best = max(best, value['load_seconds'])
            continue
        total += best
        end, best = value['ended'], value['load_seconds']
    if best is not None:
        total += best
    return total


def summarize(root):
    root = Path(root).resolve(strict=True)
    runs, all_intervals, invalid = [], [], []
    for ledger in sorted(root.glob('*/traffic-ledger.jsonl')):
        directory = ledger.parent
        if ledger.is_symlink() or not ledger.resolve().is_relative_to(root) or not re.fullmatch(r'[a-z][a-z0-9-]{0,79}', directory.name):
            invalid.append({'run':directory.name, 'reason':'unowned_or_invalid_path'})
            continue
        if ledger.stat().st_size > 1024*1024:
            invalid.append({'run':directory.name, 'reason':'ledger_size_budget'})
            continue
        entries = []
        incomplete, rejected, warmups = 0, 0, 0
        for number, line in enumerate(ledger.read_text().splitlines(keepends=True), 1):
            if not line.endswith('\n'):
                rejected += 1
                invalid.append({'run':directory.name, 'line':number, 'reason':'unterminated_interval'})
                continue
            try:
                row = json.loads(line)
                item = interval(row)
                if item is None:
                    incomplete += 1
                    continue
                if item['phase'] == 'warmup':
                    warmups += 1
                    continue
                entries.append(item)
            except (ValueError, TypeError, AttributeError):
                rejected += 1
                invalid.append({'run':directory.name, 'line':number, 'reason':'invalid_interval'})
        completion, metadata = {}, {}
        try:
            completion = bounded_object(directory/'completion.json')
            metadata = bounded_object(directory/'metadata.json')
        except (OSError, ValueError, TypeError):
            rejected += 1
            invalid.append({'run':directory.name, 'reason':'invalid_structured_evidence'})
        status = completion.get('status', 'incomplete')
        if status not in ('passed','failed','blocked','incomplete'):
            status = 'invalid'
            rejected += 1
            invalid.append({'run':directory.name, 'reason':'invalid_recorded_status'})
        digest = metadata.get('binary_sha256')
        if digest is not None and (not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest)):
            digest = None
            rejected += 1
            invalid.append({'run':directory.name, 'reason':'invalid_artifact_hash'})
        backend = metadata.get('storage_backend')
        if backend not in ('disk', 's3'):
            backend = None
        completed_soaks = [item for item in entries if item['phase']=='soak' and item['load_seconds']==14400]
        recorded_endurance = completion.get('status')=='passed' and completion.get('cleanup_confirmed') is True and len(completed_soaks)==1 and not rejected
        runs.append({'run_id':directory.name, 'recorded_status':status,
                     'completed_load_seconds':sum(item['load_seconds'] for item in entries),
                     'warmup_intervals_not_counted':warmups,
                     'incomplete_intervals_not_counted':incomplete, 'invalid_intervals_not_counted':rejected,
                     'backend':backend, 'binary_sha256':digest,
                     'recorded_completed_four_hour_endurance':recorded_endurance,
                     'scope':'A recorded completion is not independent G05 acceptance; verify the referenced data/resource evidence.'})
        all_intervals.extend(entries)
    actual = lower_bound(all_intervals)
    return {'scope':'conservative lower bound of completed requested load intervals only',
            'certifies_g05':False, 'preparation_setup_drain_rest_included':False,
            'failed_partial_intervals_included':False, 'concurrent_windows_double_counted':False,
            'effective_load_lower_bound_seconds':actual, 'effective_load_lower_bound_hours':actual/3600,
            'minimum_eight_hours_reached_by_completed_intervals':actual >= 28800,
            'recorded_complete_endurance_runs':[value['run_id'] for value in runs if value['recorded_completed_four_hour_endurance']],
            'invalid_evidence':invalid, 'runs':runs}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit('Preserve prior time evidence; choose a fresh output path')
    args.output.write_text(json.dumps(summarize(args.root), indent=2, allow_nan=False)+'\n')
