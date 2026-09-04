#!/usr/bin/env python3
"""Offline tests for native_setup.py's archive and verification guardrails."""

from __future__ import annotations

import hashlib
import stat
import tempfile
import unittest
import zipfile
from io import BytesIO
from pathlib import Path
from unittest import mock

import native_setup


class NativeSetupTests(unittest.TestCase):
    def config(self, root: Path) -> dict:
        return {
            "repository": "https://github.com/getopenscreen/openscreen",
            "release": "v-test",
            "archiveRoot": "Openscreen.app/Contents/Resources/electron/native/bin",
            "assets": {"darwin-arm64": {"name": "test.zip", "url": "https://example.invalid/test.zip", "sha256": ""}},
            "files": ["openscreen-screencapturekit-helper", "compositor_view.node"],
        }

    def archive(self, path: Path, tag: str = "darwin-arm64") -> None:
        root = f"Openscreen.app/Contents/Resources/electron/native/bin/{tag}"
        with zipfile.ZipFile(path, "w") as bundle:
            for name, body in {
                "openscreen-screencapturekit-helper": b"helper",
                "compositor_view.node": b"addon",
            }.items():
                info = zipfile.ZipInfo(f"{root}/{name}")
                info.external_attr = (stat.S_IFREG | 0o755) << 16
                bundle.writestr(info, body)

    @mock.patch.object(native_setup, "codesign_status", return_value={"checked": False, "valid": None})
    @mock.patch.object(native_setup, "host_tag", return_value=("darwin-arm64", {"platform": "darwin", "architecture": "arm64"}))
    def test_install_archive_writes_only_allowlisted_members_and_marker(self, _host, _codesign):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / "repo"
            (repo / "electron" / "native").mkdir(parents=True)
            (repo / "package.json").write_text("{}", encoding="utf-8")
            (repo / "LICENSE").write_text("MIT\n", encoding="utf-8")
            (repo / "THIRD-PARTY-NOTICES.md").write_text("notices\n", encoding="utf-8")
            archive = root / "test.zip"
            self.archive(archive)
            config = self.config(root)
            config["assets"]["darwin-arm64"]["sha256"] = hashlib.sha256(archive.read_bytes()).hexdigest()
            details = native_setup.install_archive(repo, "darwin-arm64", config, archive)
            destination = repo / "electron" / "native" / "bin" / "darwin-arm64"
            self.assertTrue(details["ready"])
            self.assertTrue((destination / native_setup.MARKER_NAME).is_file())
            self.assertEqual(sorted(p.name for p in destination.iterdir()), [".mega-recorder-native.json", "compositor_view.node", "openscreen-screencapturekit-helper"])

    def test_rejects_archive_path_traversal_and_symlinks(self):
        self.assertIsNone(native_setup.safe_member_path("/tmp/escape", "root"))
        self.assertIsNone(native_setup.safe_member_path("root/a/b", "root"))

    def test_download_archive_rejects_digest_mismatch_before_install(self):
        class Response(BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.close()

        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary)
            asset = {
                "name": "payload.zip",
                "url": "https://example.invalid/payload.zip",
                "sha256": "0" * 64,
            }
            with mock.patch.object(native_setup.urllib.request, "urlopen", return_value=Response(b"not the archive")):
                with self.assertRaisesRegex(RuntimeError, "digest mismatch"):
                    native_setup.download_archive(asset, cache)
            self.assertFalse((cache / "payload.zip").exists())

    @mock.patch.object(native_setup, "host_tag", return_value=(None, {"platform": "linux", "code": "NATIVE_PLATFORM_UNSUPPORTED"}))
    def test_status_reports_unsupported_host_without_touching_checkout(self, _host):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            (repo / "package.json").write_text("{}", encoding="utf-8")
            details = native_setup.status(repo, self.config(repo))
            self.assertFalse(details["ready"])
            self.assertFalse(details["supported"])
            self.assertEqual(details["error"]["code"], "NATIVE_PLATFORM_UNSUPPORTED")

    @mock.patch.object(native_setup, "codesign_status", return_value={"checked": False, "valid": None})
    def test_marker_hash_detects_tampering(self, _codesign):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / "repo"
            (repo / "electron" / "native").mkdir(parents=True)
            (repo / "package.json").write_text("{}", encoding="utf-8")
            (repo / "LICENSE").write_text("MIT\n", encoding="utf-8")
            (repo / "THIRD-PARTY-NOTICES.md").write_text("notices\n", encoding="utf-8")
            archive = root / "test.zip"
            self.archive(archive)
            config = self.config(root)
            details = native_setup.install_archive(repo, "darwin-arm64", config, archive)
            self.assertTrue(details["ready"])
            target = repo / "electron" / "native" / "bin" / "darwin-arm64" / "compositor_view.node"
            target.write_bytes(b"tampered")
            self.assertFalse(native_setup.file_status(target.parent, config, "darwin-arm64")["ready"])


if __name__ == "__main__":
    unittest.main()
