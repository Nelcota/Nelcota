"""Check capability ownership and exact packaged migration assets (Python 3.11+)."""

from pathlib import Path
import re
import tomllib

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = {
    "core": set(),
    "deployment": set(),
    "auth": {"core"},
    "api": {"core", "auth"},
    "storage": {"core", "auth"},
    "webhooks": {"core"},
    "admin": {"deployment", "core", "auth", "api", "storage", "webhooks"},
    "cli": {"core", "auth", "api", "deployment"},
    "server": {"core", "auth", "api", "storage", "webhooks", "admin", "cli"},
}

PANEL_OWNERS = {
    "browser",
    "components",
    "contracts",
    "features",
    "formatting",
    "forms",
    "generated",
    "i18n",
    "navigation",
    "resources",
    "shared",
    "shell",
    "transport",
}
PANEL_FOUNDATIONS = PANEL_OWNERS - {"components", "features", "generated", "shell"}
MODULE_IMPORT = re.compile(
    r"(?m)^\s*(?:import|export)\s+(?:type\s+)?"
    r"(?:(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|[\w$]+(?:\s*,\s*\{[^}]*\})?)\s+from\s*)?"
    r"['\"]([^'\"]+)['\"]|\bimport\s*\(\s*['\"]([^'\"]+)['\"]"
)


def panel_ownership(root):
    """Keep shared modules independent of pages and direct browser probes valid."""
    errors = []
    ui = root / "crates/admin/ui"
    lib = ui / "src/lib"
    if lib.is_dir():
        for path in sorted(lib.iterdir()):
            if path.is_file() and path.suffix in {".ts", ".js", ".svelte"}:
                errors.append(
                    f"Panel module needs an owning directory: {path.relative_to(root)}"
                )
            if path.is_dir() and path.name not in PANEL_OWNERS:
                errors.append(
                    f"Panel directory needs an explicit owner: {path.relative_to(root)}"
                )
    for owner in sorted(PANEL_FOUNDATIONS):
        for path in sorted((lib / owner).rglob("*")):
            if not path.is_file() or path.suffix not in {".ts", ".js", ".svelte"}:
                continue
            for match in MODULE_IMPORT.finditer(path.read_text(encoding="utf-8")):
                name = next(value for value in match.groups() if value is not None)
                target = None
                if name.startswith("$lib/"):
                    target = lib / name[5:]
                if name.startswith(("./", "../")):
                    target = path.parent / name
                if target is None:
                    continue
                if any(
                    target.resolve().is_relative_to(lib / layer)
                    for layer in ("features", "shell")
                ):
                    errors.append(
                        f"Shared panel module depends on a page: {path.relative_to(root)} -> {name}"
                    )
    for path in sorted((ui / "e2e").glob("*.ts")):
        for name in re.findall(
            r"['\"]/admin/src/([^'\"]+)['\"]", path.read_text(encoding="utf-8")
        ):
            target = (ui / "src" / name).resolve()
            if not target.is_relative_to(ui / "src") or not target.is_file():
                errors.append(
                    f"Browser probe points to a missing module: {path.relative_to(root)} -> {name}"
                )
    return errors


def check():
    errors = []
    workspace = (
        tomllib.loads((ROOT / "Cargo.toml").read_text())
        .get("workspace", {})
        .get("dependencies", {})
    )
    declared = {path.parent.name for path in (ROOT / "crates").glob("*/Cargo.toml")}
    if declared != set(EXPECTED):
        errors.append("Capability manifests must have an explicit ownership contract")
    for capability, expected in EXPECTED.items():
        manifest = tomllib.loads(
            (ROOT / "crates" / capability / "Cargo.toml").read_text()
        )
        sections = [manifest.get("dependencies", {})]
        sections.extend(
            target.get("dependencies", {})
            for target in manifest.get("target", {}).values()
        )
        actual = set()
        for section in sections:
            for name, specification in section.items():
                if isinstance(specification, dict) and specification.get("workspace"):
                    specification = workspace.get(name, specification)
                package = name
                if isinstance(specification, dict):
                    package = specification.get("package", name)
                if package.startswith("nelcota-"):
                    actual.add(package.removeprefix("nelcota-"))
        if actual != expected:
            errors.append(
                f"{capability}: expected {sorted(expected)}, found {sorted(actual)}"
            )
    canonical = {
        path.name: path.read_bytes() for path in (ROOT / "migrations").glob("*.sql")
    }
    packaged = {
        path.name: path.read_bytes()
        for path in (ROOT / "crates/core/migrations").glob("*.sql")
    }
    if canonical != packaged:
        errors.append(
            "Packaged migrations differ from canonical migrations; copy new SQL without editing released files"
        )
    errors.extend(panel_ownership(ROOT))
    if errors:
        raise SystemExit("\n".join(errors))
    print(
        "Capability dependencies, panel ownership and packaged migration bytes match their contracts"
    )


if __name__ == "__main__":
    check()
