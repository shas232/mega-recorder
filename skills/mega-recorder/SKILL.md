---
name: mega-recorder
description: Operate the local-first MEGA RECORDER/OpenScreen workflow for recording, browser editing, local Kokoro narration, overlays, host computer-use actions, presets, verification, and export. Use when a host coding agent is asked to perform one of those workflows; do not use for unrelated video editing.
---

# MEGA Recorder

This file is intentionally standalone. It is written for the host agent (Codex, Claude Code, or a compatible coding agent), which supplies reasoning plus any available browser/computer-use capability. When this file is copied by itself, do not expect companion skill files: locate or clone the product first, then use the helpers in that checkout. Execute setup and one-time commands for the user rather than handing them a manual checklist. MEGA Recorder never requests or configures a separate AI provider, API key, or hosted agent; host-agent intelligence is outside the product.

The editor supports a visible narration/audio lane, timed title/label/callout/lower-third text boxes with frame/screen positioning and style, and host-agent action markers that can derive callouts plus deterministic cursor-focused framing. Ripple cuts keep clips, audio, overlays, actions, annotations, and zooms aligned together. The host agent chooses which of those treatments the video actually needs; availability is not a reason to turn every treatment on.

## Decide the treatment before capture

Read the brief, audience, source media, and requested user journey before recording. Make a short scene manifest that names each scene, its source-time span or intended action, and the treatment selected for it. Choose the smallest set that makes the story clear, and record that choice in the handoff. Revisit the decision after inspecting the first take; do not silently add decoration that changes the meaning or pacing.

- **Computer-use tracking** is useful for instructional or product walkthroughs where the viewer must understand what the operator did. Use the host's real computer-use controls and track only meaningful user actions. It is unnecessary for passive footage, a talking-head segment, or a visual montage.
- **Cursor movement and click capture** are useful when the pointer is part of the explanation. Record with an editable cursor whenever possible so native cursor telemetry can drive continuous movement, pointer-shape changes, and click effects. Use action markers for important semantic clicks, not for every sampled move. If native telemetry is unavailable, action points can locate those discrete events, but they do not recreate a continuous cursor path; report that limitation.
- **Labels and callouts** are useful for naming a control, field, result, or concept that would otherwise be missed. Label the few moments that carry the explanation, keep wording concise, and avoid a callout on every click.
- **Zoom and framing** are useful when the target is small, dense, or otherwise hard to read. Focus on the actual target while keeping enough context to orient the viewer. Skip or reduce zoom for already-legible content, faces, slides, or scenes where continuity matters more than detail. Do not let automatic zoom suggestions decide the treatment without review.
- **Narration** is useful when the viewer needs context, sequence, or interpretation that the pixels do not provide. Add it when requested or when on-screen text alone is insufficient; leave it out when the source audio or visual story is already self-explanatory. Use local Kokoro only, prefer the `af_sky` voice when it is available, and place the resulting audio on the same timeline as the scene it explains.
- **Cuts** are useful for dead air, setup, mistakes, retries, or irrelevant waits. Use ripple cuts so every surviving track stays aligned. Do not cut away a required action, its explanatory label, or the audio that establishes it.

The decision is part of the deliverable: state what was enabled, what was intentionally skipped, and why. A polished video may use only one or two of these treatments.

## Record computer-use actions against the media clock

When computer-use tracking is selected, establish the recording start and source frame geometry before driving the target flow. Start a semantic action manifest before capture and append an event immediately after each important successful action. Use the recording's source-media clock, not the wall-clock time when a screenshot or tool response arrived:

```sh
node "$REPO/scripts/mega-recorder-cli.mjs" actions start --output "$ACTION_MANIFEST"
node "$REPO/scripts/mega-recorder-cli.mjs" actions add "$ACTION_MANIFEST" \
  --time 12.4 --label "Click Save" --point 0.72,0.31
node "$REPO/scripts/mega-recorder-cli.mjs" actions add "$ACTION_MANIFEST" \
  --time 18.1 --label "Open reconciliation" --rect 0.58,0.12,0.24,0.08
```

Use a normalized point (`x,y`, both 0–1) for a click or other precise target, or a normalized target rectangle (`x,y,width,height`, all 0–1) for a control or region. Normalize against the captured source frame before wallpaper, padding, zoom, or export framing; never copy coordinates from a downscaled preview without mapping them back to that frame. Labels should describe the action the viewer needs to understand and should stay stable across retries. If the computer-use tool returns an event timestamp or target rectangle, retain it; otherwise derive the timestamp from the same monotonic recording-start reference used for the take.

