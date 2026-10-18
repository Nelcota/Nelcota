#!/usr/bin/env python3
"""Freeze or verify the single ELF shared by the disposable native suite."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
MAXIMUM_BYTES = 64 * 1024 ** 2


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def artifact(directory, source):
    require(re.fullmatch("[0-9a-f]{40}", source) is not None, "Missing immutable suite source")
    manifest, binary = directory / "manifest.json", directory / "nelcota"
    require(not directory.is_symlink() and directory.is_dir() and not manifest.is_symlink() and manifest.is_file()
            and manifest.stat().st_size <= 16384, "Missing bounded suite artifact manifest")
    value = json.loads(manifest.read_text())
    require(isinstance(value, dict) and set(value) == {"schema", "source_commit", "binary_sha256", "size_bytes", "build", "scope"},
            "Unknown suite manifest structure")
    require(type(value.get("schema")) is int and value["schema"] == 1 and value.get("source_commit") == source
            and isinstance(value.get("binary_sha256"), str) and re.fullmatch("[0-9a-f]{64}", value["binary_sha256"]) is not None,
            "Suite source or digest is invalid")
    require(not binary.is_symlink() and binary.is_file() and 4 <= binary.stat().st_size <= MAXIMUM_BYTES
            and binary.stat().st_size == value.get("size_bytes"), "Suite binary exceeds its artifact boundary")
    with binary.open("rb") as stream:
        require(stream.read(4) == b"\x7fELF", "Suite input is not a native ELF")
    require(digest(binary) == value["binary_sha256"], "Suite binary digest differs from its frozen build")
    return value


def build_context():
    def version(arguments):
        return subprocess.check_output(arguments, text=True, timeout=10).strip()[:1024]
    require(version(["git", "rev-parse", "HEAD"]) == os.environ["GITHUB_SHA"], "Checkout source differs from the suite")
    require(not version(["git", "status", "--porcelain"]), "Suite build requires a clean checkout")
    return {"rustc": version(["rustc", "--version", "--verbose"]), "cargo": version(["cargo", "--version"]),
            "cargo_lock_sha256": digest(ROOT / "Cargo.lock"), "workspace_manifest_sha256": digest(ROOT / "Cargo.toml"),
            "command": ["cargo", "build", "--locked", "--release", "-p", "nelcota-server"],
            "cargo_build_jobs": 2, "release_profile": {"lto": "thin", "codegen_units": 1},
            "environment_override_names": sorted(key for key in os.environ if os.environ[key] and
                                                 (key in {"RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_BUILD_RUSTFLAGS", "CARGO_BUILD_TARGET"}
                                                  or key.startswith("CARGO_PROFILE_RELEASE_") or key.startswith("CARGO_TARGET_") and key.endswith("_RUSTFLAGS")))}


def freeze(binary, directory, source):
    require(not directory.exists() and not directory.is_symlink(), "Preserve previous suite input")
    require(not binary.is_symlink() and binary.is_file() and 4 <= binary.stat().st_size <= MAXIMUM_BYTES,
            "Missing bounded release binary")
    context = build_context()
    require(not context["environment_override_names"], "Suite profile has undeclared compiler overrides")
    directory.mkdir(parents=True)
    target = directory / "nelcota"
    shutil.copyfile(binary, target)
    target.chmod(0o555)
    manifest = {"schema": 1, "source_commit": source, "binary_sha256": digest(target),
                "size_bytes": target.stat().st_size, "build": context,
                "scope": "One retained ELF for all native-suite cases and both independent passes; no release publication"}
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2, allow_nan=False) + "\n")
    return artifact(directory, source)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["freeze", "verify"])
    parser.add_argument("directory", type=Path)
    parser.add_argument("--binary", type=Path)
    args = parser.parse_args()
    require(os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted",
            "Native suite artifacts require their disposable Actions VM")
    source = os.environ.get("GITHUB_SHA", "")
    result = None
    if args.mode == "freeze":
        require(args.binary is not None, "Missing release binary")
        result = freeze(args.binary, args.directory, source)
    if args.mode == "verify":
        result = artifact(args.directory, source)
    print("::notice title=Native suite frozen artifact::" + json.dumps({key: result[key] for key in ["source_commit", "binary_sha256", "size_bytes"]}, separators=(",", ":")))


if __name__ == "__main__":
    main()
