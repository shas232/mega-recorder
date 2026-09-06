import { spawnSync } from "node:child_process";
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

function writeSilentWav(samplePath, durationSec = 1.25) {
	const sampleRate = 24_000;
	const channels = 1;
	const bitsPerSample = 16;
	const dataSize = Math.round(sampleRate * durationSec) * channels * (bitsPerSample / 8);
	const buffer = Buffer.alloc(44 + dataSize);
	buffer.write("RIFF", 0);
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write("WAVE", 8);
	buffer.write("fmt ", 12);
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(channels, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
	buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
	buffer.writeUInt16LE(bitsPerSample, 34);
	buffer.write("data", 36);
	buffer.writeUInt32LE(dataSize, 40);
	return fs.writeFile(samplePath, buffer);
}

async function withAnimationRuntime(source, callback) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mega-recorder-remotion-runtime-"));
	const runtimePath = path.join(directory, "remotion-runtime.mjs");
	const previous = process.env.MEGA_RECORDER_REMOTION_RUNTIME;
	await fs.writeFile(runtimePath, source, "utf8");
	process.env.MEGA_RECORDER_REMOTION_RUNTIME = runtimePath;
	try {
		return await callback(runtimePath);
	} finally {
		if (previous === undefined) delete process.env.MEGA_RECORDER_REMOTION_RUNTIME;
		else process.env.MEGA_RECORDER_REMOTION_RUNTIME = previous;
		await fs.rm(directory, { recursive: true, force: true });
	}
}

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
		expect(response.preset.background.wallpaper).toMatch(/^linear-gradient\(/);
		expect(response.preset.upstream.editor.wallpaper).toBe(response.preset.background.wallpaper);
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

	it("writes Axcut preset settings into legacyEditor for the renderer", () => {
		const source = {
			schemaVersion: 7,
			project: { id: "axcut_1", title: "Modern project" },
			timeline: { clips: [] },
			legacyEditor: { customSetting: "keep" },
		};

		const next = applyPresetToProject(source, getPreset("blue-studio"));

		expect(next).not.toHaveProperty("version");
		expect(next).not.toHaveProperty("editor");
		expect(next.legacyEditor).toMatchObject({
			customSetting: "keep",
			padding: 40,
			showBlur: true,
			cursorSize: 3,
		});
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
		const fakeRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "mega-recorder-kokoro-doctor-"));
		const fakePython = path.join(fakeRuntime, "python");
		const fakePython3 = path.join(fakeRuntime, "python3");
		const previousPython = process.env.MEGA_RECORDER_KOKORO_PYTHON;
		const previousPath = process.env.PATH;
		try {
			await fs.symlink(process.execPath, fakePython);
			await fs.symlink(process.execPath, fakePython3);
			process.env.MEGA_RECORDER_KOKORO_PYTHON = fakePython;
			process.env.PATH = fakeRuntime;
			const response = await runCommand(["doctor"]);
			expect(response.ready).toBe(
				response.checks.ffprobe.available && response.checks.kokoro.ready,
			);
		} finally {
			if (previousPython === undefined) delete process.env.MEGA_RECORDER_KOKORO_PYTHON;
			else process.env.MEGA_RECORDER_KOKORO_PYTHON = previousPython;
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			await fs.rm(fakeRuntime, { recursive: true, force: true });
		}
	}, 60_000);

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

	it("diagnoses a missing optional animation runtime without affecting recording commands", async () => {
		const previous = process.env.MEGA_RECORDER_REMOTION_RUNTIME;
		process.env.MEGA_RECORDER_REMOTION_RUNTIME = path.join(
			os.tmpdir(),
			"mega-recorder-remotion-runtime-that-does-not-exist.mjs",
		);
		try {
			const response = await runCommand(["animation", "doctor"]);
			expect(response).toMatchObject({
				ok: false,
				command: "animation doctor",
				error: { code: "REMOTION_RUNTIME_UNAVAILABLE" },
			});
		} finally {
			if (previous === undefined) delete process.env.MEGA_RECORDER_REMOTION_RUNTIME;
			else process.env.MEGA_RECORDER_REMOTION_RUNTIME = previous;
		}
	});

	it("validates animation arguments before loading the optional runtime", async () => {
		expect(await runCommand(["animation", "render"])).toMatchObject({
			ok: false,
			command: "animation render",
			error: { code: "CLI_ARGUMENT_ERROR" },
		});
		expect(await runCommand(["animation", "init", "--mode", "invalid"])).toMatchObject({
			ok: false,
			command: "animation init",
			error: { code: "CLI_ARGUMENT_ERROR" },
		});
		expect(await runCommand(["animation", "doctor", "--browser-path", "/tmp/brave"])).toMatchObject(
			{
				ok: false,
				command: "animation doctor",
				error: { code: "CLI_ARGUMENT_ERROR" },
			},
		);
	});

	it("refuses to overwrite an animation init target and dispatches source-only runtime calls", async () => {
		const source = `
		export async function doctor(options) { return { marker: "doctor", options }; }
		export async function setup(options) { return { marker: "setup", options }; }
		export async function init(options) { return { marker: "init", options }; }
		export async function validate(options) { return { marker: "validate", options }; }
		export async function render(options) { return { marker: "render", options }; }
		export async function preview(options) { return { marker: "preview", options }; }
	`;
		await withAnimationRuntime(source, async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mega-recorder-animation-cli-"));
			try {
				const existing = path.join(directory, "existing.json");
				await fs.writeFile(existing, "keep-me", "utf8");
				const refused = await runCommand(["animation", "init", "--output", existing]);
				expect(refused).toMatchObject({
					ok: false,
					command: "animation init",
					error: { code: "OUTPUT_EXISTS", path: existing },
				});
				expect(await fs.readFile(existing, "utf8")).toBe("keep-me");

				const project = path.join(directory, "animation.json");
				const doctor = await runCommand(["animation", "doctor"]);
				expect(doctor).toMatchObject({ ok: true, command: "animation doctor", marker: "doctor" });

				const setup = await runCommand(["animation", "setup", "--skip-install"]);
				expect(setup).toMatchObject({
					ok: true,
					command: "animation setup",
					marker: "setup",
					options: { install: false },
				});

				const initialized = await runCommand([
					"animation",
					"init",
					"--output",
					project,
					"--mode",
					"mixed",
					"--width",
					"1280",
					"--height",
					"720",
					"--fps",
					"30",
				]);
				expect(initialized).toMatchObject({ ok: true, command: "animation init", marker: "init" });
				expect(initialized.options).toMatchObject({
					outputPath: project,
					mode: "mixed",
					width: 1280,
					height: 720,
					fps: 30,
				});

				const rendered = await runCommand([
					"animation",
					"render",
					project,
					"--output",
					path.join(directory, "out.mp4"),
					"--browser-path",
					"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
				]);
				expect(rendered).toMatchObject({ ok: true, command: "animation render", marker: "render" });
				expect(rendered.options).toMatchObject({ manifestPath: project });

				const preview = await runCommand(["animation", "preview", project, "--port", "4311"]);
				expect(preview).toMatchObject({
					ok: true,
					command: "animation preview",
					marker: "preview",
					options: { manifestPath: project, port: 4311 },
				});
			} finally {
				await fs.rm(directory, { recursive: true, force: true });
			}
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

	it("crops every clip to a sibling project without touching source media", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mega-recorder-crop-"));
		try {
			const projectPath = path.join(directory, "demo.openscreen");
			const project = {
				schemaVersion: 7,
				project: { id: "proj_crop_cli", title: "Crop CLI", primaryAssetId: "asset_1" },
				assets: [
					{
						id: "asset_1",
						kind: "video",
						label: "Capture",
						originalPath: "/tmp/capture.mp4",
						durationSec: 12,
					},
				],
				timeline: {
					clips: [
						{
							id: "clip_1",
							assetId: "asset_1",
							sourceStartSec: 0,
							sourceEndSec: 4,
							timelineStartSec: 0,
							timelineEndSec: 4,
							wordRefs: [],
							origin: "system",
							reason: "",
						},
						{
							id: "clip_2",
							assetId: "asset_1",
							sourceStartSec: 8,
							sourceEndSec: 12,
							timelineStartSec: 4,
							timelineEndSec: 8,
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
					audioTracks: [],
				},
				annotations: [],
				zoomRanges: [],
				legacyEditor: null,
			};
			const original = JSON.stringify(project);
			await fs.writeFile(projectPath, original, "utf8");

			const response = await runCommand(["edit", "crop", projectPath, "--top", "0.08"]);
			const outputPath = path.join(directory, "demo.cropped.openscreen");
			expect(response).toMatchObject({
				ok: true,
				command: "edit crop",
				operation: "crop",
				outputPath,
				clipCount: 2,
				mediaTouched: false,
				cropRegion: { x: 0, y: 0.08, width: 1, height: 0.92 },
			});
			const saved = JSON.parse(await fs.readFile(outputPath, "utf8"));
			expect(saved.timeline.clips.map((clip) => clip.cropRegion)).toEqual([
				{ x: 0, y: 0.08, width: 1, height: 0.92 },
				{ x: 0, y: 0.08, width: 1, height: 0.92 },
			]);
			expect(await fs.readFile(projectPath, "utf8")).toBe(original);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it.skipIf(spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status !== 0)(
		"attaches a real probed WAV to an Axcut project and persists timing/mix policy",
		async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mega-recorder-audio-"));
			try {
				const projectPath = path.join(directory, "demo.openscreen");
				const audioPath = path.join(directory, "kokoro.wav");
				await writeSilentWav(audioPath, 1.25);
				await fs.writeFile(
					projectPath,
					JSON.stringify({
						schemaVersion: 7,
						project: {
							id: "proj_audio",
							title: "Audio test",
							primaryAssetId: "asset_1",
						},
						assets: [
							{
								id: "asset_1",
								kind: "video",
								label: "Capture",
								originalPath: "/tmp/capture.mp4",
								durationSec: 10,
							},
						],
						timeline: { clips: [], audioTracks: [] },
						annotations: [],
						zoomRanges: [],
						legacyEditor: null,
					}),
					"utf8",
				);
				const response = await runCommand([
					"audio",
					"attach",
					projectPath,
					"--file",
					audioPath,
					"--voice",
					"af_heart",
					"--label",
					"Kokoro intro",
					"--start",
					"3",
					"--mode",
					"replace",
					"--in-place",
				]);
				expect(response).toMatchObject({
					ok: true,
					command: "audio attach",
					mode: "replace",
					track: {
						kind: "narration",
						voice: "af_heart",
						timelineStartSec: 3,
						status: "ready",
					},
				});
				const saved = JSON.parse(await fs.readFile(projectPath, "utf8"));
				expect(saved.timeline.audioMixMode).toBe("replace");
				expect(saved.timeline.audioTracks).toHaveLength(1);
				expect(saved.timeline.audioTracks[0]).toMatchObject({
					label: "Kokoro intro",
					sourcePath: audioPath,
					timelineStartSec: 3,
					timelineEndSec: 4.25,
					sourceStartSec: 0,
					voice: "af_heart",
				});
			} finally {
				await fs.rm(directory, { recursive: true, force: true });
			}
		},
	);
});
