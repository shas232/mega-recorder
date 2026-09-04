# MEGA RECORDER CLI

The product layer emits one JSON object per invocation, making it safe for
agents and CI to consume without scraping human progress output.

```bash
npm run --silent mega-recorder -- doctor
npm run --silent mega-recorder -- preset show blue-studio
npm run --silent mega-recorder -- preset apply blue-studio --project demo.openscreen
npm run --silent mega-recorder -- kokoro synthesize --text "Welcome" --voice am_michael --output narration.wav
npm run --silent mega-recorder -- verify demo.mp4 --preset blue-studio --manifest demo.mega.json
```

The `blue-studio` preset targets a 1920×1080, 60 fps output, a blurred blue
gradient, a centered padded card with shadow and rounded corners, visible
cursor telemetry (default theme, scale 3, click pulse 2.5), and restrained
cursor-focused zoom defaults. Applying it enables global cursor-follow focus for
all zooms and keeps cursor-dwell auto-zoom suggestions enabled. Its
`upstream.editor` mapping uses the existing
`.openscreen` editor schema; optional cursor extension keys are carried into
the native compositor's existing `legacyEditor` bridge.

## Local Kokoro

`kokoro doctor` searches an explicit `MEGA_RECORDER_KOKORO_PYTHON`, the active
virtual environment, a conventional `~/.venvs/kokoro`, and `python3` on PATH.
It reuses an existing `hexgrad/Kokoro-82M` cache. `kokoro doctor` reports the
cached voice ids; when `--voice` is omitted, synthesis prefers `af_heart`, then
the cached `am_michael` voice, then the first cached voice. An explicitly
requested voice must be present in the cache. Synthesis fails if either the
runtime or model cache is missing. The adapter sets `HF_HUB_OFFLINE=1`,
`TRANSFORMERS_OFFLINE=1`, and `HF_DATASETS_OFFLINE=1`; narration text is sent
to the local helper over stdin and is never uploaded.

## Verification and manifests

`verify` uses `ffprobe` without a shell and reports observed duration, video and
audio codecs, resolution, frame rate, and audio sample rate. Expected values
can be supplied with flags or inherited from `--preset blue-studio`. A mismatch
returns `ok: false` with `verification.errors[]` entries containing stable error
codes and expected/actual values. `--manifest` writes the versioned sidecar
contract; hashes are SHA-256 and narration text itself is never stored.

Exit status is `0` for a successful command, `1` for runtime/media/verification
failures, and `2` for invalid command arguments.

The `record` and `export` commands are compatibility wrappers around the
upstream OpenScreen CLI. Build the renderer first (`npm run build-vite`) and
run `node scripts/mega-recorder-cli.mjs record ...` when using those commands.

## Native macOS payloads

The shareable skill installs the native capture and export payloads from the
official OpenScreen `v1.10.0` release. On a supported Mac, run this once after
bootstrapping the checkout:

```bash
python3 skills/mega-recorder/scripts/native_setup.py \
  --repo "$PWD" --ensure --json
python3 skills/mega-recorder/scripts/doctor.py \
  --repo "$PWD" --json
```

`native_setup.py` selects the arm64 or x64 archive, verifies its pinned
SHA-256 digest before extraction, rejects archive symlinks/path traversal, and
verifies the extracted macOS code signatures. It writes only the required
ScreenCaptureKit helper, cursor helper, compositor addon, and LGPL FFmpeg
dylibs under `electron/native/bin/darwin-{arm64,x64}`. It does not inspect or
copy `/Applications/Openscreen.app`; the upstream `LICENSE` and
`THIRD-PARTY-NOTICES.md` remain in the checkout. Native record/export still
requires the user's normal macOS Screen Recording permission and is driven by
the hidden Electron CLI runner, not a visible desktop window.

## Browser editor

`mega-recorder edit <project>` starts a localhost-only server for the existing
React editor shell and prints its URL as JSON. It binds `127.0.0.1` on an
ephemeral port by default, authenticates API and media requests with a random
per-process token, and writes only the selected project file. Referenced media
is served by asset id; arbitrary filesystem paths are never accepted.

```bash
npm run build-vite
npm run --silent mega-recorder -- edit ./demo.openscreen
```

The browser milestone supports inspection and existing timeline cut/trim
editing. Native capture, native compositor preview, camera playback, AI
provider calls, and export remain desktop-only and are explicitly unsupported
in this adapter.

For non-interactive agent use, `edit delete <project> --start <seconds>
--end <seconds>` performs a media-preserving ripple delete and writes a sibling
`.edited.openscreen` by default. Add `--in-place` to update the selected project
file explicitly.
