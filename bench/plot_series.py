#!/usr/bin/env python3
"""Plot a checksummed public resource CSV; Matplotlib is optional tooling only."""
import argparse
import csv
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import re


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("series", type=Path)
    parser.add_argument("output", type=Path, help="Fresh output basename without an extension")
    args = parser.parse_args()
    index_path = args.series.with_suffix(".index.json")
    require(not args.series.is_symlink() and args.series.is_file() and args.series.stat().st_size <= 4 * 1024 ** 2
            and not index_path.is_symlink() and index_path.is_file() and index_path.stat().st_size <= 65536,
            "Missing bounded public resource projection")
    index = json.loads(index_path.read_text())
    require(sha256(args.series) == index["compressed_csv_sha256"] and index["certifies_g05"] is False,
            "CSV differs from its closed public index")
    require(re.fullmatch(r"[a-z][a-z0-9-]{0,79}", index["run_id"]) is not None and index["backend"] in {"disk", "s3"},
            "Unknown bounded resource identity")
    paths = {kind: Path(str(args.output) + "." + kind) for kind in ["svg", "png", "json"]}
    require(not any(path.exists() or path.is_symlink() for path in paths.values()), "Preserve previous charts")
    fields = ["elapsed_seconds", "app_rss_kib", "app_memory_anon_bytes", "app_fds", "app_tasks", "app_sockets",
              "db_connections", "db_idle_in_transaction", "db_waiting_locks", "queue_outstanding", "pg_disk_mib",
              "storage_disk_mib", "metrics_disk_mib", "pg_memory_current_bytes", "metrics_memory_current_bytes"]
    if index["backend"] == "s3":
        fields.append("s3_memory_current_bytes")
    rows = []
    with gzip.open(args.series, "rt", encoding="ascii", newline="") as stream:
        reader = csv.DictReader(stream)
        require(set(fields).issubset(reader.fieldnames or []), "Missing resource columns; never substitute zero")
        for source in reader:
            require(len(rows) < 10000, "Resource chart exceeded its sample budget")
            row = {key: float(source[key]) for key in fields}
            require(all(math.isfinite(value) and value >= 0 for value in row.values()), "Non-finite or negative chart data")
            require(not rows or row["elapsed_seconds"] > rows[-1]["elapsed_seconds"], "Non-monotonic chart observations")
            rows.append(row)
    require(len(rows) >= 2 and len(rows) == index["samples"], "Resource sample census disagrees")
    cache = Path(__file__).resolve().parents[1] / "target/stress-g05/artifacts/plot-cache"
    cache.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("XDG_CACHE_HOME", str(cache))
    os.environ.setdefault("MPLCONFIGDIR", str(cache / "matplotlib"))
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    matplotlib.rcParams["svg.hashsalt"] = index["compressed_csv_sha256"]
    figure, axes = plt.subplots(3, 2, figsize=(13, 10), sharex=True, constrained_layout=True)
    hours = [row["elapsed_seconds"] / 3600 for row in rows]

    def draw(axis, title, unit, series):
        for field, label, divisor in series:
            axis.plot(hours, [row[field] / divisor for row in rows], label=label, linewidth=1)
        axis.set_title(title, fontsize=11)
        axis.set_ylabel(unit)
        axis.set_ylim(bottom=0)
        axis.grid(alpha=0.2)
        axis.legend(fontsize=8, loc="upper left")

    draw(axes[0, 0], "Memória do app", "MiB", [("app_rss_kib", "RSS do processo", 1024), ("app_memory_anon_bytes", "Anônimo do cgroup", 2 ** 20)])
    memory = [("pg_memory_current_bytes", "PostgreSQL", 2 ** 20), ("metrics_memory_current_bytes", "Prometheus", 2 ** 20)]
    if index["backend"] == "s3":
        memory.append(("s3_memory_current_bytes", "Provedor S3", 2 ** 20))
    draw(axes[0, 1], "Memória no cgroup dos componentes", "MiB", memory)
    draw(axes[1, 0], "Recursos do processo de app", "Quantidade", [("app_fds", "Descritores", 1), ("app_sockets", "Sockets", 1), ("app_tasks", "Tarefas", 1)])
    draw(axes[1, 1], "PostgreSQL", "Quantidade", [("db_connections", "Conexões", 1), ("db_idle_in_transaction", "Idle em transação", 1), ("db_waiting_locks", "Aguardando locks", 1)])
    draw(axes[2, 0], "Fila de webhooks pendentes", "Quantidade", [("queue_outstanding", "Pendentes", 1)])
    draw(axes[2, 1], "Disco físico observado", "MiB", [("pg_disk_mib", "PostgreSQL", 1), ("storage_disk_mib", "Storage", 1), ("metrics_disk_mib", "Métricas", 1)])
    for axis in axes[2]:
        axis.set_xlabel("Horas desde o início da observação")
    figure.suptitle(index["run_id"] + " — status registrado: " + index["status"], fontsize=13)
    figure.supxlabel("Eixo inclui aquecimento/descanso. RSS e anônimo não são censo de objetos vivos. Esta figura não aprova o G05.", fontsize=9)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(paths["svg"], metadata={"Date": None})
    figure.savefig(paths["png"], dpi=140)
    plt.close(figure)
    receipt = {"run_id": index["run_id"], "harness_source_commit": index["source_commit"], "binary_sha256": index["binary_sha256"],
               "source_recorded_status": index["status"], "certifies_g05": False, "samples": len(rows),
               "csv_sha256": index["compressed_csv_sha256"], "source_index_sha256": sha256(index_path), "matplotlib_version": matplotlib.__version__,
               "plotter_sha256": sha256(Path(__file__)), "svg_sha256": sha256(paths["svg"]), "png_sha256": sha256(paths["png"]),
               "scope": "Scientific visualization of the allowlisted closed resource CSV; no heap attribution, inferred zeros or independent G05 approval"}
    paths["json"].write_text(json.dumps(receipt, indent=2, allow_nan=False) + "\n")
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
