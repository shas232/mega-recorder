#!/usr/bin/env python3
"""Install this skill into a Codex skills directory without packaging local state."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

from bootstrap import valid_repo


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Install the MEGA Recorder Codex skill")
    parser.add_argument("--source", help="skill directory (defaults to this checkout's skill)")
    parser.add_argument("--target", help="Codex skill directory (defaults to ~/.codex/skills/mega-recorder)")
    parser.add_argument("--repo", help="optional product checkout to save in local, unshipped config.json")
    parser.add_argument("--force", action="store_true", help="replace an existing exact target directory")
    parser.add_argument("--json", action="store_true", help="kept for explicit machine-readable invocation")
    args = parser.parse_args()

    source = Path(args.source).expanduser().resolve() if args.source else Path(__file__).resolve().parents[1]
    target = (
        Path(args.target).expanduser().resolve()
        if args.target
        else Path.home() / ".codex" / "skills" / "mega-recorder"
    )
    if not (source / "SKILL.md").is_file() or not (source / "agents" / "openai.yaml").is_file():
        emit({"ok": False, "command": "install", "error": {"code": "SKILL_SOURCE_INVALID", "message": str(source)}})
        return 1

    configured_repo: Path | None = None
    if args.repo:
        configured_repo = Path(args.repo).expanduser().resolve()
        if not valid_repo(configured_repo):
            emit(
                {
                    "ok": False,
                    "command": "install",
                    "error": {"code": "PRODUCT_REPO_INVALID", "message": str(configured_repo)},
                }
            )
            return 1

    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and not args.force:
        emit(
            {
                "ok": False,
                "command": "install",
                "source": str(source),
                "target": str(target),
                "error": {"code": "SKILL_TARGET_EXISTS", "message": "Use --force to replace the exact target."},
            }
        )
        return 1

    stage = Path(tempfile.mkdtemp(prefix=".mega-recorder-skill-", dir=str(target.parent)))
    backup: Path | None = None
    try:
        shutil.rmtree(stage)
        shutil.copytree(source, stage)
        # config.json is intentionally created only in the installed copy; it is
        # never part of the source skill or portable archive.
        if configured_repo:
            (stage / "config.json").write_text(
                json.dumps({"productRepo": str(configured_repo)}, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )
            os.chmod(stage / "config.json", 0o600)
        if target.exists():
            backup = target.parent / f".{target.name}.previous-{os.getpid()}"
            if backup.exists():
                shutil.rmtree(backup)
            target.rename(backup)
        stage.rename(target)
        if backup and backup.exists():
            shutil.rmtree(backup)
        emit(
            {
                "ok": True,
                "command": "install",
                "source": str(source),
                "target": str(target),
                "configuredRepo": str(configured_repo) if configured_repo else None,
            }
        )
        return 0
    except OSError as error:
        if target.exists() and backup is not None and not backup.exists():
            # The old target was already moved and the new one failed; leave a
            # recoverable backup rather than deleting an existing installation.
            pass
        elif backup and backup.exists() and not target.exists():
            backup.rename(target)
        emit({"ok": False, "command": "install", "error": {"code": "SKILL_INSTALL_FAILED", "message": str(error)}})
        return 1
    finally:
        if stage.exists():
            shutil.rmtree(stage, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
