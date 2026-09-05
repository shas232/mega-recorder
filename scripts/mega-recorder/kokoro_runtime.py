#!/usr/bin/env python3
"""Small offline Kokoro adapter used by the MEGA RECORDER Node CLI.

The adapter intentionally has no HTTP client and forces Hugging Face offline
mode. Text arrives on stdin so narration never appears in a process listing.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import wave
from pathlib import Path


SAMPLE_RATE = 24000
DEFAULT_VOICE = "af_sky"


def emit(payload: dict) -> None:
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def doctor() -> int:
    module = importlib.util.find_spec("kokoro")
    dependencies = {
        name: importlib.util.find_spec(name) is not None
        for name in ("torch", "numpy", "soundfile", "misaki")
    }
    version = None
    if module is not None:
        try:
            import kokoro  # type: ignore[import-not-found]

            version = getattr(kokoro, "__version__", None)
        except Exception as exc:  # pragma: no cover - environment-specific
            emit(
                {
                    "ok": False,
                    "moduleAvailable": True,
                    "version": version,
                    "dependencies": dependencies,
                    "error": str(exc),
                }
            )
            return 1
    emit(
        {
            "ok": module is not None,
            "moduleAvailable": module is not None,
            "version": version,
            "dependencies": dependencies,
        }
    )
    return 0 if module is not None else 1


def write_pcm16(path: Path, chunks: list[object]) -> None:
    import numpy as np  # type: ignore[import-not-found]

    arrays = []
    for chunk in chunks:
        if hasattr(chunk, "detach"):
            chunk = chunk.detach().cpu().numpy()
        values = np.asarray(chunk, dtype=np.float32).reshape(-1)
        arrays.append(values)
    if not arrays:
        raise RuntimeError("Kokoro produced no audio")
    audio = np.concatenate(arrays)
    audio = np.clip(audio, -1.0, 1.0)
    pcm = (audio * 32767.0).astype(np.int16).tobytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(pcm)


def synthesize(voice: str, output: Path, sample_rate: int) -> int:
    # Do not remove these: they make a cache miss fail locally instead of
    # triggering a model download or telemetry path in a Hugging Face client.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"

    from kokoro import KPipeline  # type: ignore[import-not-found]

    text = sys.stdin.read()
    if not text.strip():
        emit({"ok": False, "code": "NARRATION_EMPTY", "error": "Narration text is empty"})
        return 2
    lang_code = voice[:1].lower()
    if not lang_code.isalpha():
        emit({"ok": False, "code": "VOICE_INVALID", "error": f"Unsupported voice: {voice}"})
        return 2
    pipeline = KPipeline(lang_code=lang_code)
    chunks = []
    for _, _, audio in pipeline(text, voice=voice):
        chunks.append(audio)
    write_pcm16(output, chunks)
    emit(
        {
            "ok": True,
            "output": str(output.resolve()),
            "sampleRate": sample_rate,
            "channels": 1,
            "codec": "pcm_s16le",
        }
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--doctor", action="store_true")
    parser.add_argument("--synthesize", action="store_true")
    parser.add_argument("--voice", default=DEFAULT_VOICE)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--sample-rate", type=int, default=SAMPLE_RATE)
    args = parser.parse_args()
    if args.doctor:
        return doctor()
    if args.synthesize:
        if args.output is None:
            emit({"ok": False, "code": "OUTPUT_REQUIRED", "error": "Output path is required"})
            return 2
        try:
            return synthesize(args.voice, args.output, args.sample_rate)
        except Exception as exc:  # pragma: no cover - depends on local runtime
            emit({"ok": False, "code": "KOKORO_RUNTIME_FAILED", "error": str(exc)})
            return 1
    emit({"ok": False, "code": "COMMAND_REQUIRED", "error": "Pass --doctor or --synthesize"})
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
