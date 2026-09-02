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
