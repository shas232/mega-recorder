# MEGA RECORDER

MEGA RECORDER is the team fork workspace for OpenScreen, the upstream free and
open-source desktop screen recorder and video editor.

## Pinned source

- Upstream: <https://github.com/getopenscreen/openscreen>
- Selected ref: `origin/main`
- Selected commit: `cc7d514a93c828f52b5cf28a1aaf091c399f2bd1`
- Upstream description: `v1.9.2-507-gcc7d514a`
- Upstream package version: `1.10.0`
- Pinned-version manifest: [`mega-recorder.manifest.json`](./mega-recorder.manifest.json)

## Product layer

The first usable MEGA RECORDER layer is an agent-neutral JSON CLI:

```bash
npm run --silent mega-recorder -- doctor
npm run --silent mega-recorder -- preset show blue-studio
npm run --silent mega-recorder -- kokoro doctor
npm run --silent mega-recorder -- verify demo.mp4 --preset blue-studio
```

`record` and `export` delegate to OpenScreen's existing headless Electron CLI,
so this layer does not reimplement or fake native capture. Local Kokoro runs in
`scripts/mega-recorder/kokoro_runtime.py` with Hugging Face offline mode forced;
it accepts text through stdin and writes 24 kHz mono PCM WAV. If the Python
package/model cache is not already installed, `kokoro doctor` reports `ready: false`
and synthesis exits with a structured error rather than downloading anything.
The top-level `doctor` command reports `ready: true` only when both ffprobe and
the local Kokoro runtime/model are ready.

`preset apply` writes a new `.openscreen` file by default and preserves the
source. Use `--in-place` only when that mutation is intended. `--manifest path`
records the pinned upstream commit, preset, Kokoro/model details, SHA-256 input
and output hashes, and verification results under the versioned contract in
`schemas/mega-recorder-project-manifest.schema.json`.

## Browser editor

Build the renderer once, then open a selected project in the existing OpenScreen
editor shell without launching Electron:

```bash
npm run build-vite
npm run --silent mega-recorder -- edit ./demo.openscreen
```

`edit` binds an ephemeral port on `127.0.0.1` and prints one JSON object with a
token-bearing browser URL. Keep that process running while editing; stop it
with `Ctrl-C`. The browser adapter loads only the selected project, serves only
its referenced media, and persists editor saves back to that project atomically.
The token is random per process and required for API/media requests. No
telemetry, remote assets, or arbitrary filesystem paths are exposed.

This milestone supports project inspection and the existing timeline cut/trim
controls. Native capture, the native compositor preview, camera playback, AI
provider calls, and export remain desktop-only and are surfaced as unsupported
in the browser adapter rather than simulated.

For an agent-friendly, non-interactive ripple delete that never modifies media,
write a sibling project by default (or opt into the source file explicitly):

```bash
npm run --silent mega-recorder -- edit delete ./demo.openscreen \
  --start 12.5 --end 16.0
npm run --silent mega-recorder -- edit delete ./demo.openscreen \
  --start 12.5 --end 16.0 --in-place
```

The explicit `edit delete` form is preferred; `edit <project> --delete ...`
is retained as a compatibility alias.

The upstream `LICENSE` and `THIRD-PARTY-NOTICES.md` files remain the governing
attribution and license records.

## Extension points

- React renderer and editor: `src/`
- Electron main process and preload bridge: `electron/`
- macOS ScreenCaptureKit helper: `electron/native/screencapturekit/`
- Native compositor: `crates/`
- Build, packaging, and diagnostics: `scripts/` and `technical-documentation/`

See [`AGENTS.md`](./AGENTS.md) for repository commands and contribution rules.
