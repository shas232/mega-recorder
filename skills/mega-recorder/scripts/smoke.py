#!/usr/bin/env python3
"""Smoke-test discovery and, optionally, a fresh base-plus-product bootstrap."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from bootstrap import PRODUCT_REF, valid_repo


SCRIPT_ROOT = Path(__file__).resolve().parent


def run_json(command: list[str], cwd: Path | None = None) -> tuple[int, dict[str, Any] | None, str]:
    completed = subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    value: dict[str, Any] | None = None
    for line in reversed([line.strip() for line in completed.stdout.splitlines() if line.strip()]):
        try:
            decoded = json.loads(line)
        except ValueError:
            continue
        if isinstance(decoded, dict):
            value = decoded
            break
    return completed.returncode, value, completed.stderr.strip()


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke-test MEGA Recorder skill helpers")
    parser.add_argument("--repo", help="existing product checkout to smoke-test")
    parser.add_argument("--fresh", action="store_true", help="clone a source into a temporary checkout and apply the bundled delta")
    parser.add_argument("--source-repo", help="source checkout used to create a temporary local bare remote")
    parser.add_argument("--json", action="store_true", help="kept for explicit machine-readable invocation")
    args = parser.parse_args()

    bootstrap_command = [sys.executable, str(SCRIPT_ROOT / "bootstrap.py")]
    details: dict[str, Any] = {"ok": False, "command": "smoke", "fresh": args.fresh}
    with tempfile.TemporaryDirectory(prefix="mega-recorder-smoke-") as temporary:
        temporary_root = Path(temporary)
        if args.fresh:
            source = Path(args.source_repo or args.repo or Path.cwd()).expanduser().resolve()
            if not valid_repo(source):
                details["error"] = {"code": "SOURCE_REPO_INVALID", "message": str(source)}
                print(json.dumps(details, separators=(",", ":")))
                return 1
            bare = temporary_root / "source.git"
            cloned = subprocess.run(
                ["git", "clone", "--bare", str(source), str(bare)],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            if cloned.returncode != 0:
                details["error"] = {"code": "SOURCE_CLONE_FAILED", "message": cloned.stderr.strip() or "git clone failed"}
                print(json.dumps(details, separators=(",", ":")))
                return 1
            bootstrap_command.extend(
                [
                    "--root",
                    str(temporary_root / "install"),
                    "--url",
                    str(bare),
                    "--ref",
                    PRODUCT_REF,
                    "--force-bootstrap",
                    "--json",
                ]
            )
        else:
            if not args.repo:
                details["error"] = {"code": "REPO_REQUIRED", "message": "Use --repo or --fresh --source-repo."}
                print(json.dumps(details, separators=(",", ":")))
                return 1
            bootstrap_command.extend(["--repo", args.repo, "--no-bootstrap", "--json"])

        code, bootstrap, stderr = run_json(bootstrap_command)
        details["bootstrap"] = bootstrap
        if stderr:
            details["bootstrapStderr"] = stderr
        if code != 0 or not bootstrap or bootstrap.get("ok") is not True:
            details["error"] = {"code": "BOOTSTRAP_SMOKE_FAILED", "message": "bootstrap helper failed"}
            print(json.dumps(details, separators=(",", ":")))
            return 1

        repo = Path(str(bootstrap["repo"]))
        if not valid_repo(repo):
            details["error"] = {"code": "BOOTSTRAP_PRODUCT_INVALID", "message": str(repo)}
            print(json.dumps(details, separators=(",", ":")))
            return 1
        doctor_code, doctor, doctor_stderr = run_json(
            [sys.executable, str(SCRIPT_ROOT / "doctor.py"), "--repo", str(repo), "--json"]
        )
        details["doctor"] = doctor
        if doctor_stderr:
            details["doctorStderr"] = doctor_stderr
        preset = subprocess.run(
            ["node", "scripts/mega-recorder-cli.mjs", "preset", "show", "blue-studio"],
            cwd=str(repo),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        details["presetOk"] = preset.returncode == 0
        if preset.returncode != 0:
            details["presetStderr"] = preset.stderr.strip()
        if doctor_code != 0 or not details["presetOk"]:
            details["error"] = {"code": "PRODUCT_SMOKE_FAILED", "message": "doctor or preset smoke failed"}
            print(json.dumps(details, separators=(",", ":")))
            return 1
        details["patched"] = args.fresh and bootstrap.get("source") == "bootstrapped-patched"
        if args.fresh and not details["patched"]:
            details["error"] = {"code": "PRODUCT_PATCH_NOT_EXERCISED", "message": "Fresh smoke did not use the bundled product delta."}
            print(json.dumps(details, separators=(",", ":")))
            return 1
        details["temporaryCheckoutRemoved"] = args.fresh
        details["ok"] = True
    print(json.dumps(details, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
