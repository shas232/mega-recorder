#!/usr/bin/env python3
"""Locate or bootstrap a MEGA RECORDER checkout for the Codex skill.

The helper is intentionally deterministic and machine-neutral. It never embeds a
user's absolute path in the skill: callers may set MEGA_RECORDER_HOME, or the
helper discovers a checkout and otherwise clones the pinned upstream source into
an ordinary per-user data directory.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Iterable


COMMAND = "bootstrap"
PRODUCT_URL = "https://github.com/shas232/mega-recorder.git"
# The published MEGA RECORDER release. A caller may explicitly override the ref.
PRODUCT_REF = "v0.3.1"
PRODUCT_BRANCH = "main"

# A checkout is only useful to the skill when the product layer is present. Keep
# this list deliberately small and static: the check must be safe before npm
# dependencies or a Node runtime have been installed, and it must never execute
# arbitrary checkout code.
REQUIRED_CAPABILITIES: dict[str, dict[str, tuple[str, ...]]] = {
    "cli": {
        "files": ("scripts/mega-recorder-cli.mjs",),
        "markers": ("doctor", "preset", "kokoro", "verify"),
    },
    "preset": {"files": ("scripts/mega-recorder/preset.mjs",), "markers": ()},
    "verify": {"files": ("scripts/mega-recorder/verify.mjs",), "markers": ()},
    "kokoro": {
        "files": ("scripts/mega-recorder/kokoro.mjs", "scripts/mega-recorder/kokoro_runtime.py"),
        "markers": ("resolveDefaultVoice", "synthesizeWithKokoro"),
    },
    "editor": {"files": ("scripts/mega-recorder/browser-editor-server.mjs",), "markers": ()},
    "manifest": {"files": ("mega-recorder.manifest.json",), "markers": ()},
    "crop": {
        "files": ("src/lib/ai-edition/crop.ts", "scripts/mega-recorder/crop.mjs"),
        "markers": ("normalizeCropRegion", "applyCropToDocument"),
    },
    "scenes": {
        "files": (
            "scripts/mega-recorder/scenes.mjs",
            "scripts/mega-recorder/actions.mjs",
            "schemas/mega-recorder-action-manifest.schema.json",
        ),
        "markers": ("applyScenesToDocument", "reviseSceneInManifest"),
    },
    "recordingClock": {
        "files": ("scripts/mega-recorder/recording-clock.mjs",),
        "markers": ("readRecordingClock", "timestampFromRecordingClock"),
    },
}


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def valid_repo(candidate: Path) -> bool:
    return (
        candidate.is_dir()
        and (candidate / "package.json").is_file()
        and (candidate / "scripts" / "mega-recorder-cli.mjs").is_file()
    )


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def declared_product_ref(candidate: Path) -> str | None:
    """Read the product release marker without relying on package.json.

    OpenScreen's package version is the upstream app version (currently 1.10.0),
    not the MEGA RECORDER product release. The marker is therefore kept in the
    product manifest; the nested fallbacks let older manifests remain useful when
    an explicit git ref is supplied.
    """

    manifest = _read_json(candidate / "mega-recorder.manifest.json")
    if not manifest:
        return None
    for value in (
        manifest.get("productRelease"),
        manifest.get("productRef"),
        manifest.get("release"),
        (manifest.get("project") or {}).get("productRelease")
        if isinstance(manifest.get("project"), dict)
        else None,
    ):
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def capability_status(candidate: Path) -> dict[str, Any]:
    """Return static capability evidence for an existing checkout."""

    result: dict[str, Any] = {}
    for name, spec in REQUIRED_CAPABILITIES.items():
        missing_files = [relative for relative in spec["files"] if not (candidate / relative).is_file()]
        missing_markers: list[str] = []
        marker_file = candidate / spec["files"][0]
        if not missing_files and spec["markers"]:
            try:
                content = marker_file.read_text(encoding="utf-8")
            except OSError:
                content = ""
            missing_markers = [marker for marker in spec["markers"] if marker not in content]
        result[name] = {
            "ok": not missing_files and not missing_markers,
            "files": list(spec["files"]),
            "missingFiles": missing_files,
            "missingMarkers": missing_markers,
        }
    return result


def _git_value(repo: Path, args: list[str]) -> str | None:
    completed = run_git(args, repo)
    if completed.returncode != 0:
        return None
    return completed.stdout.strip()


def git_checkout_status(repo: Path) -> dict[str, Any]:
    """Collect read-only ref/dirty-worktree evidence for a checkout."""

    head = _git_value(repo, ["rev-parse", "HEAD"])
    branch = _git_value(repo, ["branch", "--show-current"])
    tags_text = _git_value(repo, ["tag", "--points-at", "HEAD"])
    status_text = _git_value(repo, ["status", "--porcelain", "--untracked-files=all"])
    return {
        "isGit": head is not None,
        "head": head,
        "branch": branch or None,
        "tags": [line for line in (tags_text or "").splitlines() if line],
        "dirty": bool(status_text),
        "changedFiles": len([line for line in (status_text or "").splitlines() if line]),
    }


def _resolved_git_ref(repo: Path, ref: str) -> str | None:
    raw_ref = ref[:-3] if ref.endswith("^{}") else ref
    candidates = [raw_ref]
    if raw_ref.startswith("refs/"):
        candidates.append(raw_ref)
    elif raw_ref.startswith("v"):
        candidates.append(f"refs/tags/{raw_ref}")
    else:
        candidates.extend((f"refs/heads/{raw_ref}", f"refs/remotes/origin/{raw_ref}"))
    for candidate in candidates:
        # ^{commit} peels annotated tags and rejects tag objects, so comparison
        # is always against the checkout's commit rather than an object id that
        # only happens to name the same tag.
        value = _git_value(repo, ["rev-parse", "--verify", f"{candidate}^{{commit}}"])
        if value:
            return value
    return None


def ref_status(candidate: Path, expected_ref: str, declared_ref: str | None, git: dict[str, Any]) -> dict[str, Any]:
    expected = (expected_ref or PRODUCT_REF).strip()
    head = git.get("head")
    # A dirty worktree may intentionally carry the product marker on a feature
    # branch; preserving and using that checkout is safe once its capabilities
    # are present. A clean Git checkout, however, must also resolve the pinned
    # ref so a stale marker cannot make an older commit look current.
    if declared_ref == expected and (not git.get("isGit") or git.get("dirty")):
        return {"expected": expected, "matched": True, "source": "manifest", "actual": declared_ref}
    resolved = _resolved_git_ref(candidate, expected) if git.get("isGit") else None
    if resolved and head and resolved == head:
        return {
            "expected": expected,
            "matched": True,
            "source": "git-ref" if declared_ref != expected else "manifest+git-ref",
            "actual": resolved,
        }
    if git.get("branch") == expected.removeprefix("refs/heads/"):
        return {"expected": expected, "matched": True, "source": "git-branch", "actual": git.get("branch")}
    return {
        "expected": expected,
        "matched": False,
        "source": "manifest" if declared_ref else "git",
        "actual": declared_ref or head,
    }


def inspect_repo(candidate: Path, expected_ref: str = PRODUCT_REF) -> dict[str, Any]:
    """Assess product compatibility without mutating or installing anything."""

    candidate = absolute(candidate)
    structural = valid_repo(candidate)
    capabilities = capability_status(candidate) if structural else {}
    git = git_checkout_status(candidate) if structural else {"isGit": False, "dirty": False, "changedFiles": 0}
    declared_ref = declared_product_ref(candidate) if structural else None
    ref = ref_status(candidate, expected_ref, declared_ref, git) if structural else {
        "expected": expected_ref,
        "matched": False,
        "source": "none",
        "actual": None,
    }
    missing_capabilities = [name for name, details in capabilities.items() if not details["ok"]]
    compatible = structural and ref["matched"] and not missing_capabilities
    reason = None
    if not structural:
        reason = "required product files are missing"
    elif not ref["matched"]:
        reason = f"checkout is not at compatible ref {expected_ref}"
    elif missing_capabilities:
        reason = f"missing capabilities: {', '.join(missing_capabilities)}"
    return {
        "repo": str(candidate),
        "structural": structural,
        "compatible": compatible,
        "release": declared_ref,
        "ref": ref,
        "git": git,
        "dirty": bool(git.get("dirty")),
        "capabilities": capabilities,
        "missingCapabilities": missing_capabilities,
        "reason": reason,
    }


def executable_status(command: str, args: list[str]) -> dict[str, Any]:
    executable = shutil.which(command)
    if not executable:
        return {"available": False, "path": None, "version": None}
    completed = subprocess.run(
        [executable, *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    return {
        "available": completed.returncode == 0,
        "path": executable,
        "version": (completed.stdout.strip() or completed.stderr.strip()).splitlines()[0]
        if (completed.stdout.strip() or completed.stderr.strip())
        else None,
    }


def runtime_status(repo: Path) -> dict[str, Any]:
    """Describe install/build prerequisites and give exact next commands."""

    node = executable_status("node", ["--version"])
    npm = executable_status("npm", ["--version"])
    ffprobe = executable_status("ffprobe", ["-version"])
    electron = repo / "node_modules" / ".bin" / ("electron.cmd" if os.name == "nt" else "electron")
    electron_dist = repo / "node_modules" / "electron" / "dist"
    missing: list[str] = []
    if not node["available"]:
        missing.append("node")
    if not npm["available"]:
        missing.append("npm")
    if not ffprobe["available"]:
        missing.append("ffprobe")
    if not electron.is_file():
        missing.append("node_modules/.bin/electron")
    if not electron_dist.is_dir():
        missing.append("node_modules/electron/dist")
    setup: list[str] = []
    if not node["available"] or not npm["available"]:
        setup.append("Install Node.js 22.22.1 (npm 10.9.4) and retry")
    else:
        if not ffprobe["available"]:
            setup.append("Install FFmpeg (including ffprobe) with an official package manager and retry")
        if not electron.is_file() or not electron_dist.is_dir():
            setup.append("npm ci")
            setup.append("npm rebuild electron --force")
        if not (repo / "dist").is_dir() or not (repo / "dist-electron").is_dir():
            setup.append("npm run build-vite")
    return {
        "ready": not missing,
        "missing": missing,
        "node": node,
        "npm": npm,
        "ffprobe": ffprobe,
        "electron": {"path": str(electron), "present": electron.is_file()},
        "electronDist": {"path": str(electron_dist), "present": electron_dist.is_dir()},
        "setup": setup,
    }


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


def safe_ref_name(ref: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", ref.strip()).strip(".-")
    return value or "release"


def choose_destination(root: Path, expected_ref: str, force: bool) -> tuple[Path | None, dict[str, Any]]:
    """Choose a non-destructive destination, preserving any existing checkout."""

    primary = root / "openscreen"
    if primary.exists() and not force:
        assessment = inspect_repo(primary, expected_ref)
        if assessment["compatible"]:
            return primary, {"existing": assessment}

    if not primary.exists():
        return primary, {}

    stem = f"openscreen-{safe_ref_name(expected_ref)}"
    for index in range(0, 1000):
        suffix = "" if index == 0 else f"-{index + 1}"
        candidate = root / f"{stem}{suffix}"
        if not candidate.exists():
            return candidate, {"preservedPath": str(primary), "isolated": True}
        assessment = inspect_repo(candidate, expected_ref)
        if assessment["compatible"] and not force:
            return candidate, {"existing": assessment}
    return None, {
        "code": "BOOTSTRAP_DESTINATION_UNAVAILABLE",
        "message": f"Unable to choose an unused checkout path under {root} without overwriting existing files.",
    }


def bootstrap_root(args: argparse.Namespace, config: dict[str, Any]) -> Path:
    """Resolve the bootstrap root, keeping a rejected explicit checkout nearby.

    A caller commonly passes ``--repo`` to an older checkout. When no root was
    configured, placing the new checkout beside that path makes the isolation
    visible and avoids silently putting the replacement in a different user
    data directory. Explicit CLI/environment/config roots remain authoritative.
    """

    configured_root = args.root or os.environ.get("MEGA_RECORDER_BOOTSTRAP_ROOT") or config.get("bootstrapRoot")
    if configured_root:
        return absolute(configured_root)
    if args.repo:
        explicit = absolute(args.repo)
        if valid_repo(explicit):
            return explicit.parent
    return absolute(Path.home() / ".local" / "share" / "mega-recorder")


def bootstrap_repo(
    root: Path, url: str, ref: str, branch: str, *, force: bool = False
) -> tuple[Path | None, dict[str, Any]]:
    root = absolute(root)
    root.mkdir(parents=True, exist_ok=True)
    destination, destination_details = choose_destination(root, ref or PRODUCT_REF, force)
    if destination is None:
        return None, destination_details
    existing = destination_details.get("existing")
    if existing:
        return destination, {
            "source": "bootstrap-existing",
            "created": False,
            **{key: value for key, value in destination_details.items() if key != "existing"},
            "release": existing.get("release"),
            "ref": existing.get("ref"),
            "capabilities": existing.get("capabilities"),
            "dirty": existing.get("dirty", False),
            "runtime": runtime_status(destination),
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
        if fetch.returncode != 0:
            return None, {
                "code": "BOOTSTRAP_REF_UNAVAILABLE",
                "message": f"Unable to fetch requested MEGA RECORDER release {requested_ref}. "
                + (fetch.stderr.strip() or "No compatible source was found."),
                "requestedRef": requested_ref,
            }
        checkout = run_git(["checkout", "--detach", "FETCH_HEAD"], stage)
        if checkout.returncode != 0:
            return None, {
                "code": "BOOTSTRAP_CHECKOUT_FAILED",
                "message": checkout.stderr.strip() or "git checkout failed",
            }
        details: dict[str, Any] = {"source": "bootstrapped", "created": True, "ref": selected_ref}
        source_assessment = inspect_repo(stage, ref or PRODUCT_REF)
        if not source_assessment["compatible"]:
            return None, {
                "code": "BOOTSTRAP_INCOMPATIBLE",
                "message": "Requested source is missing the pinned MEGA RECORDER release or required capabilities.",
                "ref": selected_ref,
                "sourceCheck": source_assessment,
            }
        details.update(
            {
                "repoPath": str(destination),
                "requestedRef": ref or PRODUCT_REF,
                "release": source_assessment.get("release"),
                "capabilities": source_assessment.get("capabilities"),
                "dirty": source_assessment.get("dirty", False),
                **destination_details,
            }
        )
        stage.rename(destination)
        # The stage path is removed by rename; report setup commands against the
        # stable checkout path that the caller will actually use.
        details["runtime"] = runtime_status(destination)
        return destination, details
    finally:
        if stage.exists():
            shutil.rmtree(stage, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Locate or bootstrap a MEGA RECORDER checkout")
    parser.add_argument("--repo", help="explicit product checkout path")
    parser.add_argument("--root", help="bootstrap root (defaults to a user-local data directory)")
    parser.add_argument("--url", default=os.environ.get("MEGA_RECORDER_REPOSITORY", PRODUCT_URL))
    parser.add_argument("--ref", default=os.environ.get("MEGA_RECORDER_REF", PRODUCT_REF))
    parser.add_argument("--no-bootstrap", action="store_true")
    parser.add_argument("--force-bootstrap", action="store_true", help="skip discovery and create a fresh checkout under --root")
    parser.add_argument("--json", action="store_true", help="kept for explicit machine-readable invocation")
    args = parser.parse_args()
    config = read_config()

    rejected: list[dict[str, Any]] = []
    expected_ref = args.ref or PRODUCT_REF
    if not args.force_bootstrap:
        for source, candidate in candidates(args.repo, config):
            assessment = inspect_repo(candidate, expected_ref)
            if assessment["compatible"]:
                emit(
                    {
                        "ok": True,
                        "command": COMMAND,
                        "repo": str(candidate),
                        "source": source,
                        "created": False,
                        "productCli": str(candidate / "scripts" / "mega-recorder-cli.mjs"),
                        "release": assessment.get("release"),
                        "ref": assessment.get("ref"),
                        "capabilities": assessment.get("capabilities"),
                        "dirty": assessment.get("dirty", False),
                        "runtime": runtime_status(candidate),
                    }
                )
                return 0
            if assessment.get("structural"):
                rejected.append(
                    {
                        "source": source,
                        "repo": str(candidate),
                        "reason": assessment.get("reason"),
                        "release": assessment.get("release"),
                        "ref": assessment.get("ref"),
                        "missingCapabilities": assessment.get("missingCapabilities", []),
                        "dirty": assessment.get("dirty", False),
                    }
                )

    if args.no_bootstrap:
        if rejected:
            emit(
                {
                    "ok": False,
                    "command": COMMAND,
                    "error": {
                        "code": "PRODUCT_REPO_INCOMPATIBLE",
                        "message": f"Found MEGA RECORDER checkout(s), but none match pinned ref {expected_ref} and all required capabilities.",
                        "expectedRef": expected_ref,
                        "checked": rejected,
                        "setup": [
                            f"Allow bootstrap to create an isolated checkout for {expected_ref}",
                            "or pass --repo to a compatible checkout",
                        ],
                    },
                }
            )
            return 1
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

    root = bootstrap_root(args, config)
    repo, details = bootstrap_repo(root, args.url, expected_ref, PRODUCT_BRANCH, force=args.force_bootstrap)
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
