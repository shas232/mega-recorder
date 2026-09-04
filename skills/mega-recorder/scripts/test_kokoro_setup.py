#!/usr/bin/env python3
"""Unit tests for the local Kokoro bootstrap interpreter selection."""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("kokoro_setup.py")
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("kokoro_setup", SCRIPT)
assert SPEC and SPEC.loader
kokoro_setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(kokoro_setup)


def supported_base() -> str | None:
    for name in ("python3.11", "python3.12", "python3.13"):
        candidate = shutil.which(name)
        if candidate:
            details = kokoro_setup.probe_python(candidate)
            if details and details.get("version", [0, 0])[1] in kokoro_setup.SUPPORTED_PYTHON_MINORS:
                return candidate
    return None


class KokoroSetupTests(unittest.TestCase):
    def test_preference_excludes_host_python_3_14_until_supported_versions_are_unavailable(self) -> None:
        candidates = kokoro_setup.python_candidates({})
        self.assertEqual(candidates[:3], ["python3.11", "python3.12", "python3.13"])
        self.assertNotEqual(candidates[0], "python3")

    @unittest.skipUnless(supported_base(), "a supported Python interpreter is required")
    def test_configured_venv_symlink_path_is_not_resolved_to_homebrew(self) -> None:
        base = supported_base()
        assert base
        with tempfile.TemporaryDirectory(prefix="mega-recorder-kokoro-test-") as temporary:
            venv = Path(temporary) / "venv"
            subprocess.run([base, "-m", "venv", str(venv)], check=True)
            executable = venv / "bin" / "python"
            self.assertTrue(executable.is_file())
            configured = str(executable)
            self.assertEqual(kokoro_setup.preserve_executable_path(configured), configured)

            selected, error = kokoro_setup.create_runtime(
                {"MEGA_RECORDER_KOKORO_PYTHON": configured}, Path(temporary) / "unused"
            )

            self.assertIsNone(error)
            self.assertEqual(selected, configured)
            self.assertTrue(kokoro_setup.probe_python(selected)["inVenv"])

    @unittest.skipUnless(shutil.which("python3.14"), "Python 3.14 is required to exercise venv replacement")
    @unittest.skipUnless(supported_base(), "a supported Python interpreter is required")
    def test_existing_python_3_14_venv_is_rebuilt_with_supported_interpreter(self) -> None:
        base = supported_base()
        py314 = shutil.which("python3.14")
        assert base and py314
        with tempfile.TemporaryDirectory(prefix="mega-recorder-kokoro-test-") as temporary:
            root = Path(temporary) / "kokoro"
            subprocess.run([py314, "-m", "venv", str(root)], check=True)
            selected, error = kokoro_setup.create_runtime({}, root)

            self.assertIsNone(error)
            self.assertEqual(kokoro_setup.probe_python(selected)["version"][1], int(base.split("python3.")[-1]))
            self.assertTrue(kokoro_setup.probe_python(selected)["inVenv"])

    def test_pep_668_failure_has_isolated_venv_message(self) -> None:
        failed = subprocess.CompletedProcess(
            args=["python", "-m", "pip"],
            returncode=1,
            stdout="",
            stderr="error: externally-managed-environment (PEP 668)",
        )
        with patch.object(kokoro_setup.subprocess, "run", return_value=failed):
            installed, error = kokoro_setup.install_runtime("/opt/homebrew/bin/python3")

        self.assertFalse(installed)
        self.assertIn("externally managed", error)
        self.assertIn("isolated venv", error)
        self.assertIn("Python 3.11 or 3.12", error)

    def test_python_3_14_failure_has_version_message(self) -> None:
        failed = subprocess.CompletedProcess(
            args=["python3.14", "-m", "pip"],
            returncode=1,
            stdout="building cp314 spacy thinc blis",
            stderr="failed to build cp314 wheel",
        )
        with patch.object(kokoro_setup.subprocess, "run", return_value=failed):
            installed, error = kokoro_setup.install_runtime("/tmp/kokoro-venv/bin/python")

        self.assertFalse(installed)
        self.assertIn("not compatible with Python 3.14", error)
        self.assertIn("Python 3.11 or 3.12", error)


if __name__ == "__main__":
    unittest.main()
