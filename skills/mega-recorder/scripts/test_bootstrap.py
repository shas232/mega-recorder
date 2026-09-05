#!/usr/bin/env python3
"""Unit tests for release-aware, non-destructive product discovery."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("bootstrap.py")
SPEC = importlib.util.spec_from_file_location("mega_recorder_bootstrap", SCRIPT)
assert SPEC and SPEC.loader
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


def make_checkout(root: Path, release: str) -> Path:
    files = {
        "package.json": "{}\n",
        "scripts/mega-recorder-cli.mjs": "doctor preset kokoro verify\n",
        "scripts/mega-recorder/preset.mjs": "export {};\n",
        "scripts/mega-recorder/verify.mjs": "export {};\n",
        "scripts/mega-recorder/kokoro.mjs": "resolveDefaultVoice synthesizeWithKokoro\n",
        "scripts/mega-recorder/kokoro_runtime.py": "# local runtime\n",
        "scripts/mega-recorder/browser-editor-server.mjs": "export {};\n",
        "src/lib/ai-edition/crop.ts": "normalizeCropRegion applyCropToDocument\n",
        "scripts/mega-recorder/crop.mjs": "export function normalizeCropRegion() {}\nexport function applyCropToDocument() {}\n",
        "scripts/mega-recorder/scenes.mjs": "export function applyScenesToDocument() {}\nexport function reviseSceneInManifest() {}\n",
        "scripts/mega-recorder/actions.mjs": "sceneId\n",
        "schemas/mega-recorder-action-manifest.schema.json": '{"properties":{"sceneId":{"type":"string"}}}\n',
        "scripts/mega-recorder/recording-clock.mjs": "readRecordingClock timestampFromRecordingClock\n",
        "mega-recorder.manifest.json": json.dumps({"productRelease": release}) + "\n",
    }
    for relative, content in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    return root


class BootstrapTests(unittest.TestCase):
    def test_pins_next_product_release(self) -> None:
        self.assertEqual(bootstrap.PRODUCT_REF, "v0.3.2")

    def test_rejects_old_release_even_when_file_shape_matches(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mega-recorder-bootstrap-test-") as temporary:
            checkout = make_checkout(Path(temporary), "v0.3.0")
            assessment = bootstrap.inspect_repo(checkout)
            self.assertFalse(assessment["compatible"])
            self.assertIn("compatible ref", assessment["reason"])
            self.assertEqual(assessment["release"], "v0.3.0")

    def test_accepts_dirty_compatible_checkout_without_touching_it(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mega-recorder-bootstrap-test-") as temporary:
            checkout = make_checkout(Path(temporary), "v0.3.2")
            subprocess.run(["git", "init", "-q"], cwd=checkout, check=True)
            subprocess.run(["git", "add", "."], cwd=checkout, check=True)
            subprocess.run(
                ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "test"],
                cwd=checkout,
                check=True,
            )
            marker = checkout / "user-change.txt"
            marker.write_text("keep me\n", encoding="utf-8")
            assessment = bootstrap.inspect_repo(checkout)
            self.assertTrue(assessment["compatible"])
            self.assertTrue(assessment["dirty"])
            self.assertTrue(marker.is_file())

    def test_clean_checkout_cannot_claim_latest_release_with_a_stale_marker(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mega-recorder-bootstrap-test-") as temporary:
            checkout = make_checkout(Path(temporary), "v0.3.2")
            subprocess.run(["git", "init", "-q"], cwd=checkout, check=True)
            subprocess.run(["git", "add", "."], cwd=checkout, check=True)
            subprocess.run(
                ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "test"],
                cwd=checkout,
                check=True,
            )
            assessment = bootstrap.inspect_repo(checkout)
            self.assertFalse(assessment["compatible"])
            self.assertIn("compatible ref", assessment["reason"])

    def test_old_destination_gets_isolated_sibling(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mega-recorder-bootstrap-test-") as temporary:
            root = Path(temporary)
            old = make_checkout(root / "openscreen", "v0.3.0")
            destination, details = bootstrap.choose_destination(root, "v0.3.2", False)
            self.assertEqual(destination, root / "openscreen-v0.3.2")
            self.assertTrue(old.is_dir())
            self.assertTrue(details["isolated"])
            self.assertEqual(details["preservedPath"], str(old))

    def test_force_bootstrap_uses_default_destination_when_empty(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mega-recorder-bootstrap-test-") as temporary:
            root = Path(temporary)
            destination, details = bootstrap.choose_destination(root, "v0.3.2", True)
            self.assertEqual(destination, root / "openscreen")
            self.assertEqual(details, {})

    def test_explicit_old_checkout_defaults_to_adjacent_bootstrap_root(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mega-recorder-bootstrap-test-") as temporary:
            old = make_checkout(Path(temporary) / "old-openscreen", "v0.3.0")
            args = type("BootstrapArgs", (), {"root": None, "repo": str(old)})()
            self.assertEqual(bootstrap.bootstrap_root(args, {}), Path(temporary).resolve())

    def test_explicit_bootstrap_root_wins_over_adjacent_checkout(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mega-recorder-bootstrap-test-") as temporary:
            root = Path(temporary)
            old = make_checkout(root / "old-openscreen", "v0.3.0")
            configured = root / "configured"
            args = type("BootstrapArgs", (), {"root": str(configured), "repo": str(old)})()
            self.assertEqual(bootstrap.bootstrap_root(args, {}), configured.resolve())


if __name__ == "__main__":
    unittest.main()