Use `--cursor editable-overlay` for recordings whose cursor should remain editable (it is the normal/default path). Preserve and inspect the resulting `<video>.cursor.json` sidecar. When native telemetry is readable, it is the source of truth for continuous cursor motion, pointer shape, and actual click/interaction samples. The semantic action manifest remains the source of truth for important labels and target points/rectangles. When native telemetry is absent or unreadable, use timestamped action points/rectangles as a sparse fallback at meaningful cursor destinations and for callouts or framing; do not claim that this fallback is continuous motion or a captured click pulse. A system cursor baked into the video cannot be restyled or retimed independently.

After capture, check that each action is in the intended source-time scene and that its point/rectangle lands on the target. Do not apply actions from a different take or rely on screenshot arrival order to infer timing.

## Keep rendered effects synchronized

Apply action markers using the same source-time manifest that was collected during capture. Generated callouts and cursor-focused framing must be anchored to the action they explain; the rendered cursor and click effect must come from the telemetry sample at that action, not from a guessed nearby time. A semantic marker can generate a label or focus region, but it cannot manufacture missing native cursor motion or click telemetry.

Use the timeline's source-time-to-timeline mapping after edits. Attach narration with an explicit timeline start, and place manual labels/callouts so their visible interval brackets the action without obscuring the target. Before delivery, seek or render short checks around every important action and confirm, in the same interval, that the pointer/click effect (when available), label/callout, framing, and narration all refer to the same event. Check the first action after each cut as well as the last action before it; those are where an offset is easiest to miss.

If the user later asks to change wording, labels, cuts, framing, cursor behavior, timing, audio, or any related treatment, treat that as an edit to the persisted project, not a preview-only adjustment:

1. Resolve the current persisted project and source media. Hash the source media (and the source project when useful) before editing.
2. Create a sibling project for the revision and edit that sibling through the CLI or browser editor. Use `--output`/a copied project; do not use `--in-place` for this non-destructive workflow. Browser edits must open the sibling so Save persists the revision without overwriting the previous project.
3. Read the sibling project back from disk and verify the requested field, time range, action mapping, and audio/overlay/cursor settings are actually persisted. A browser save, backup, or successful HTTP response alone is not evidence.
4. Rerender/export the sibling to a new media output, then run `verify` against the exported artifact and inspect the changed action windows. Confirm the rendered timing, not only the JSON.
5. Compare source-media hashes after the edit/export and report that the original media bytes and prior project remain untouched. Keep revision artifacts beside the source or in an explicit output directory.

For a ripple cut, use the current timeline model (for example `edit delete ... --start ... --end ...`) so video, audio/narration, overlays, action markers, annotations, and generated zooms shift together. For wording or label changes, update the persisted overlay/action text. For cursor behavior, update the persisted cursor settings while preserving the native sidecar. For timing or audio changes, update the persisted track ranges/offsets and rerender; never repair sync by merely delaying narration in an unpersisted player setting.

### Placement

- Codex: place this file at `~/.codex/skills/mega-recorder/SKILL.md` and invoke `$mega-recorder` or describe the requested workflow.
- Claude Code: place this file at `~/.claude/skills/mega-recorder/SKILL.md` for personal scope or `.claude/skills/mega-recorder/SKILL.md` for project scope, then invoke it using the host's normal skill command.

The shared artifact remains this one `SKILL.md`; `agents/openai.yaml` and the helper scripts are optional repository resources, not prerequisites for bootstrapping.

## Product source and bootstrap

- Canonical repository: `https://github.com/shas232/mega-recorder.git`
- Pinned release: `v0.3.0` (use this tag unless the user explicitly requests another ref)
- Per-user default checkout: `${MEGA_RECORDER_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/mega-recorder}/openscreen`

1. Locate a valid existing checkout from `MEGA_RECORDER_HOME`, a configured product path, the current directory/ancestors, or generic home-relative locations. A valid checkout has `package.json` and `scripts/mega-recorder-cli.mjs`.
2. If none is available, create the per-user data directory and clone the canonical repository at the pinned tag:

   ```sh
   MEGA_RECORDER_ROOT="${MEGA_RECORDER_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/mega-recorder}"
   mkdir -p "$MEGA_RECORDER_ROOT"
   git clone --branch v0.3.0 --depth 1 https://github.com/shas232/mega-recorder.git "$MEGA_RECORDER_ROOT/openscreen"
   ```

   Never clone over an existing directory or choose an arbitrary user path. Set `REPO` to the resolved checkout for all later commands.
