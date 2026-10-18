"""Compare equivalent native k6 campaign medians without hiding failed runs."""

import argparse
import json
import math
from pathlib import Path
import statistics
from metrics import STORAGE_PROFILE
from latency import PROTOCOL as LATENCY_PROTOCOL
from arrival_counters import PROTOCOL as ARRIVAL_COUNTER_PROTOCOL, closed_count
from http_counters import PROTOCOL as HTTP_COUNTER_PROTOCOL, closed_counts

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("baseline", type=Path)
parser.add_argument("candidate", type=Path)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument(
    "--workloads",
    type=lambda value: value.split(","),
    default=["read", "rls", "panel", "storage", "login", "refresh", "mixed"],
)
args = parser.parse_args()
rows = []
failed = []
fixture_fields = [
    "cpu_affinity",
    "app_cpus",
    "app_memory_mb",
    "pg_cpus",
    "pg_memory_mb",
    "generator_memory_mb",
    "generator_go_memory_limit_mib",
    "pg_data",
    "max_wal_mb",
    "max_fixture_disk_mb",
    "pool",
    "max_connections",
    "k6",
    "storage_backend",
    "steady_rate",
    "postgres_version",
    "images",
    "dataset",
]
metadata = [
    json.loads((directory / "metadata.json").read_text())
    for directory in [args.baseline, args.candidate]
]
throughput_metric='http_reqs'
if any(value.get('schema')==2 or 'metrics_backend' in value for value in metadata):
    throughput_metric='successful_operations'
campaign_validity=[]
for index,directory in enumerate([args.baseline,args.candidate]):
    valid=True
    if throughput_metric=='successful_operations':
        try:
            completion=json.loads((directory/'completion.json').read_text())
            cleanup=json.loads((directory/'cleanup.json').read_text())
            valid=completion.get('status')=='passed' and completion.get('cleanup_confirmed') is True and cleanup.get('containers')==[] and cleanup.get('volumes')==[] and cleanup.get('directory_removed') is True
            valid = valid and metadata[index].get('arrival_counter_protocol') == ARRIVAL_COUNTER_PROTOCOL
            valid = valid and metadata[index].get('http_counter_protocol') == HTTP_COUNTER_PROTOCOL
            valid = valid and metadata[index].get('successful_latency_protocol') == LATENCY_PROTOCOL
            valid = valid and metadata[index].get('metrics_storage_profile') == STORAGE_PROFILE
        except (OSError,ValueError,TypeError):
            valid=False
    if 'allocator_observer' in metadata[index]:
        valid=False
    campaign_validity.append(valid)
for field in ["steady_duration", "workloads", "s3", "schema", "metrics_backend", "metrics_memory_mb", "metrics_cpus", "metrics_cpu_affinity", "effective_cpu_quota", "offered_rate_unit", "nominal_slos_ms", "auth_rate_limit_per_minute", "autovacuum", "webhook_history_maintenance", "storage_filesystem", "physical_seeded_objects", "object_payload_bytes", "max_storage_fixture_disk_mib"]:
    if any(field in value for value in metadata):
        fixture_fields.append(field)
for field in ['resource_protocol','postgres_observation_settings','soak_fraction','container_log_profile','pressure_rest_seconds','final_idle_seconds','write_steady_rate','harness_sha256','client_initialization','calibration_ceiling_iterations_per_second','session_canary_observation','arrival_counter_protocol','http_counter_protocol','generator_usage_reporting','generator_observation_protocol','successful_latency_protocol','metrics_storage_profile']:
    if any(field in value for value in metadata):
        fixture_fields.append(field)
fixture_differences = [
    field
    for field in fixture_fields
    if any(field not in value for value in metadata)
    or metadata[0].get(field) != metadata[1].get(field)
]


