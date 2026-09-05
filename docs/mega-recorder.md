# MEGA RECORDER CLI

The product layer emits one JSON object per invocation, making it safe for
agents and CI to consume without scraping human progress output.

```bash
npm run --silent mega-recorder -- doctor
npm run --silent mega-recorder -- preset show blue-studio
npm run --silent mega-recorder -- preset apply blue-studio --project demo.openscreen
npm run --silent mega-recorder -- kokoro synthesize --text "Welcome" --voice af_sky --output narration.wav
npm run --silent mega-recorder -- audio attach demo.openscreen --file narration.wav --voice af_sky --start 12 --mode mix --in-place
npm run --silent mega-recorder -- verify demo.mp4 --preset blue-studio --manifest demo.mega.json
npm run --silent mega-recorder -- actions start demo.openscreen --output demo.actions.json
npm run --silent mega-recorder -- actions add demo.actions.json --time 12.4 --label "Click Save" --point 0.72,0.31
npm run --silent mega-recorder -- actions apply demo.openscreen --manifest demo.actions.json --callouts
npm run --silent mega-recorder -- scenes start demo.openscreen --output demo.scenes.json
npm run --silent mega-recorder -- scenes add demo.scenes.json --name "Save settings" --start 11 --end 14 --text "Save the settings" --audio-track-ids narration_1
npm run --silent mega-recorder -- scenes apply demo.openscreen --manifest demo.scenes.json
npm run --silent mega-recorder -- edit overlay add demo.openscreen --start 0.4 --end 2.2 --text "MEGA Recorder" --type title --position 50,12 --size 76,14
npm run --silent mega-recorder -- edit delete demo.openscreen --start 12.0 --end 12.4 --output demo.cut.openscreen
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
cached voice ids; when `--voice` is omitted, synthesis prefers `af_sky`, then
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

Native MP4 export burns the persisted overlays and framing, then mixes every
unmuted local audio/narration track on its timeline. GIF export has no audio
stream.

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

The browser editor exposes the complete relevant timeline: video clips,
audio/narration, timed overlays, host actions, annotations, speed, trims,
zooms, camera, and playback controls. Native capture, native compositor
preview, camera playback, and export remain desktop-only. There is no BYO AI or
provider configuration in the browser editor; host-agent actions and local
Kokoro are the only AI-adjacent integrations.

For non-interactive agent use, `edit delete <project> --start <seconds>
--end <seconds>` performs a media-preserving ripple delete and writes a sibling
`.edited.openscreen` by default. Add `--in-place` to update the selected project
file explicitly.

### Crop the recorded browser frame

The browser editor's crop button opens the existing crop rectangle editor. Apply
the selected source-frame region to the complete video timeline; the original
recording remains untouched and the browser save writes only the selected project
sidecar. The native cursor, zoom focus, and labels continue to use their original
source/frame coordinate spaces, so they stay aligned after the crop.

For agents and scripts, use the same source-frame fractions with a sibling output
by default:

```bash
npm run --silent mega-recorder -- edit crop demo.openscreen \
  --region 0,0.08,1,0.92 --output demo.cropped.openscreen
npm run --silent mega-recorder -- edit crop demo.openscreen \
  --region 0.04,0.12,0.92,0.88 --clip-id clip_123 \
  --output demo.scene-cropped.openscreen
```

`--region` is `x,y,width,height` to keep. Edge flags (`--top`, `--right`,
`--bottom`, `--left`) are fractions to remove. Without `--clip-id`, every video
clip receives one consistent framing; pass a clip id when a timeline scene needs
a different crop. The default output is `<project>.cropped.<extension>`;
`--in-place` is required to overwrite the project sidecar. Crop is metadata-only:
it never rewrites the source video or its cursor telemetry sidecar.

## Attached audio and narration

`audio attach` adds a local WAV/MP3/M4A/etc. to the selected project's timeline.
It probes the file with `ffprobe`, persists the source range and timeline range,
and marks a supplied `--voice` as Kokoro narration. `--mode mix` keeps the
recording audio underneath at the export ducking level; `--mode replace` emits
the attached tracks as the only audio. The command writes a sibling
`.with-audio.openscreen` by default; pass `--in-place` when overwriting the
selected project is intentional. `--manifest` records input/output hashes
without embedding narration text.

```bash
npm run --silent mega-recorder -- audio attach demo.openscreen \
  --file narration.wav --voice af_sky --start 12 --mode mix --in-place
