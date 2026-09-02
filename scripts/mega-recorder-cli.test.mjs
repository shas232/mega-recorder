import { describe, expect, it } from "vitest";
import {
	buildManifest,
	MANIFEST_CONTRACT,
	MANIFEST_SCHEMA_VERSION,
} from "./mega-recorder/manifest.mjs";
import { applyPresetToProject, getPreset } from "./mega-recorder/preset.mjs";
import { mediaMetadata, verifyMetadata } from "./mega-recorder/verify.mjs";
import { runCommand } from "./mega-recorder-cli.mjs";

describe("MEGA RECORDER product layer", () => {
	it("returns the deterministic blue-studio preset through the agent CLI", async () => {
		const response = await runCommand(["preset", "show", "blue-studio"]);
		expect(response.ok).toBe(true);
		expect(response.preset.canvas).toEqual({
			width: 1920,
			height: 1080,
			fps: 60,
			aspectRatio: "16:9",
		});
		expect(response.preset.background.blurred).toBe(true);
		expect(response.preset.foregroundCard).toMatchObject({
			padding: 40,
			shadowIntensity: 0.35,
			borderRadius: 32,
		});
		expect(response.preset.cursor).toMatchObject({ visible: true, size: 3, clickBounce: 2.5 });
	});

	it("preserves unrelated project fields while applying upstream editor settings", () => {
		const source = {
			version: 2,
			media: { screenVideoPath: "/tmp/demo.webm" },
			editor: { padding: 2 },
			custom: "keep",
		};
		const next = applyPresetToProject(source, getPreset("blue-studio"));
		expect(next.custom).toBe("keep");
		expect(next.editor).toMatchObject({
			padding: 40,
			showBlur: true,
			cursorSize: 3,
			cursorClickBounce: 2.5,
		});
		expect(source.editor.padding).toBe(2);
	});

	it("maps ffprobe rational rates and verifies all media dimensions", () => {
		const metadata = mediaMetadata({
			format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "12.5" },
			streams: [
				{
					codec_type: "video",
					codec_name: "h264",
					width: 1920,
					height: 1080,
					avg_frame_rate: "60000/1001",
				},
				{ codec_type: "audio", codec_name: "aac", sample_rate: "24000", channels: 1 },
			],
		});
		const verification = verifyMetadata(metadata, {
			width: 1920,
			height: 1080,
			fps: 60000 / 1001,
			fpsTolerance: 0.001,
			durationSec: 12.5,
			videoCodec: "h264",
			audioCodec: "aac",
			sampleRate: 24000,
		});
		expect(verification.passed).toBe(true);
		expect(verification.checks).toHaveLength(7);
	});

	it("returns stable mismatch codes", () => {
		const verification = verifyMetadata(
			{ durationSec: 3, video: { codec: "vp9", width: 1280, height: 720, fps: 30 }, audio: null },
			{ width: 1920, height: 1080, fps: 60, videoCodec: "h264", sampleRate: 24000 },
		);
		expect(verification.passed).toBe(false);
		expect(verification.errors.map((error) => error.code)).toEqual(
			expect.arrayContaining(["VERIFY_MISMATCH", "AUDIO_STREAM_MISSING"]),
		);
	});

	it("builds the versioned manifest without embedding narration text", () => {
		const manifest = buildManifest({
			baseline: {
				project: { upstreamCommit: "abc123", upstreamRepository: "https://example.test" },
			},
			preset: getPreset("blue-studio"),
			inputs: [{ kind: "narration-text", bytes: 3, sha256: "a".repeat(64) }],
			outputs: [{ path: "/tmp/narration.wav", bytes: 4, sha256: "b".repeat(64) }],
			command: "kokoro synthesize",
		});
		expect(manifest.contract).toBe(MANIFEST_CONTRACT);
		expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
		expect(manifest.project.upstreamCommit).toBe("abc123");
		expect(JSON.stringify(manifest)).not.toContain("hello");
	});

	it("keeps command output machine-readable for help and unknown commands", async () => {
		const help = await runCommand([]);
		const unknown = await runCommand(["not-a-command"]);
		expect(help).toMatchObject({ ok: true, command: "help" });
		expect(unknown).toMatchObject({
			ok: false,
			command: "not-a-command",
			error: { code: "CLI_ARGUMENT_ERROR" },
		});
	});
});
