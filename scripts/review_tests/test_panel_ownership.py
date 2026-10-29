"""Prevent loose modules, reverse page dependencies and stale browser probes."""

import importlib.util
from pathlib import Path
import tempfile
import unittest


class PanelOwnership(unittest.TestCase):
    def setUp(self):
        script = Path(__file__).resolve().parents[1] / "check-boundaries.py"
        spec = importlib.util.spec_from_file_location("panel_boundaries", script)
        self.checker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.checker)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.lib = self.root / "crates/admin/ui/src/lib"
        self.lib.mkdir(parents=True)

    def write(self, name, text):
        path = self.lib / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def test_features_use_shared_interfaces_without_reverse_dependencies(self):
        self.write(
            "transport/api.ts",
            "import { session } from '$lib/resources/session.svelte'\n",
        )
        self.write("resources/session.svelte.ts", "export const session = {}\n")
        self.write(
            "features/orders/api.ts", "import { api } from '$lib/transport/api'\n"
        )
        self.assertEqual(self.checker.panel_ownership(self.root), [])

    def test_root_source_and_unowned_directories_are_rejected(self):
        self.write("helper.ts", "export const value = 1\n")
        self.write("misc/helper.ts", "export const value = 1\n")
        errors = self.checker.panel_ownership(self.root)
        self.assertTrue(any("helper.ts" in error for error in errors))
        self.assertTrue(any("misc" in error for error in errors))

    def test_alias_relative_type_and_dynamic_page_imports_are_rejected(self):
        for statement in [
            "import { session } from '$lib/features/auth/session.svelte'",
            "import {\n session,\n} from '../features/auth/session.svelte'",
            "export type { Session } from '$lib/features/auth/session.svelte'",
            "const page = () => import('$lib/shell/app.svelte')",
        ]:
            with self.subTest(statement=statement):
                self.write("resources/session.ts", statement)
                errors = self.checker.panel_ownership(self.root)
                self.assertTrue(
                    any("depends on a page" in error for error in errors), errors
                )

    def test_browser_probe_tracks_a_real_source_module(self):
        probe = self.root / "crates/admin/ui/e2e/lifetime.spec.ts"
        probe.parent.mkdir()
        probe.write_text(
            "const url = new URL('/admin/src/lib/transport/api.ts', location.href)\n"
        )
        self.assertTrue(
            any(
                "missing module" in error
                for error in self.checker.panel_ownership(self.root)
            )
        )
        self.write("transport/api.ts", "export const api = {}\n")
        self.assertEqual(self.checker.panel_ownership(self.root), [])


if __name__ == "__main__":
    unittest.main()
