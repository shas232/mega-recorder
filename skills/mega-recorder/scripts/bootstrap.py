#!/usr/bin/env python3
"""Locate or bootstrap a MEGA RECORDER checkout for the Codex skill.

The helper is intentionally deterministic and machine-neutral. It never embeds a
user's absolute path in the skill: callers may set MEGA_RECORDER_HOME, or the
helper discovers a checkout and otherwise clones the pinned upstream source into
an ordinary per-user data directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Iterable


COMMAND = "bootstrap"
PRODUCT_URL = "https://github.com/shas232/mega-recorder.git"
# The published MEGA RECORDER release. A caller may explicitly override the ref.
PRODUCT_REF = "v0.1.2"
PRODUCT_BRANCH = "main"
PRODUCT_PATCH = Path(__file__).resolve().parents[1] / "assets" / "mega-recorder-product.patch"


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def valid_repo(candidate: Path) -> bool:
    return (
        candidate.is_dir()
        and (candidate / "package.json").is_file()
        and (candidate / "scripts" / "mega-recorder-cli.mjs").is_file()
    )


def absolute(value: str | Path) -> Path:
    return Path(value).expanduser().resolve()


def config_path() -> Path:
    return Path(__file__).resolve().parents[1] / "config.json"


def read_config() -> dict[str, Any]:
    try:
        value = json.loads(config_path().read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def candidates(explicit: str | None, config: dict[str, Any]) -> Iterable[tuple[str, Path]]:
    seen: set[Path] = set()

    def add(source: str, value: str | Path | None) -> Iterable[tuple[str, Path]]:
        if not value:
            return ()
        path = absolute(value)
        if path in seen:
            return ()
        seen.add(path)
        return ((source, path),)

    yield from add("argument", explicit)
    yield from add("env", os.environ.get("MEGA_RECORDER_HOME"))
    yield from add("config", config.get("productRepo"))

    current = Path.cwd().resolve()
    for parent in (current, *current.parents):
        yield from add("cwd", parent)

    home = Path.home()
    for relative in (
        "MEGA RECORDER",
        "mega-recorder",
        "Documents/MEGA RECORDER",
        "Desktop/MEGA RECORDER",
        "Projects/MEGA RECORDER",
        ".local/share/mega-recorder/openscreen",
        ".cache/mega-recorder/openscreen",
    ):
        yield from add("home", home / relative)


def run_git(args: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd) if cwd else None,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def apply_product_delta(stage: Path) -> tuple[bool, dict[str, Any]]:
    """Apply the product layer when the upstream checkout has no published product ref."""
    if not PRODUCT_PATCH.is_file():
        return False, {
            "code": "PRODUCT_PATCH_MISSING",
            "message": f"Bundled product patch is missing: {PRODUCT_PATCH.name}",
        }

    base_fetch = run_git(["fetch", "--depth", "1", "origin", PRODUCT_REF], stage)
    if base_fetch.returncode != 0:
        return False, {
            "code": "PRODUCT_BASE_UNAVAILABLE",
            "message": base_fetch.stderr.strip() or f"Unable to fetch product base {PRODUCT_REF}",
        }
    checkout = run_git(["checkout", "--detach", "FETCH_HEAD"], stage)
    if checkout.returncode != 0:
        return False, {
            "code": "PRODUCT_BASE_CHECKOUT_FAILED",
            "message": checkout.stderr.strip() or "Unable to checkout product base",
        }
    applied = run_git(["apply", "--binary", str(PRODUCT_PATCH)], stage)
    if applied.returncode != 0:
        return False, {
            "code": "PRODUCT_PATCH_FAILED",
            "message": applied.stderr.strip() or "Unable to apply bundled product patch",
            "baseRef": PRODUCT_REF,
        }
    if not valid_repo(stage):
        return False, {
            "code": "PRODUCT_PATCH_INCOMPATIBLE",
            "message": "Bundled product patch did not produce a valid MEGA RECORDER checkout.",
            "baseRef": PRODUCT_REF,
        }
    patch_hash = hashlib.sha256(PRODUCT_PATCH.read_bytes()).hexdigest()
    return True, {
        "source": "bootstrapped-patched",
        "created": True,
        "ref": PRODUCT_REF,
        "productPatch": PRODUCT_PATCH.name,
        "productPatchSha256": patch_hash,
    }


def bootstrap_repo(root: Path, url: str, ref: str, branch: str) -> tuple[Path | None, dict[str, Any]]:
    root = absolute(root)
    destination = root / "openscreen"
    root.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if valid_repo(destination):
            return destination, {"source": "bootstrap-existing", "created": False}
        return None, {
            "code": "BOOTSTRAP_DESTINATION_EXISTS",
            "message": f"Refusing to overwrite non-product path: {destination}",
        }

    stage = Path(tempfile.mkdtemp(prefix="mega-recorder-bootstrap-", dir=str(root)))
    shutil.rmtree(stage)
    try:
        clone = run_git(["clone", "--filter=blob:none", "--no-checkout", url, str(stage)])
        if clone.returncode != 0:
            return None, {
                "code": "BOOTSTRAP_CLONE_FAILED",
                "message": clone.stderr.strip() or "git clone failed",
            }

        requested_ref = ref or branch
        fetch = run_git(["fetch", "--depth", "1", "origin", requested_ref], stage)
        selected_ref = requested_ref
        if fetch.returncode != 0 and branch and requested_ref != branch:
            fetch = run_git(["fetch", "--depth", "1", "origin", branch], stage)
            selected_ref = branch
        if fetch.returncode != 0 and ref != PRODUCT_REF:
            fetch = run_git(["fetch", "--depth", "1", "origin", PRODUCT_REF], stage)
            selected_ref = PRODUCT_REF
        if fetch.returncode != 0:
            return None, {
                "code": "BOOTSTRAP_REF_UNAVAILABLE",
                "message": fetch.stderr.strip() or f"Unable to fetch {requested_ref}",
            }
        checkout = run_git(["checkout", "--detach", "FETCH_HEAD"], stage)
        if checkout.returncode != 0:
            return None, {
                "code": "BOOTSTRAP_CHECKOUT_FAILED",
                "message": checkout.stderr.strip() or "git checkout failed",
            }
        details: dict[str, Any] = {"source": "bootstrapped", "created": True, "ref": selected_ref}
        if not valid_repo(stage):
            patched, patch_details = apply_product_delta(stage)
            if not patched:
                return None, {
                    "code": "BOOTSTRAP_INCOMPATIBLE",
                    "message": "Pinned source does not include scripts/mega-recorder-cli.mjs and its product delta could not be applied.",
                    "ref": selected_ref,
                    "details": patch_details,
                }
            details = patch_details
        stage.rename(destination)
        return destination, details
    finally:
        if stage.exists():
            shutil.rmtree(stage, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Locate or bootstrap a MEGA RECORDER checkout")
    parser.add_argument("--repo", help="explicit product checkout path")
    parser.add_argument("--root", help="bootstrap root (defaults to a user-local data directory)")
    parser.add_argument("--url", default=os.environ.get("MEGA_RECORDER_REPOSITORY", PRODUCT_URL))
    parser.add_argument("--ref", default=os.environ.get("MEGA_RECORDER_REF", PRODUCT_BRANCH))
    parser.add_argument("--no-bootstrap", action="store_true")
    parser.add_argument("--force-bootstrap", action="store_true", help="skip discovery and create a fresh checkout under --root")
    parser.add_argument("--json", action="store_true", help="kept for explicit machine-readable invocation")
    args = parser.parse_args()
    config = read_config()

    if not args.force_bootstrap:
        for source, candidate in candidates(args.repo, config):
            if valid_repo(candidate):
                emit(
                    {
                        "ok": True,
                        "command": COMMAND,
                        "repo": str(candidate),
                        "source": source,
                        "created": False,
                        "productCli": str(candidate / "scripts" / "mega-recorder-cli.mjs"),
                    }
                )
                return 0

    if args.no_bootstrap:
        emit(
            {
                "ok": False,
                "command": COMMAND,
                "error": {
                    "code": "PRODUCT_REPO_NOT_FOUND",
                    "message": "No MEGA RECORDER checkout was found and bootstrapping was disabled.",
                },
            }
        )
        return 1

    configured_root = config.get("bootstrapRoot")
    root = absolute(args.root or os.environ.get("MEGA_RECORDER_BOOTSTRAP_ROOT") or configured_root or Path.home() / ".local" / "share" / "mega-recorder")
    repo, details = bootstrap_repo(root, args.url, args.ref, PRODUCT_BRANCH)
    if repo is None:
        emit({"ok": False, "command": COMMAND, "error": details})
        return 1
    emit(
        {
            "ok": True,
            "command": COMMAND,
            "repo": str(repo),
            **details,
            "productCli": str(repo / "scripts" / "mega-recorder-cli.mjs"),
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
