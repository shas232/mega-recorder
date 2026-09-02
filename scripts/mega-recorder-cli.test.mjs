import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Ajv from "ajv/dist/2020.js";
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
		expect(response.preset.upstream.editor).toMatchObject({
			exportFormat: "mp4",
			exportQuality: "good",
		});
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
			autoZoomEnabled: true,
			autoFocusAll: true,
		});
		expect(source.editor.padding).toBe(2);
	});

	it("keeps the checked-in baseline valid against the project manifest schema", async () => {
		const schema = JSON.parse(
			await fs.readFile(
				path.join(import.meta.dirname, "..", "schemas/mega-recorder-project-manifest.schema.json"),
				"utf8",
			),
		);
		const baseline = JSON.parse(
			await fs.readFile(
				path.join(import.meta.dirname, "..", "mega-recorder.manifest.json"),
				"utf8",
			),
		);
		const validate = new Ajv({ strict: true }).compile(schema);
		expect(validate(baseline), JSON.stringify(validate.errors)).toBe(true);
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

	it("reports overall readiness only when required local checks are ready", async () => {
		const response = await runCommand(["doctor"]);
		expect(response.ready).toBe(response.checks.ffprobe.available && response.checks.kokoro.ready);
	});

	it("rejects inherited presets, unknown options, and extra positional arguments", async () => {
		expect(await runCommand(["preset", "show", "__proto__"])).toMatchObject({
			ok: false,
			error: { code: "PRESET_NOT_FOUND" },
		});
		expect(await runCommand(["preset", "show", "blue-studio", "extra"])).toMatchObject({
			ok: false,
			error: { code: "CLI_ARGUMENT_ERROR" },
		});
		expect(await runCommand(["kokoro", "synthesize", "--text", "hello", "--bogus"])).toMatchObject({
			ok: false,
			error: { code: "CLI_ARGUMENT_ERROR" },
		});
		expect(await runCommand(["doctor", "--bogus"])).toMatchObject({
			ok: false,
			error: { code: "CLI_ARGUMENT_ERROR" },
		});
		expect(await runCommand(["kokoro", "doctor", "extra"])).toMatchObject({
			ok: false,
			error: { code: "CLI_ARGUMENT_ERROR" },
		});
		expect(await runCommand(["kokoro", "synthesize", "--text"])).toMatchObject({
			ok: false,
			error: { code: "CLI_ARGUMENT_ERROR" },
		});
		expect(await runCommand(["verify", "/tmp/demo.mp4", "--width"])).toMatchObject({
			ok: false,
			error: { code: "CLI_ARGUMENT_ERROR" },
		});
		expect(await runCommand(["verify", "/tmp/demo.mp4", "--width="])).toMatchObject({
			ok: false,
			error: { code: "CLI_ARGUMENT_ERROR" },
		});
	});

	it("does not let a manifest path overwrite the project it describes", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mega-recorder-cli-"));
		const projectPath = path.join(directory, "demo.openscreen");
		const original = JSON.stringify({
			version: 2,
			media: { screenVideoPath: "/tmp/demo.mp4" },
			editor: {},
		});
		await fs.writeFile(projectPath, original, "utf8");

		const response = await runCommand([
			"preset",
			"apply",
			"blue-studio",
			"--project",
			projectPath,
			"--in-place",
			"--manifest",
			projectPath,
		]);
		expect(response).toMatchObject({
			ok: false,
			error: { code: "CLI_ARGUMENT_ERROR" },
		});
		expect(await fs.readFile(projectPath, "utf8")).toBe(original);
	});

	it("starts the browser editor on loopback and exposes a non-interactive delete operation", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mega-recorder-edit-"));
		const projectPath = path.join(directory, "demo.openscreen");
		const project = {
			schemaVersion: 7,
			project: { id: "proj_cli", title: "CLI project", primaryAssetId: "asset_1" },
			assets: [
				{
					id: "asset_1",
					kind: "video",
					label: "Capture",
					originalPath: "/tmp/capture.mp4",
					durationSec: 20,
				},
			],
			timeline: {
				clips: [
					{
						id: "clip_1",
						assetId: "asset_1",
						sourceStartSec: 0,
						sourceEndSec: 20,
						timelineStartSec: 0,
						timelineEndSec: 20,
						wordRefs: [],
						origin: "system",
						reason: "",
					},
				],
				gaps: [],
				trimRanges: [],
				muteRanges: [],
				speedRanges: [],
				captionRanges: [],
			},
			annotations: [],
			zoomRanges: [],
			legacyEditor: null,
		};
		await fs.writeFile(projectPath, JSON.stringify(project), "utf8");
		const started = await runCommand(["edit", projectPath]);
		expect(started).toMatchObject({
			ok: true,
			command: "edit",
			host: "127.0.0.1",
			projectId: "proj_cli",
		});
		expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
		await started.server.close();

		const edited = await runCommand([
			"edit",
			"delete",
			projectPath,
			"--start",
			"5",
			"--end",
			"8",
			"--in-place",
		]);
		expect(edited).toMatchObject({
			ok: true,
			operation: "ripple-delete",
			changed: true,
			mediaTouched: false,
			outputPath: projectPath,
		});
		const saved = JSON.parse(await fs.readFile(projectPath, "utf8"));
		expect(saved.timeline.clips.map((clip) => [clip.sourceStartSec, clip.sourceEndSec])).toEqual([
			[0, 5],
			[8, 20],
		]);
		await fs.rm(directory, { recursive: true, force: true });
	});
});
