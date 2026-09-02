#!/usr/bin/env python3
"""Check or prepare the local/offline Kokoro runtime used by MEGA RECORDER.

Setup may install Python packages and fetch the model into a local Hugging Face
cache. Runtime synthesis remains offline; this helper never calls a hosted TTS
API and never sends narration text anywhere.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from bootstrap import valid_repo


MODEL_ID = "hexgrad/Kokoro-82M"
REQUIREMENTS = ("kokoro", "torch", "numpy", "soundfile", "misaki", "huggingface_hub")


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def last_json(stdout: str) -> dict[str, Any] | None:
    for line in reversed([line.strip() for line in stdout.splitlines() if line.strip()]):
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    return None


def run_product(repo: Path, args: list[str], environment: dict[str, str]) -> dict[str, Any] | None:
    try:
        completed = subprocess.run(
            ["node", "scripts/mega-recorder-cli.mjs", *args],
            cwd=str(repo),
            env=environment,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError:
        return None
    return last_json(completed.stdout)


def install_runtime(python: str) -> tuple[bool, str | None]:
    completed = subprocess.run(
        [python, "-m", "pip", "install", "--disable-pip-version-check", *REQUIREMENTS],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode == 0:
        return True, None
    return False, completed.stderr.strip() or "pip install failed"


def create_runtime(environment: dict[str, str], root: Path) -> tuple[str | None, str | None]:
    configured = environment.get("MEGA_RECORDER_KOKORO_PYTHON")
    if configured:
        python = str(Path(configured).expanduser().resolve())
        return python, None
    venv_root = root / "kokoro-venv"
    python = venv_root / "bin" / "python"
    if os.name == "nt":
        python = venv_root / "Scripts" / "python.exe"
    if not python.is_file():
        completed = subprocess.run(
            [sys.executable, "-m", "venv", str(venv_root)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if completed.returncode != 0:
            return None, completed.stderr.strip() or "python -m venv failed"
    return str(python), None


def download_model(python: str, cache_root: Path) -> tuple[str | None, str | None]:
    cache_root.mkdir(parents=True, exist_ok=True)
    script = (
        "from huggingface_hub import snapshot_download; "
        f"print(snapshot_download({MODEL_ID!r}, cache_dir={str(cache_root / 'hub')!r}))"
    )
    environment = os.environ.copy()
    environment.update(
        {
            "HF_HOME": str(cache_root),
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "MEGA_RECORDER_NO_NETWORK": "0",
        }
    )
    completed = subprocess.run(
        [python, "-c", script],
        env=environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        return None, completed.stderr.strip() or "model download failed"
    lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    return (lines[-1] if lines else None), None


def main() -> int:
    parser = argparse.ArgumentParser(description="Check or prepare local Kokoro")
    parser.add_argument("--repo", required=True, help="product checkout path")
    parser.add_argument("--ensure", action="store_true", help="install local dependencies and model when missing")
    parser.add_argument("--json", action="store_true", help="kept for explicit machine-readable invocation")
    args = parser.parse_args()
    repo = Path(args.repo).expanduser().resolve()
    if not valid_repo(repo):
        emit(
            {
                "ok": False,
                "command": "kokoro setup",
                "repo": str(repo),
                "error": {"code": "PRODUCT_REPO_INVALID", "message": "Product CLI was not found."},
            }
        )
        return 1

    environment = os.environ.copy()
    environment.setdefault("MEGA_RECORDER_NO_NETWORK", "1")
    before = run_product(repo, ["kokoro", "doctor"], environment)
    if before and before.get("ready") is True:
        emit(
            {
                "ok": True,
                "command": "kokoro setup",
                "repo": str(repo),
                "ready": True,
                "action": "already-ready",
                "doctor": before,
                "network": "synthesis-offline",
            }
        )
        return 0

    if not args.ensure:
        emit(
            {
                "ok": True,
                "command": "kokoro setup",
                "repo": str(repo),
                "ready": False,
                "action": "check-only",
                "doctor": before,
                "network": "synthesis-offline",
            }
        )
        return 0

    setup_root = Path(
        environment.get("MEGA_RECORDER_KOKORO_HOME")
        or Path.home() / ".local" / "share" / "mega-recorder" / "kokoro"
    ).expanduser().resolve()
    setup_root.mkdir(parents=True, exist_ok=True)
    python, error = create_runtime(environment, setup_root)
    actions: list[str] = []
    if python is None:
        emit(
            {
                "ok": False,
                "command": "kokoro setup",
                "repo": str(repo),
                "error": {"code": "KOKORO_SETUP_FAILED", "message": error or "runtime unavailable"},
            }
        )
        return 1

    runtime = before.get("runtime") if isinstance(before, dict) else None
    runtime_ready = isinstance(runtime, dict) and runtime.get("dependenciesAvailable") is True
    if not runtime_ready:
        installed, error = install_runtime(python)
        if not installed:
            emit(
                {
                    "ok": False,
                    "command": "kokoro setup",
                    "repo": str(repo),
                    "python": python,
                    "error": {"code": "KOKORO_SETUP_FAILED", "message": error or "runtime install failed"},
                }
            )
            return 1
        actions.append("installed-python-runtime")

    cache_root = Path(
        environment.get("MEGA_RECORDER_KOKORO_CACHE_ROOT")
        or Path.home() / ".cache" / "huggingface"
    ).expanduser().resolve()
    model_path, error = download_model(python, cache_root)
    if model_path is None:
        emit(
            {
                "ok": False,
                "command": "kokoro setup",
                "repo": str(repo),
                "python": python,
                "error": {"code": "KOKORO_MODEL_SETUP_FAILED", "message": error or "model cache unavailable"},
            }
        )
        return 1
    actions.append("cached-local-model")
    environment.update(
        {
            "MEGA_RECORDER_KOKORO_PYTHON": python,
            "MEGA_RECORDER_KOKORO_MODEL_CACHE": model_path,
            "HF_HOME": str(cache_root),
        }
    )
    after = run_product(repo, ["kokoro", "doctor"], environment)
    emit(
        {
            "ok": bool(after and after.get("ready") is True),
            "command": "kokoro setup",
            "repo": str(repo),
            "ready": bool(after and after.get("ready") is True),
            "python": python,
            "model": MODEL_ID,
            "modelCache": model_path,
            "actions": actions,
            "doctor": after,
            "network": "setup-download-only; synthesis-offline",
        }
    )
    return 0 if after and after.get("ready") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
