#!/usr/bin/env python3
"""Run the MEGA RECORDER readiness checks and preserve their JSON contract."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from bootstrap import valid_repo


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def parse_last_json(stdout: str) -> dict[str, Any] | None:
    for line in reversed([line.strip() for line in stdout.splitlines() if line.strip()]):
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    return None


def run_json(command: list[str], cwd: Path | None = None) -> tuple[int, dict[str, Any] | None, str]:
    completed = subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    return completed.returncode, parse_last_json(completed.stdout), completed.stderr.strip()


def main() -> int:
    parser = argparse.ArgumentParser(description="Run local MEGA RECORDER doctor checks")
    parser.add_argument("--repo", required=True, help="product checkout path returned by bootstrap.py")
    parser.add_argument("--json", action="store_true", help="kept for explicit machine-readable invocation")
    args = parser.parse_args()
    repo = Path(args.repo).expanduser().resolve()
    if not valid_repo(repo):
        emit(
            {
                "ok": False,
                "command": "doctor",
                "repo": str(repo),
                "error": {"code": "PRODUCT_REPO_INVALID", "message": "Product CLI was not found."},
            }
        )
        return 1

    native_setup: dict[str, Any]
    native_setup_stderr = ""
    native_setup_script = Path(__file__).resolve().parent / "native_setup.py"
    if native_setup_script.is_file():
        _, native_setup_value, native_setup_stderr = run_json(
            [sys.executable, str(native_setup_script), "--repo", str(repo), "--json"]
        )
        native_setup = native_setup_value or {
            "ok": False,
            "command": "native-setup",
            "error": {
                "code": "NATIVE_SETUP_INVALID_OUTPUT",
                "message": native_setup_stderr or "Native setup did not return JSON.",
            },
        }
    else:
        native_setup = {
            "ok": False,
            "command": "native-setup",
            "error": {
                "code": "NATIVE_SETUP_MISSING",
                "message": "The native payload verifier is not present in this skill checkout.",
            },
        }

    environment = os.environ.copy()
    environment.setdefault("MEGA_RECORDER_NO_NETWORK", "1")
    try:
        completed = subprocess.run(
            ["node", "scripts/mega-recorder-cli.mjs", "doctor"],
            cwd=str(repo),
            env=environment,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as error:
        emit(
            {
                "ok": False,
                "command": "doctor",
                "repo": str(repo),
                "error": {"code": "NODE_UNAVAILABLE", "message": str(error)},
            }
        )
        return 1

    product = parse_last_json(completed.stdout)
    if product is None:
        emit(
            {
                "ok": False,
                "command": "doctor",
                "repo": str(repo),
                "error": {
                    "code": "DOCTOR_INVALID_OUTPUT",
                    "message": completed.stderr.strip() or "Product doctor did not return JSON.",
                },
            }
        )
        return 1

    emit(
        {
            "ok": completed.returncode == 0 and product.get("ok") is True,
            "command": "doctor",
            "repo": str(repo),
            "ready": bool(product.get("ready")),
            "checks": product.get("checks", {}),
            "upstream": product.get("upstream", {}),
            "nativeSetup": native_setup,
            "nativeCapture": "verified-payload" if native_setup.get("ready") else "unverified",
            "nativeExport": "verified-payload" if native_setup.get("ready") else "unverified",
            "product": product,
            **(
                {"stderr": completed.stderr.strip()}
                if completed.stderr.strip()
                else {}
            ),
            **(
                {"nativeSetupStderr": native_setup_stderr}
                if native_setup_stderr
                else {}
            ),
        }
    )
    return 0 if completed.returncode == 0 and product.get("ok") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
