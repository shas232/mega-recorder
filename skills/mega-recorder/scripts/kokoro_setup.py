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
PREFERRED_PYTHON_MINORS = (11, 12)
FALLBACK_PYTHON_MINORS = (13,)
SUPPORTED_PYTHON_MINORS = PREFERRED_PYTHON_MINORS + FALLBACK_PYTHON_MINORS


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


def preserve_executable_path(value: str) -> str:
    """Make an executable path absolute without resolving symlinks.

    A venv's ``bin/python`` is commonly a symlink to the Homebrew interpreter.
    Resolving it changes Python's invocation path and can make setup install
    into the externally managed Homebrew environment instead of the venv.
    """

    expanded = os.path.expanduser(value)
    if os.sep not in expanded and (os.altsep is None or os.altsep not in expanded):
        return expanded
    return os.path.abspath(expanded)


def probe_python(python: str) -> dict[str, Any] | None:
    """Return version/venv metadata for an interpreter, or None if unavailable."""

    probe = (
        "import json, sys; "
        "print(json.dumps({"
        "'executable': sys.executable, "
        "'version': [sys.version_info.major, sys.version_info.minor, sys.version_info.micro], "
        "'prefix': sys.prefix, 'basePrefix': sys.base_prefix, "
        "'inVenv': sys.prefix != sys.base_prefix"
        "}))"
    )
    try:
        completed = subprocess.run(
            [python, "-c", probe],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError:
        return None
    if completed.returncode != 0:
        return None
    try:
        value = json.loads(completed.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def python_candidates(environment: dict[str, str]) -> list[str]:
    """List supported interpreter candidates in deterministic preference order."""

    configured = environment.get("MEGA_RECORDER_KOKORO_PYTHON")
    candidates: list[str] = []
    if configured:
        candidates.append(preserve_executable_path(configured))

    # Do not use sys.executable first: the host agent may itself be running on
    # Python 3.14, which is not compatible with the legacy packages pulled by
    # the current Kokoro dependency graph.
    candidates.extend(["python3.11", "python3.12", "python3.13"])
    virtual_env = environment.get("VIRTUAL_ENV")
    if virtual_env:
        candidates.extend(
            [
                preserve_executable_path(str(Path(virtual_env) / "bin" / "python")),
                preserve_executable_path(str(Path(virtual_env) / "bin" / "python3")),
            ]
        )
    candidates.extend(["python3", "python", sys.executable])

    seen: set[str] = set()
    result: list[str] = []
    for candidate in candidates:
        if candidate and candidate not in seen:
            seen.add(candidate)
            result.append(candidate)
    return result


def runtime_venv_root(root: Path) -> Path:
    """Return the exact venv directory selected by the caller."""

    # Keeping this as an identity function makes the path contract explicit and
    # prevents accidental symlink resolution or a second nested venv directory.
    return root


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
    output = "\n".join(part for part in (completed.stderr.strip(), completed.stdout.strip()) if part)
    lowered = output.lower()
    if "externally-managed-environment" in lowered or "externally managed" in lowered or "pep 668" in lowered:
        return False, (
            "Python rejected package installation as externally managed (PEP 668). "
            "MEGA RECORDER requires an isolated venv; the selected executable was "
            f"{python}. Recreate setup with a supported Python 3.11 or 3.12 interpreter."
        )
    if "python 3.14" in lowered or "cp314" in lowered:
        return False, (
            "Kokoro dependencies are not compatible with Python 3.14 because legacy "
            "spacy/thinc/blis packages require a supported wheel. Use Python 3.11 or 3.12."
        )
    return False, output[-8000:] if output else "pip install failed"


def create_runtime(environment: dict[str, str], root: Path) -> tuple[str | None, str | None]:
    candidates = python_candidates(environment)
    # A caller-supplied venv is authoritative, and must be returned exactly as
    # supplied (apart from lexical expansion). This is the critical symlink
    # case: Path.resolve() would turn venv/bin/python into Homebrew Python.
    configured = environment.get("MEGA_RECORDER_KOKORO_PYTHON")
    if configured:
        configured_python = preserve_executable_path(configured)
        details = probe_python(configured_python)
        if details and details.get("inVenv") and details.get("version", [0, 0])[1] in SUPPORTED_PYTHON_MINORS:
            return configured_python, None

    venv_root = runtime_venv_root(root)
    venv_python = venv_root / "bin" / "python"
    python = venv_root / "bin" / "python"
    if os.name == "nt":
        python = venv_root / "Scripts" / "python.exe"
        venv_python = venv_root / "Scripts" / "python.exe"

    # Reuse an existing supported venv, including when its executable is a
    # symlink to a system interpreter. Never resolve that path away.
    if venv_python.is_file():
        details = probe_python(str(venv_python))
        if details and details.get("inVenv") and details.get("version", [0, 0])[1] in SUPPORTED_PYTHON_MINORS:
            return str(venv_python), None

    existing_venv = (venv_root / "pyvenv.cfg").is_file()

    attempted: list[str] = []
    for candidate in candidates:
        details = probe_python(candidate)
        if not details:
            continue
        version = details.get("version", [0, 0])
        minor = version[1] if isinstance(version, list) and len(version) > 1 else None
        if minor not in SUPPORTED_PYTHON_MINORS:
            attempted.append(f"{candidate} (Python {version[0]}.{minor})")
            continue
        if not venv_root.exists():
            venv_root.parent.mkdir(parents=True, exist_ok=True)
        venv_args = [candidate, "-m", "venv"]
        if existing_venv:
            # A previous failed run may have left a Python 3.14 venv here.
            # Clear only the known venv target before rebuilding it with the
            # selected supported interpreter; never clear an arbitrary folder.
            venv_args.append("--clear")
        venv_args.append(str(venv_root))
        completed = subprocess.run(
            venv_args,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if completed.returncode != 0:
            attempted.append(f"{candidate} (venv creation failed: {completed.stderr.strip() or 'unknown error'})")
            continue
        created_details = probe_python(str(venv_python))
        if created_details and created_details.get("inVenv"):
            return str(venv_python), None
        attempted.append(f"{candidate} (created interpreter is not isolated)")

    if attempted:
        return None, (
            "No supported isolated Python runtime could be created. Tried: "
            + "; ".join(attempted)
            + ". Install Python 3.11 or 3.12 and retry."
        )
    return None, "No Python 3.11, 3.12, or compatible 3.13 interpreter was found on PATH."


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

    configured_home = environment.get("MEGA_RECORDER_KOKORO_HOME")
    setup_home = Path(configured_home or Path.home() / ".venvs" / "kokoro").expanduser().resolve()
    # The default is itself the well-known venv path searched by the Node
    # doctor. Older/custom callers can continue to use a broader setup home.
    setup_root = setup_home / "kokoro-venv" if configured_home else setup_home
    setup_root.parent.mkdir(parents=True, exist_ok=True)
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
    runtime_ready = (
        isinstance(runtime, dict)
        and runtime.get("dependenciesAvailable") is True
        and runtime.get("python") == python
    )
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
