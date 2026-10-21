#!/usr/bin/env python3
"""Check current install guides against package metadata; exclude dated evidence."""
import json
import re
import sys
import tomllib
from pathlib import Path


def check(root: Path) -> list[str]:
    errors: list[str] = []
    client = json.loads((root / "sdk/typescript/package.json").read_text())
    npm_lock = json.loads((root / "sdk/typescript/package-lock.json").read_text())
    rust = tomllib.loads((root / "sdk/rust/Cargo.toml").read_text())["package"]
    cargo_lock = tomllib.loads((root / "Cargo.lock").read_text())
    workspace = tomllib.loads((root / "Cargo.toml").read_text())["workspace"]["package"]
    ts_version = client["version"]
    rust_version = rust["version"]
    readme = (root / "README.md").read_text()
    target = re.search(r"This source targets server \*\*(\d+\.\d+\.\d+)\*\*", readme)
    if target is None:
        return ["README.md: missing explicit source target version"]
    server = target[1]
    if server != workspace["version"]:
        errors.append("README.md: server target differs from workspace version")
    locked_server = [p["version"] for p in cargo_lock["package"] if p["name"] == "nelcota-server"]
    if locked_server != [workspace["version"]]:
        errors.append("Server workspace and Cargo.lock versions differ")

    if npm_lock["version"] != ts_version or npm_lock["packages"][""]["version"] != ts_version:
        errors.append("TypeScript package.json and package-lock.json versions differ")
    locked = [p["version"] for p in cargo_lock["package"] if p["name"] == "nelcota-client"]
    if locked != [rust_version]:
        errors.append("Rust SDK Cargo.toml and Cargo.lock versions differ")

    required = {
        "CHANGELOG.md": [f"## [{server}]"],
        "docs/quickstart.md": [f"This guide targets server {server}.", f"--tag v{server}", f"@nelcota/client@{ts_version}"],
        "docs/onboarding/notes.md": [f"NELCOTA_VERSION={server}", f"--version {server}"],
        "docs/releases/README.md": [f"This checkout targets server **{server}**", f"| {ts_version} |", f"| {rust_version} |"],
        "sdk/typescript/README.md": [f"@nelcota/client@{ts_version}", f"This guide targets {ts_version}."],
        "sdk/typescript/docs/quickstart.pt-BR.md": [f"@nelcota/client@{ts_version}", f"SDK **{ts_version}**"],
        "sdk/typescript/docs/contract.md": [f"This is the {ts_version} package contract."],
        "sdk/rust/README.md": [f'nelcota-client = "{rust_version}"', f"This guide targets {rust_version}."],
        "sdk/rust/docs/quickstart.pt-BR.md": [f'nelcota-client = "{rust_version}"', f"SDK **{rust_version}**"],
        "sdk/rust/docs/contract.md": [f"`nelcota-client` {rust_version} supports"],
    }
    for source, fragments in required.items():
        text = (root / source).read_text()
        for fragment in fragments:
            if fragment not in text:
                errors.append(f"{source}: expected {fragment!r}")

    for sdk, version in [("typescript", ts_version), ("rust", rust_version)]:
        source = f"sdk/{sdk}/CHANGELOG.md"
        first = re.search(r"^## (\d+\.\d+\.\d+) —", (root / source).read_text(), re.MULTILINE)
        if first is None or first[1] != version:
            errors.append(f"{source}: first version entry must be {version}")

    ledger = (root / "docs/goals/auth-security-review-execution.md").read_text()
    if "Status: finalized" in ledger:
        if "G06 is finalized" not in (root / "docs/goals/README.md").read_text():
            errors.append("Goals index does not reflect finalized G06 ledger")
        if "Status: finalized" not in (root / "docs/goals/auth-security-review.md").read_text():
            errors.append("G06 definition does not reflect finalized execution ledger")
    return errors


def main() -> int:
    try:
        errors = check(Path(__file__).resolve().parents[1])
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Cannot validate current version documentation: {error}", file=sys.stderr)
        return 1
    if errors:
        print("Current version documentation is inconsistent:\n" + "\n".join(errors), file=sys.stderr)
        return 1
    print("Current install guides, SDK manifests/locks/changelogs and G06 status agree.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
