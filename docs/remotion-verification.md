# Remotion v0.4.0 verification

Verified on macOS arm64 with Remotion 4.0.521 and the installed Brave executable.
This is optional-composition verification, not a full upstream desktop-release
certification. Native capture, webcam, microphone, and other platforms were not
rerun for this change.

- Recording-layer regression suite: 200 files, 2,307 tests passed, 2 skipped.
- Additional final scaffold-preview regression: 6 focused tests passed.
- Python setup/bootstrap suite: 16 passed.
- App and test TypeScript checks, Vite build, skill validation, and docs check passed.
- Isolated animation setup worked without root dependencies or native capture tools.
- Animation-only and editable project-local scaffold exports succeeded in Brave.
- A sibling text revision rendered the new wording while preserving scene IDs.
- Mixed export: 390 frames, 1280×720, 30 fps, H.264/AAC; measured container
  duration 13.056 seconds for a 13-second composition.
- Mixed output contained local Sky narration, cropped recorded footage with
  its existing audio, and fade/slide transitions. Extracted title, transition,
  recorded-scene, and outro frames were inspected. Narration waveform correlation
  was 0.997 with the source; AAC introduced approximately 43 ms of offset.
- Original recorded source SHA-256 was unchanged after export.
- In-app browser QA showed the correct mixed and revised animation manifests;
  playback and scrubbing reached the recorded scene.
- Preview HTTP checks: authenticated HTML/manifest 200, no authentication 401,
  foreign Host/Origin 403, unknown media 404, suffix byte range 206 with exact length.

The optional dependency has separate Remotion licensing. No company license was
purchased or activated. Custom React source is executable code, not sandboxed input.
