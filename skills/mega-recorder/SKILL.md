---
name: mega-recorder
description: Operate the local-first MEGA RECORDER/OpenScreen workflow for recording, browser editing, local Kokoro narration, presets, verification, and export. Use when a host coding agent is asked to perform one of those workflows; do not use for unrelated video editing.
---

# MEGA Recorder

This file is intentionally standalone. It is written for the host agent (Codex, Claude Code, or a compatible coding agent), which supplies reasoning plus any available browser/computer-use capability. When this file is copied by itself, do not expect companion skill files: locate or clone the product first, then use the helpers in that checkout. Execute setup and one-time commands for the user rather than handing them a manual checklist. MEGA Recorder never requests or configures a separate AI provider, API key, or hosted agent; host-agent intelligence is outside the product.

### Placement

- Codex: place this file at `~/.codex/skills/mega-recorder/SKILL.md` and invoke `$mega-recorder` or describe the requested workflow.
- Claude Code: place this file at `~/.claude/skills/mega-recorder/SKILL.md` for personal scope or `.claude/skills/mega-recorder/SKILL.md` for project scope, then invoke it using the host's normal skill command.

The shared artifact remains this one `SKILL.md`; `agents/openai.yaml` and the helper scripts are optional repository resources, not prerequisites for bootstrapping.

## Product source and bootstrap

- Canonical repository: `https://github.com/shas232/mega-recorder.git`
- Pinned release: `v0.2.0` (use this tag unless the user explicitly requests another ref)
- Per-user default checkout: `${MEGA_RECORDER_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/mega-recorder}/openscreen`

1. Locate a valid existing checkout from `MEGA_RECORDER_HOME`, a configured product path, the current directory/ancestors, or generic home-relative locations. A valid checkout has `package.json` and `scripts/mega-recorder-cli.mjs`.
2. If none is available, create the per-user data directory and clone the canonical repository at the pinned tag:

   ```sh
   MEGA_RECORDER_ROOT="${MEGA_RECORDER_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/mega-recorder}"
   mkdir -p "$MEGA_RECORDER_ROOT"
   git clone --branch v0.2.0 --depth 1 https://github.com/shas232/mega-recorder.git "$MEGA_RECORDER_ROOT/openscreen"
   ```

   Never clone over an existing directory or choose an arbitrary user path. Set `REPO` to the resolved checkout for all later commands.
3. Run the checkout's `skills/mega-recorder/scripts/bootstrap.py --repo "$REPO" --ref v0.2.0 --no-bootstrap --json` to validate discovery. On first use, or whenever the checkout has no usable Node runtime, run `npm ci` in `REPO`; verify that `node_modules/.bin/electron` and the Electron distribution under `node_modules/electron/dist` exist, then run `npm rebuild electron --force` if the runtime is missing or corrupt. Build the app runtime with `npm run build-vite` when `dist/` or `dist-electron/` is absent. Run `doctor.py --repo "$REPO" --json` after setup and before native capture/export. Treat doctor output as evidence, not proof that recording or export succeeded.
4. Before every `record` or `export` on macOS, install the native payloads from the pinned upstream release with `python3 "$REPO/skills/mega-recorder/scripts/native_setup.py" --repo "$REPO" --ensure --json`, then rerun `doctor.py`. The helper detects arm64/x64, verifies the official archive SHA-256, extracts only the required signed ScreenCaptureKit/compositor/FFmpeg files into the checkout, and never reads `/Applications/Openscreen.app`. If the host is not a supported macOS architecture, leave native capture/export unverified and report the structured error.

The repository contains the deterministic helpers and product assets needed after cloning: `bootstrap.py`, `doctor.py`, `kokoro_setup.py`, `install_skill.py`, `smoke.py`, and the bundled upstream-to-product patch. Do not require those files before the initial clone.

## Route the request

- Inspection, presets, and verification use the existing CLI: `node "$REPO/scripts/mega-recorder-cli.mjs" <command>`. Preserve its stable JSON output.
- Browser editing uses `node "$REPO/scripts/mega-recorder-cli.mjs" edit <project>`. Build with `npm run build-vite` when the checkout has no current `dist/`, then open the printed loopback URL in the browser tool. The server is disposable, token-authenticated, loopback-only, and project-scoped. Implemented browser scope is project inspection, existing timeline/trim editing, save, and non-interactive middle cut/ripple-delete via `edit delete`; verify the persisted project readback. Stop the server after the task.
- Local narration uses Kokoro only for TTS. Before narration, run `kokoro doctor`; if it is not ready, automatically run `python3 "$REPO/skills/mega-recorder/scripts/kokoro_setup.py" --repo "$REPO" --json --ensure`, rerun `kokoro doctor`, and synthesize with a voice reported by that fresh doctor result. Model download/setup may use the network; narration text and synthesis stay local. Never configure or request a cloud TTS or other AI provider/API key.
- Native `record` and `export` remain upstream Electron/native compatibility surfaces. Run doctor first, install/verify the pinned payloads on supported macOS hosts, perform them only when explicitly requested and supported, and report them as unverified or blocked unless the requested artifact and a fresh verification exist. The CLI drives a hidden Electron runner window; do not open a visible Electron desktop app, add Remotion, or fake unsupported editor panels.

## Safety and handoff

- Preserve source media and project files. Write sibling outputs; use `--in-place` only when explicitly requested. Compare SHA-256 hashes before/after edits and state that source media bytes were untouched.
- Keep browser serving confined to `127.0.0.1` (or a Unix socket), use the per-process token, serve only the selected project, and add no telemetry or unrelated network dependency. No arbitrary filesystem paths may be exposed.
- Prefer the existing OpenScreen renderer, project store, timeline, and CLI contracts; do not build a parallel editor.
- Return the resolved checkout/ref, exact commands, output paths or browser URL, fresh verification evidence, and remaining native/editor limitations. A backup, doctor pass, or server start is not success evidence by itself.
