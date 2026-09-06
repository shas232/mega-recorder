# Optional Remotion runtime

This directory is intentionally isolated from the main MEGA RECORDER package. It
contains the local React composition, the exact-pinned Remotion dependencies, and
the generated lockfile. The runtime does not need an AI key and does not fetch
remote media by default.

The default composition is editable at `src/composition.jsx`. It supports title
cards, diagram cards, local video segments, overlap-aware fade/slide transitions,
and a frame-addressed local audio timeline. Hosts may pass a project-local custom
entrypoint to the helper's `render()` function when they need motion beyond the
manifest template; the renderer never writes to that source.

The Brave executable used for rendering is:

`/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`

Preview is loopback-only. Starting the preview server does not launch a browser;
open the printed localhost URL explicitly in the in-app browser or Brave.

The helper API is exported from `scripts/mega-recorder/remotion.mjs`:

- `doctor()` checks the isolated install and Brave executable.
- `setup()` runs `npm ci` inside this directory only.
- `init()` writes a manifest plus an editable sibling `.src/` scaffold and `assets/` directory.
- `validate()` checks local assets, schema, frame timing, and media trim bounds.
- `render()` bundles and renders with concurrency 1, stages assets in a temporary public directory, and refuses source/output overwrites unless explicitly allowed.
- `preview()` starts the local Player preview shell and returns a localhost URL;
  the page includes playback and scrubbing controls and never launches a browser.

For the CLI wrapper, use `node scripts/mega-recorder/remotion.mjs <doctor|setup|init|validate|render|preview>`.