```

The browser timeline shows each attached block with its label, Kokoro voice (or
audio type), duration, status, play/pause, mute, and volume controls. A ripple
delete removes overlapped audio, shifts surviving ranges left, and splits a
track at the cut while advancing its source offset so playback never restarts
unexpectedly. MP4 export renders every unmuted track on its persisted timeline
range. Missing files, undecodable audio, invalid source ranges, and tracks that
outlive the video fail with an explicit duration-sync/read error; GIF export
rejects attached audio because the native GIF container has no audio stream.
Legacy v2 native `.openscreen` sidecars are promoted automatically when an
overlay, action, or ripple-delete command needs the current timeline model; the
source sidecar and media remain untouched.

## Host-agent actions and framing

The `actions` commands accept semantic events from host computer-use capture or
browser automation. A host can import the action manifest it recorded while
driving the computer; the same source-time event can generate a callout and
cursor-focused framing. The format is also published as
`schemas/mega-recorder-action-manifest.schema.json`; it is JSON schema version 1
and each action has a stable id,
source-media `timestampSec`, concise label, and either a normalized `point`
(`x`,`y`) or normalized `targetRect` (`x`,`y`,`width`,`height`), plus an optional
`sceneId`. `actions import` normalizes an externally-authored manifest, and
`actions list` returns it as the stable JSON CLI object.

`actions apply` merges markers into the selected project and derives deterministic
clip-anchored zoom framing around each action. `--callouts` additionally emits
short local text callout annotations; no provider, API key, or network call is
used. Existing manual zooms remain intact, and reapplying is idempotent. Action
timestamps stay in source time while `timelineTimeSec` is recalculated after a
ripple delete; actions inside the deleted span are dropped and generated framing
is rebuilt. Source media and its existing `.cursor.json` telemetry sidecar are
never rewritten.

### Capture-clock timestamps

Native recording can publish a readiness reference when capture actually starts.
Pass the same absolute clock file to the recorder and action manifest:

```bash
node scripts/mega-recorder-cli.mjs actions start \
  --output demo.actions.json --clock-file demo.recording-clock.json
node scripts/mega-recorder-cli.mjs record --clock-file demo.recording-clock.json \
  --window "Brave" --duration 20 --project demo.openscreen --json
node scripts/mega-recorder-cli.mjs actions add demo.actions.json --time auto \
  --label "Click Save" --point 0.72,0.31
# After the take, refine approximate action rows against the finished sidecar:
node scripts/mega-recorder-cli.mjs actions reconcile demo.actions.json \
  --recording /path/to/screen-video.mp4 --output demo.actions.reconciled.json
```

`--time auto` uses a matching native `click` sample from
`<recording>.cursor.json` when `--recording <video>` is supplied; that result is
marked `timestampSource: "cursor-telemetry"` and `timestampAccuracy: "exact"`.
Otherwise it uses the shared recording-start epoch in `--clock-file`, marks the
result `timestampSource: "recording-clock"` and
`timestampAccuracy: "approximate"`, and records the action invocation epoch.
It never treats the time a tool response arrived as an exact click time. A
spatially mismatched telemetry sample is not used as a fallback.
The recorder marks the clock `status: "stopped"` when the take ends; `--time
auto` then fails explicitly, so post-processing must provide an intentional
numeric source time rather than placing an action after the take.
To refine events collected while recording, `actions reconcile` uses each
approximate row's persisted invocation time and target, then accepts only a
native click inside the bounded time window; unmatched rows remain approximate.

### Named scenes and revisions

Scenes are persisted source-time spans with a stable id, revision number, action
ids, per-action text mappings, and optional `audioTrackIds`/`overlayIds` links.
A scene without `--id` gets a deterministic name-derived id; pass `--id` when
names are not unique. Apply or revise a project without touching the source
media:

```bash
node scripts/mega-recorder-cli.mjs scenes revise demo.openscreen \
  --scene-id scene-save-settings --text "Save the updated settings" \
  --output demo.scene-revised.openscreen
```

`scenes revise` updates the persisted scene mapping and increments its revision
only when timing/name/copy/link changes. It does not synthesize or replace audio;
text revisions return `needsNarrationRegeneration: true` while
`narrationChanged: false`. Use the scene's `audioTrackIds` to replace the prior
track rather than appending a duplicate. Scene times remain source-anchored
across timeline cuts.

## Timed overlays and ripple alignment

`edit overlay add` creates a title, label, callout, or lower-third text box.
`--position x,y`, `--size width,height`, `--anchor`, `--space`, and style flags
control its placement and appearance. MP4 export composites these overlays;
the browser shows them in the overlays lane and preview. A middle cut splits
overlapped overlays and audio tracks, shifts later pieces, and remaps action
markers plus their generated framing/callouts so narration and focus remain in
the same relative moments.
