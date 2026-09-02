---
name: mega-recorder
description: Operate the local-first MEGA RECORDER/OpenScreen workflow for recording, browser editing, local Kokoro narration, presets, verification, and export when the user asks for those tasks. Use the bundled bootstrap and doctor helpers; do not use for unrelated video editing.
---

# MEGA Recorder

Use this skill when the user asks Codex to record, edit, narrate, verify, apply a preset, or export with MEGA RECORDER. The skill operates the product for the user; do not turn setup into a checklist for them.

## Start every task

1. Run `python3 scripts/bootstrap.py --json` from this skill directory. It first detects an existing product checkout using `MEGA_RECORDER_HOME`, installed config, the current directory/ancestors, and generic home-relative locations. If none exists, it bootstraps the pinned upstream source and applies the bundled product delta when a published MEGA RECORDER ref is unavailable. Use the returned `repo` path for every later command.
2. Run `python3 scripts/doctor.py --repo <repo> --json` before any native capture/export or dependency-changing operation. Doctor output is evidence, not a success claim: report `ready`, blockers, and unverified surfaces separately.
3. For narration, run `python3 scripts/kokoro_setup.py --repo <repo> --json --ensure` only when local Kokoro doctor is not ready. This may install a local runtime/model cache as needed. Synthesis itself must remain offline; never send narration to a cloud TTS provider.

## Mode routing

- Inspection, presets, and verification use the existing CLI directly: `node scripts/mega-recorder-cli.mjs <command>`, or the documented npm wrapper. Preserve its one-JSON-object output. For a non-interactive middle cut/ripple-delete, use the CLI's `edit delete` operation and verify the persisted project readback.
- Browser editing uses `node scripts/mega-recorder-cli.mjs edit <project>`. Build the renderer with `npm run build-vite` if the checkout has no current `dist/`, then open the printed localhost URL with the browser tool. The server is loopback-only, token-authenticated, project-scoped, and disposable. Implemented browser scope is project inspection, existing timeline/trim editing, save, and non-interactive `edit delete`; do not claim native compositor, camera capture/playback, AI provider calls, or export support there.
- Local narration uses `kokoro synthesize` after the local setup/doctor gate. Keep source text and model execution local; select a voice reported by `kokoro doctor`.
- Native `record` and `export` remain upstream Electron/native compatibility commands. Run doctor first, execute only when requested and supported by the machine, and report native capture/export as unverified or blocked unless the requested artifact and a fresh verification actually exist. Never add Remotion or substitute a cloud service.

## Safety and handoff

- Preserve source media and project files by default. Write sibling outputs and use `--in-place` only when the user explicitly requests it. Before/after edits, compare SHA-256 hashes of source media and report that media bytes were untouched.
- Do not expose arbitrary filesystem paths through the browser server, bind beyond `127.0.0.1`, add telemetry, or leave a browser-editor server running after the task.
- Prefer the existing OpenScreen project store, renderer, timeline, and CLI contracts. Do not create a parallel editor or visible Electron window for browser editing.
- Return the exact repo, command, output path/URL, verification evidence, and remaining native/editor limitations. A doctor pass, backup, or server start is not proof that recording/export succeeded.

The deterministic helpers are [bootstrap.py](scripts/bootstrap.py), [doctor.py](scripts/doctor.py), [kokoro_setup.py](scripts/kokoro_setup.py), [install_skill.py](scripts/install_skill.py), and [smoke.py](scripts/smoke.py). Codex should invoke them as needed; teammates should not need one-time manual setup commands. `smoke.py --fresh --source-repo <checkout>` exercises a temporary base clone plus the bundled product delta.