3. Run the checkout's `skills/mega-recorder/scripts/bootstrap.py --repo "$REPO" --ref v0.3.0 --no-bootstrap --json` to validate discovery. On first use, or whenever the checkout has no usable Node runtime, run `npm ci` in `REPO`; verify that `node_modules/.bin/electron` and the Electron distribution under `node_modules/electron/dist` exist, then run `npm rebuild electron --force` if the runtime is missing or corrupt. Build the app runtime with `npm run build-vite` when `dist/` or `dist-electron/` is absent. Run `doctor.py --repo "$REPO" --json` after setup and before native capture/export. Treat doctor output as evidence, not proof that recording or export succeeded.
4. Before every `record` or `export` on macOS, install the native payloads from the pinned upstream release with `python3 "$REPO/skills/mega-recorder/scripts/native_setup.py" --repo "$REPO" --ensure --json`, then rerun `doctor.py`. The helper detects arm64/x64, verifies the official archive SHA-256, extracts only the required signed ScreenCaptureKit/compositor/FFmpeg files into the checkout, and never reads `/Applications/Openscreen.app`. If the host is not a supported macOS architecture, leave native capture/export unverified and report the structured error.

The repository contains the deterministic helpers and product assets needed after cloning: `bootstrap.py`, `doctor.py`, `kokoro_setup.py`, `install_skill.py`, `smoke.py`, and the bundled upstream-to-product patch. Do not require those files before the initial clone.

## Route the request

- Inspection, presets, and verification use the existing CLI: `node "$REPO/scripts/mega-recorder-cli.mjs" <command>`. Preserve its stable JSON output.
- Browser editing uses `node "$REPO/scripts/mega-recorder-cli.mjs" edit <project>`. Build with `npm run build-vite` when the checkout has no current `dist/`, then open the printed loopback URL in the browser tool. The server is disposable, token-authenticated, loopback-only, and project-scoped. The browser timeline visibly exposes video, audio/narration, overlays, host actions, annotations, speed, trims, zooms, camera, and playback controls; it has no BYO AI/provider configuration. Verify the persisted project readback after edits and stop the server after the task.
- Local narration uses Kokoro only for TTS, which supports multiple voices. Before narration, run a fresh `kokoro doctor`; if it is not ready, automatically run `python3 "$REPO/skills/mega-recorder/scripts/kokoro_setup.py" --repo "$REPO" --json --ensure` and rerun `kokoro doctor`. Honor an explicit user-requested voice when the fresh doctor reports it; do not silently substitute another voice when that request is unavailable. When no voice was requested, prefer `af_sky` whenever the fresh doctor reports it. If `af_sky` is unavailable, choose a voice from the fresh doctor's reported list, disclose the exact fallback voice and reason, and keep that choice explicit in synthesis. Invoke the supported synthesis command with an explicit `--voice af_sky` for the preferred path (or `--voice <selected-voice>` for an explicit request/fallback); never rely on an implicit default. Model download/setup may use the network; narration text and synthesis stay local. Never configure or request a cloud TTS or other AI provider/API key.
- Native `record` and `export` remain upstream Electron/native compatibility surfaces. Run doctor first, install/verify the pinned payloads on supported macOS hosts, perform them only when explicitly requested and supported, and report them as unverified or blocked unless the requested artifact and a fresh verification exist. Native MP4 export burns the persisted overlays/framing and mixes unmuted local audio/narration tracks; GIF export has no audio stream. The CLI drives a hidden Electron runner window; do not open a visible Electron desktop app, add Remotion, or fake unsupported editor panels.

## Safety and handoff

- Preserve source media and project files. Write sibling outputs; use `--in-place` only when explicitly requested. Compare SHA-256 hashes before/after edits and state that source media bytes were untouched.
- Keep browser serving confined to `127.0.0.1` (or a Unix socket), use the per-process token, serve only the selected project, and add no telemetry or unrelated network dependency. No arbitrary filesystem paths may be exposed.
- Never expose secrets in a command log or handoff: do not print passwords, API keys, environment contents, or the token-bearing `megaRecorderToken` query parameter from a browser-editor URL. Use the URL internally in the browser tool and redact its token in user-facing output.
- Prefer the existing OpenScreen renderer, project store, timeline, and CLI contracts; do not build a parallel editor.
- Return the resolved checkout/ref, exact commands, output paths or a redacted browser URL, fresh verification evidence, and remaining native/editor limitations. A backup, doctor pass, or server start is not success evidence by itself.
