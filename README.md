# MEGA RECORDER

Record and edit narrated product demos through your existing coding agent. Share one skill file; the agent gets the recorder from Git, sets up local Kokoro, drives the screen, edits the project, and exports the video.

Your host agent supplies the reasoning and available computer-use tools. The MEGA Recorder workflow does not require a separate AI provider or API key.

## Start with the skill

Download [SKILL.md](skills/mega-recorder/SKILL.md) and install it in your host's skill directory:

- Codex: `~/.codex/skills/mega-recorder/SKILL.md`
- Claude Code: `~/.claude/skills/mega-recorder/SKILL.md`

Then ask, for example:

> Use mega-recorder to make a three-minute demo of this app. Hide the browser toolbar, use a blue background and Sky narration, and save the finished MP4 on my Desktop.

The standalone skill contains the pinned Git source and setup instructions. You do not need to send teammates this entire repository. Initial setup downloads dependencies and model/native assets; screen-recording and accessibility permissions may require a one-time user action. The host needs suitable browser/computer-use tools for interactive walkthroughs.

## What it supports

- Native recording through OpenScreen's hidden Electron runner.
- Browser-based timeline editing and CLI edits to saved projects.
- Post-recording crops that remove browser tabs and the address bar from the exported video.
- Ripple cuts, zooms, framing, editable cursor effects, and timed text overlays.
- Local Kokoro narration, with `af_sky` as the default voice.
- Recording-clock action markers and native click-telemetry reconciliation.
- Named scenes for targeted revisions to scripts, audio, labels, and framing.
- New output files by default, with source preservation and export verification.
- Optional local Remotion animation and mixed-media rendering, kept separate
  from the recording runtime.

Changing scene text does not itself regenerate speech: the host agent synthesizes and replaces the affected narration. Cursor motion requires real capture telemetry; browser DOM clicks alone do not necessarily move the OS pointer.

## Platform and scope

The automated native setup path is currently supported for macOS arm64/x64. Recording and export have been tested on macOS arm64. Windows/Linux source is retained from upstream, but this skill's native setup is not verified there.

The browser editor is a local, token-protected editor—not a browser-only recorder or exporter. Native capture and final rendering run locally through Electron. The inherited standalone desktop app includes other upstream features; they are not prerequisites for the host-agent workflow.

Remotion animation is opt-in. Recording-only workflows do not require the
Remotion dependencies, Electron/native helpers, or Kokoro. For a silent
animation, install the isolated runtime only when needed and follow the
[Remotion animation guide](docs/remotion.md). The optional preview is
loopback-only and should be opened in the Codex in-app browser or Brave.

## Developer quick start

```sh
git clone --branch v0.4.0 --depth 1 https://github.com/shas232/mega-recorder.git
cd mega-recorder
npm ci
npm run build-vite
node scripts/mega-recorder-cli.mjs --help
```

Use the [skill](skills/mega-recorder/SKILL.md) for dependency, native-payload, and Kokoro setup. See the [CLI guide](docs/mega-recorder.md), [optional Remotion guide](docs/remotion.md), [source and architecture notes](MEGA-RECORDER.md), and [contributor instructions](AGENTS.md) for details.

## Credits and license

MEGA RECORDER is a fork of [OpenScreen](https://github.com/getopenscreen/openscreen), originally created by [Siddharth Vaddem](https://github.com/siddharthvaddem/openscreen) and continued by the OpenScreen contributors. Its native recorder, renderer, editor, and much of this source tree come from that project; this is not the official upstream distribution.

The [MIT license](LICENSE), original copyright notices, and [third-party notices](THIRD-PARTY-NOTICES.md) are preserved. Local speech synthesis uses Kokoro; see its setup helper for model provenance.