def valid_metrics(metrics):
    try:
        values = [
            metrics["http_req_duration"][key] for key in ["p(50)", "p(95)", "p(99)"]
        ]
        if throughput_metric=='http_reqs' and 'successful_operations' in metrics:
            return False  # An undeclared protocol cannot certify useful work.
        rate = metrics[throughput_metric]["rate"]
        count = metrics[throughput_metric]["count"]
        http_rate=metrics['http_reqs']['rate']
        http_count=metrics['http_reqs']['count']
        failures=[metrics['unexpected']['value'],metrics['checks']['fails']]
        if throughput_metric == 'successful_operations':
            failures.append(metrics['dropped_iterations']['count'])
        if not all(
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
            for value in [*values, rate, count,http_rate,http_count,*failures]
        ):
            return False
        return (
            metrics["unexpected"]["value"] == 0
            and metrics["checks"]["fails"] == 0
            and 0 <= values[0] <= values[1] <= values[2]
            and values[1] > 0
            and rate > 0
            and count > 0
            and http_rate>0
            and http_count>=count
        )
    except (KeyError, TypeError):
        return False


for workload in args.workloads:
    measurements = []
    for directory in [args.baseline, args.candidate]:
        values = []
        for i in range(1, 4):
            try:
                sample = json.loads((directory / f"{workload}-{i}.json").read_text())
                metrics = sample['metrics']
                if throughput_metric == 'successful_operations':
                    dropped = closed_count(sample.get('arrival_counter_evidence'), f'{workload}-{i}', 'traffic', sample.get('duration_seconds'))
                    if dropped != metrics['dropped_iterations']['count']:
                        raise ValueError('Reported arrivals disagree with retained scheduler evidence')
                    http = closed_counts(sample.get('http_counter_evidence'), f'{workload}-{i}', 'traffic', sample.get('duration_seconds'))
                    if http['http_reqs'] != metrics['http_reqs']['count'] or http['expected_rejections'] != metrics['expected_rejections']['count']:
                        raise ValueError('Reported HTTP counts disagree with retained outcome evidence')
                values.append(metrics)
            except (OSError, ValueError, KeyError, TypeError):
                values.append(None)
        valid = [metrics for metrics in values if valid_metrics(metrics)]
        measurement = {
            "successful_runs": len(valid),
            "failures": len(values) - len(valid),
        }
        if valid:
            for name, key in [
                ("p50_ms", "p(50)"),
                ("p95_ms", "p(95)"),
                ("p99_ms", "p(99)"),
            ]:
                measurement[name] = statistics.median(
                    metrics["http_req_duration"][key] for metrics in valid
                )
            measurement["rps"] = statistics.median(
                metrics[throughput_metric]["rate"] for metrics in valid
            )
            measurement["duration_seconds"] = statistics.median(
                metrics[throughput_metric]["count"] / metrics[throughput_metric]["rate"]
                for metrics in valid
            )
        measurements.append(measurement)
    baseline, candidate = measurements
    comparable = (
        baseline["successful_runs"] == 3
        and candidate["successful_runs"] == 3
        and not fixture_differences
        and all(campaign_validity)
    )
    if (
        comparable
        and abs(baseline["duration_seconds"] - candidate["duration_seconds"]) > 1
    ):
        comparable = False
    passed = comparable
    row = {
        "workload": workload,
        "baseline": baseline,
        "candidate": candidate,
        "comparable": comparable,
    }
    if comparable:
        row["p95_ratio"] = candidate["p95_ms"] / baseline["p95_ms"]
        row["rps_ratio"] = candidate["rps"] / baseline["rps"]
        passed = row["p95_ratio"] <= 1.10 and row["rps_ratio"] >= 0.90
    row["gate_passed"] = passed
    if not passed:
        failed.append(workload)
    rows.append(row)
report = {
    "throughput_metric":throughput_metric,
    "useful_throughput_verified":throughput_metric=='successful_operations',
    "campaign_evidence_valid":campaign_validity,
    "p95_limit": 1.10,
    "rps_minimum": 0.90,
    "fixture_differences": fixture_differences,
    "rows": rows,
    "failed": failed,
}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
for row in rows:
    print(
        row["workload"], "comparable:", row["comparable"], "passed:", row["gate_passed"]
    )
if failed:
    raise SystemExit("Regression envelope not met: " + ", ".join(failed))
