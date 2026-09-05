#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	ACTION_MANIFEST_SCHEMA_VERSION,
	addActionToManifest,
	applyActionsToDocument,
	findCursorTelemetryClick,
	normalizeActionManifest,
	readActionManifest,
	startActionManifest,
	writeActionManifest,
} from "./mega-recorder/actions.mjs";
import { createBrowserEditorServer } from "./mega-recorder/browser-editor-server.mjs";
import {
	applyCropToDocument,
	cropRegionFromEdges,
	isIdentityCrop,
	normalizeCropRegion,
	parseCropRegion,
} from "./mega-recorder/crop.mjs";
import {
	KOKORO_MODEL_ID,
	KOKORO_SAMPLE_RATE,
	kokoroDoctor,
	resolveDefaultVoice,
	synthesizeWithKokoro,
} from "./mega-recorder/kokoro.mjs";
import {
	buildManifest,
	hashFiles,
	hashNarration,
	updateManifest,
} from "./mega-recorder/manifest.mjs";
import {
	addOverlayToDocument,
	createOverlay,
	OVERLAY_ANCHORS,
	OVERLAY_TYPES,
	removeOverlayFromDocument,
	validateOverlay,
} from "./mega-recorder/overlays.mjs";
import { applyPresetToProject, getPreset, listPresets } from "./mega-recorder/preset.mjs";
import {
	readRecordingClock,
	timestampFromRecordingClock,
} from "./mega-recorder/recording-clock.mjs";
import {
	addSceneToManifest,
	applyScenesToDocument,
	normalizeSceneManifest,
	readSceneManifest,
	reviseSceneInManifest,
	startSceneManifest,
	writeSceneManifest,
} from "./mega-recorder/scenes.mjs";
import { deleteRangeFromDocument, writeDocumentAtomically } from "./mega-recorder/timeline.mjs";
import { probeMedia, verifyMedia } from "./mega-recorder/verify.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const BASELINE_PATH = path.join(REPO_ROOT, "mega-recorder.manifest.json");
const PACKAGE_PATH = path.join(REPO_ROOT, "package.json");

const USAGE = [
	"MEGA RECORDER",
	"",
	"Usage:",
	"  mega-recorder doctor",
	"  mega-recorder preset show [name]",
	"  mega-recorder preset apply <name> --project <file> [--output <file>] [--in-place]",
	"  mega-recorder kokoro doctor",
	"  mega-recorder kokoro synthesize (--text <text> | --text-file <file>) [options]",
	"  mega-recorder verify <media> [options]",
	"  mega-recorder actions start [project] --output <manifest> [--clock-file <file>]",
	"  mega-recorder actions add <manifest> --time <seconds|auto> --label <text> (--point <x,y> | --rect <x,y,w,h>) [--clock-file <file>] [--recording <video>] [--output <manifest>]",
	"  mega-recorder actions reconcile <manifest> --recording <video> [--output <manifest>] [--tolerance-ms <ms>]",
	"  mega-recorder actions list <manifest>",
	"  mega-recorder actions import <manifest> --output <manifest>",
	"  mega-recorder actions apply <project> --manifest <manifest> [--output <file> | --in-place] [--callouts]",
	"  mega-recorder scenes start [project] --output <manifest> [--clock-file <file>]",
	"  mega-recorder scenes add <manifest> --name <name> --start <seconds> --end <seconds> [--text <text>] [--id <id>] [--audio-track-ids <ids>] [--overlay-ids <ids>]",
	"  mega-recorder scenes list <manifest>",
	"  mega-recorder scenes apply <project> --manifest <manifest> [--output <file> | --in-place]",
	"  mega-recorder scenes revise <project> --scene-id <id> [--name <name>] [--start <seconds>] [--end <seconds>] [--text <text>] [--output <file> | --in-place]",
	"  mega-recorder edit <project> [--port <port>]  (browser editor; localhost only)",
	"  mega-recorder edit crop <project> (--region <x,y,w,h> | edge flags) [--clip-id <id>] [--output <file> | --in-place]",
	"  mega-recorder edit delete <project> --start <seconds> --end <seconds> [--output <file> | --in-place]",
	"  mega-recorder edit overlay add <project> --start <seconds> --end <seconds> --text <text> [--type title|label|callout|lower-third] [options]",
	"  mega-recorder edit overlay list <project>",
	"  mega-recorder edit overlay remove <project> --id <overlay-id> [--output <file> | --in-place]",
	"  mega-recorder audio attach <project> --file <audio> [--start <seconds>] [options]",
	"  mega-recorder record|export <upstream options>  (delegates to OpenScreen)",
	"",
	"Every command writes one stable JSON object to stdout. Diagnostics belong on stderr.",
	"Kokoro is local-only: no narration text is uploaded and model downloads are disabled.",
].join("\n");

function result(command, fields = {}) {
	return { ok: true, command, ...fields };
}

function failure(command, code, message, details = {}) {
	return {
		ok: false,
		command,
		error: { code, message, ...details },
	};
}

function printJson(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function expandPath(value) {
	return path.resolve(value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value);
}

function parseTokens(tokens) {
	const positional = [];
	const values = new Map();
	const flags = new Set();
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token.startsWith("-")) {
			positional.push(token);
			continue;
		}
		const equalsIndex = token.indexOf("=");
		const flag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
		const inline = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
		if (inline !== undefined) {
			values.set(flag, inline);
			continue;
		}
		const next = tokens[index + 1];
		if (next !== undefined && !next.startsWith("-")) {
			values.set(flag, next);
			index += 1;
		} else {
			flags.add(flag);
		}
	}
	return { positional, values, flags };
}

function optionValue(parsed, ...names) {
	for (const name of names) {
		if (parsed.values.has(name)) return parsed.values.get(name);
	}
	return undefined;
}

function requiredValue(parsed, names, label) {
	const value = optionValue(parsed, ...names);
	if (value === undefined || value.trim() === "") {
		throw Object.assign(new Error(`${label} requires a value`), { code: "CLI_ARGUMENT_ERROR" });
	}
	return value;
}

function validateParsedOptions(parsed, allowed, command) {
	const unknown = [...parsed.values.keys(), ...parsed.flags].find((name) => !allowed.has(name));
	if (unknown) {
		throw Object.assign(new Error(`Unknown ${command} option: ${unknown}`), {
			code: "CLI_ARGUMENT_ERROR",
		});
	}
}

function validateRequiredValueOptions(parsed, names, command) {
	const missing = names.find((name) => parsed.flags.has(name));
	if (missing) {
		throw Object.assign(new Error(`${missing} requires a value for ${command}`), {
			code: "CLI_ARGUMENT_ERROR",
		});
	}
}

function validatePositionalCount(parsed, maximum, command) {
	if (parsed.positional.length > maximum) {
		throw Object.assign(new Error(`Unexpected extra argument: ${parsed.positional[maximum]}`), {
			code: "CLI_ARGUMENT_ERROR",
		});
	}
}

function canonicalPath(value) {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertDistinctPath(candidate, protectedPaths, label) {
	const candidatePath = canonicalPath(candidate);
	for (const protectedPath of protectedPaths) {
		if (candidatePath === canonicalPath(protectedPath)) {
			throw Object.assign(new Error(`${label} must not overwrite ${protectedPath}`), {
				code: "CLI_ARGUMENT_ERROR",
			});
		}
	}
}

function numberValue(parsed, names, label, { integer = false, min = 0 } = {}) {
	const raw = optionValue(parsed, ...names);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (
		raw.trim() === "" ||
		!Number.isFinite(value) ||
		value < min ||
		(integer && !Number.isInteger(value))
	) {
		throw Object.assign(new Error(`${label} must be a valid number`), {
			code: "CLI_ARGUMENT_ERROR",
		});
	}
	return value;
}

function idListValue(parsed, names, label) {
	const raw = optionValue(parsed, ...names);
	if (raw === undefined) return undefined;
	const values = raw
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (values.length === 0)
		throw Object.assign(new Error(`${label} must contain at least one id`), {
			code: "CLI_ARGUMENT_ERROR",
		});
	return [...new Set(values)];
}

async function readJson(filePath) {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8"));
	} catch (error) {
		throw Object.assign(new Error(`Unable to read JSON file: ${filePath}`), {
			code: error?.code === "ENOENT" ? "FILE_NOT_FOUND" : "INVALID_JSON",
			path: filePath,
		});
	}
}

async function readBaseline() {
	try {
		return await readJson(BASELINE_PATH);
	} catch {
		return { project: {} };
	}
}

async function commandVersion() {
	try {
		const packageJson = await readJson(PACKAGE_PATH);
		return packageJson.version ?? null;
	} catch {
		return null;
	}
}

function executableStatus(executable, args = ["--version"]) {
	const started = spawnSync(executable, args, { encoding: "utf8" });
	return {
		available: started.error === undefined && started.status === 0,
		path: executable,
		version: started.status === 0 ? (started.stdout ?? "").trim().split(/\r?\n/)[0] || null : null,
		error:
			started.error?.message ??
			(started.status !== 0 ? (started.stderr ?? "").trim() || null : null),
	};
}

const NATIVE_MAC_PAYLOADS = [
	"openscreen-screencapturekit-helper",
	"openscreen-macos-cursor-helper",
	"compositor_view.node",
	"libavformat.62.dylib",
	"libavcodec.62.dylib",
	"libavutil.60.dylib",
	"libswscale.9.dylib",
	"libswresample.6.dylib",
];

async function nativePayloadStatus() {
	if (process.platform !== "darwin") {
		return {
			supported: false,
			ready: false,
			platform: process.platform,
			architecture: process.arch,
			note: "Pinned MEGA RECORDER native payloads are currently macOS-only.",
		};
	}
	const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
	const tag = `darwin-${arch}`;
	const directory = path.join(REPO_ROOT, "electron", "native", "bin", tag);
	const files = {};
	for (const name of NATIVE_MAC_PAYLOADS) {
		const candidate = path.join(directory, name);
		try {
			const info = await fs.stat(candidate);
			files[name] = {
				path: candidate,
				present: info.isFile(),
				executable: (info.mode & 0o111) !== 0,
			};
		} catch {
			files[name] = { path: candidate, present: false, executable: false };
		}
	}
	let marker = null;
	try {
		marker = JSON.parse(
			await fs.readFile(path.join(directory, ".mega-recorder-native.json"), "utf8"),
		);
	} catch {
		// Local source builds do not have a release marker; the helper paths above
		// remain useful diagnostics, while the skill verifier requires provenance.
	}
	const helperArtifactsPresent = [
		"openscreen-screencapturekit-helper",
		"openscreen-macos-cursor-helper",
	].every((name) => files[name]?.present && files[name]?.executable);
	const exportArtifactsPresent = [
		"compositor_view.node",
		"libavformat.62.dylib",
		"libavcodec.62.dylib",
		"libavutil.60.dylib",
		"libswscale.9.dylib",
		"libswresample.6.dylib",
	].every((name) => files[name]?.present);
	return {
		supported: arch === "arm64" || arch === "x64",
		ready: helperArtifactsPresent && exportArtifactsPresent,
		platform: process.platform,
		architecture: arch,
		tag,
		directory,
		helperArtifactsPresent,
		exportArtifactsPresent,
		provenance: marker?.release ? "verified-release" : "local-or-unknown",
		release: marker?.release ?? null,
		files,
	};
}

export async function runDoctor() {
	const [baseline, version, kokoro, native] = await Promise.all([
		readBaseline(),
		commandVersion(),
		kokoroDoctor(),
		nativePayloadStatus(),
	]);
	const ffprobe = executableStatus(process.env.MEGA_RECORDER_FFPROBE || "ffprobe", ["-version"]);
	return result("doctor", {
		product: "MEGA RECORDER",
		version,
		upstream: {
			repository: baseline.project?.upstreamRepository ?? null,
			commit: baseline.project?.upstreamCommit ?? null,
		},
		checks: {
			ffprobe,
			kokoro: {
				ready: kokoro.ready,
				model: kokoro.model,
				defaultVoice: kokoro.defaultVoice,
				modelCache: kokoro.modelCache,
			},
			nativeCapture: {
				status: "delegated",
				...native,
				note: "Recording uses the upstream Electron/native pipeline; this command does not fake capture.",
			},
		},
		ready: ffprobe.available && kokoro.ready,
		localOnly: true,
	});
}

export function showPreset(name = "blue-studio") {
	const preset = getPreset(name);
	if (!preset)
		return failure("preset show", "PRESET_NOT_FOUND", `Unknown preset: ${name}`, {
			available: listPresets().map((item) => item.id),
		});
	return result("preset show", { preset });
}

async function applyPreset(tokens) {
	const parsed = parseTokens(tokens);
	validateParsedOptions(
		parsed,
		new Set(["--project", "-p", "--output", "--out", "-o", "--in-place", "--manifest"]),
		"preset apply",
	);
	validateRequiredValueOptions(
		parsed,
		["--project", "-p", "--output", "--out", "-o", "--manifest"],
		"preset apply",
	);
	validatePositionalCount(parsed, 1, "preset apply");
	const name = parsed.positional[0] ?? "blue-studio";
	const preset = getPreset(name);
	if (!preset) return failure("preset apply", "PRESET_NOT_FOUND", `Unknown preset: ${name}`);
	const projectPath = expandPath(requiredValue(parsed, ["--project", "-p"], "--project"));
	const source = await readJson(projectPath);
	const project = applyPresetToProject(source, preset);
	const inputHashes = await hashFiles([projectPath]);
	const requestedOutput = optionValue(parsed, "--output", "--out", "-o");
	const inPlace = parsed.flags.has("--in-place");
	if (inPlace && requestedOutput !== undefined) {
		throw Object.assign(new Error("Use either --in-place or --output, not both"), {
			code: "CLI_ARGUMENT_ERROR",
		});
	}
	const outputPath = inPlace
		? projectPath
		: expandPath(
				requestedOutput ?? `${projectPath.replace(/\.openscreen$/i, "")}.${preset.id}.openscreen`,
			);
	if (!inPlace) assertDistinctPath(outputPath, [projectPath], "Preset output");
	const manifestPath = optionValue(parsed, "--manifest");
	const absoluteManifestPath = manifestPath ? expandPath(manifestPath) : null;
	if (absoluteManifestPath) {
		assertDistinctPath(absoluteManifestPath, [outputPath, projectPath], "Manifest path");
	}
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	const temporary = `${outputPath}.${process.pid}.tmp`;
	try {
		await fs.writeFile(temporary, `${JSON.stringify(project, null, 2)}\n`, "utf8");
		await fs.rename(temporary, outputPath);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
		throw Object.assign(new Error(`Unable to write preset project: ${outputPath}`), {
			code: "OUTPUT_WRITE_FAILED",
			cause: error,
		});
	}
	const [outputs, baseline] = await Promise.all([hashFiles([outputPath]), readBaseline()]);
	let manifest = null;
	if (absoluteManifestPath) {
		manifest = await updateManifest(
			absoluteManifestPath,
			buildManifest({ baseline, preset, inputs: inputHashes, outputs, command: "preset apply" }),
		);
	}
	return result("preset apply", {
		preset: { id: preset.id, version: preset.contractVersion },
		outputPath,
		manifest,
	});
}

async function runKokoroDoctor() {
	const details = await kokoroDoctor();
	return result("kokoro doctor", {
		ready: details.ready,
		model: details.model,
		defaultVoice: details.defaultVoice,
		modelCache: details.modelCache,
		runtime: details.runtime,
		attempts: details.attempts,
		sampleRate: details.sampleRate,
		network: "disabled",
		localOnly: true,
	});
}

async function synthesize(tokens) {
	const parsed = parseTokens(tokens);
	validateParsedOptions(
		parsed,
		new Set([
			"--text",
			"--text-file",
			"--file",
			"--voice",
			"--output",
			"--out",
			"-o",
			"--manifest",
		]),
		"kokoro synthesize",
	);
	validateRequiredValueOptions(
		parsed,
		["--text", "--text-file", "--file", "--voice", "--output", "--out", "-o", "--manifest"],
		"kokoro synthesize",
	);
	validatePositionalCount(parsed, 0, "kokoro synthesize");
	const text = optionValue(parsed, "--text");
	const textFile = optionValue(parsed, "--text-file", "--file");
	if (text !== undefined && textFile !== undefined) {
		throw Object.assign(new Error("Use only one of --text or --text-file"), {
			code: "CLI_ARGUMENT_ERROR",
		});
	}
	if (text === undefined && textFile === undefined) {
		throw Object.assign(new Error("Kokoro synthesis requires --text or --text-file"), {
			code: "CLI_ARGUMENT_ERROR",
		});
	}
	const narration = textFile === undefined ? text : await fs.readFile(expandPath(textFile), "utf8");
	if (!narration.trim()) {
		throw Object.assign(new Error("Narration text is empty"), { code: "NARRATION_EMPTY" });
	}
	const voice = optionValue(parsed, "--voice") ?? (await resolveDefaultVoice());
	const outputPath = expandPath(optionValue(parsed, "--output", "--out", "-o") ?? "narration.wav");
	const manifestPath = optionValue(parsed, "--manifest");
	const absoluteManifestPath = manifestPath ? expandPath(manifestPath) : null;
	if (absoluteManifestPath) assertDistinctPath(absoluteManifestPath, [outputPath], "Manifest path");
	await synthesizeWithKokoro({ text: narration, voice, outputPath });
	const probed = await probeMedia(outputPath);
	const observedSampleRate = probed.metadata.audio?.sampleRate ?? null;
	if (!probed.metadata.audio || observedSampleRate !== KOKORO_SAMPLE_RATE) {
		throw Object.assign(
			new Error(
				`Kokoro output sample rate is ${observedSampleRate ?? "unknown"}; expected ${KOKORO_SAMPLE_RATE}`,
			),
			{
				code: "AUDIO_SAMPLE_RATE_MISMATCH",
				expected: KOKORO_SAMPLE_RATE,
				actual: observedSampleRate,
			},
		);
	}
	const [inputHash, outputHash, baseline] = await Promise.all([
		hashNarration(narration, textFile ? expandPath(textFile) : "stdin"),
		hashFiles([outputPath]),
		readBaseline(),
	]);
	let manifest = null;
	if (absoluteManifestPath) {
		manifest = await updateManifest(
			absoluteManifestPath,
			buildManifest({
				baseline,
				inputs: [inputHash],
				outputs: outputHash,
				kokoro: {
					model: KOKORO_MODEL_ID,
					voice,
					sampleRate: KOKORO_SAMPLE_RATE,
				},
				command: "kokoro synthesize",
			}),
		);
	}
	return result("kokoro synthesize", {
		outputPath,
		voice,
		model: KOKORO_MODEL_ID,
		sampleRate: observedSampleRate,
		codec: probed.metadata.audio.codec,
		input: inputHash,
		output: outputHash[0],
		manifest,
		localOnly: true,
	});
}

function verifyExpected(tokens) {
	const parsed = parseTokens(tokens);
	validateParsedOptions(
		parsed,
		new Set([
			"--preset",
			"--width",
			"--height",
			"--fps",
			"--duration",
			"--duration-tolerance",
			"--fps-tolerance",
			"--video-codec",
			"--audio-codec",
			"--sample-rate",
			"--manifest",
			"--write-manifest",
		]),
		"verify",
	);
	validateRequiredValueOptions(
		parsed,
		[
			"--preset",
			"--width",
			"--height",
			"--fps",
			"--duration",
			"--duration-tolerance",
			"--fps-tolerance",
			"--video-codec",
			"--audio-codec",
			"--sample-rate",
			"--manifest",
			"--write-manifest",
		],
		"verify",
	);
	validatePositionalCount(parsed, 1, "verify");
	const presetName = optionValue(parsed, "--preset");
	const preset = presetName ? getPreset(presetName) : null;
	if (presetName && !preset) {
		throw Object.assign(new Error(`Unknown preset: ${presetName}`), { code: "PRESET_NOT_FOUND" });
	}
	const expected = {
		width:
			numberValue(parsed, ["--width"], "--width", { integer: true, min: 1 }) ??
			preset?.canvas.width,
		height:
			numberValue(parsed, ["--height"], "--height", { integer: true, min: 1 }) ??
			preset?.canvas.height,
		fps: numberValue(parsed, ["--fps"], "--fps", { min: 0 }) ?? preset?.canvas.fps,
		durationSec: numberValue(parsed, ["--duration"], "--duration", { min: 0 }),
		durationTolerance:
			numberValue(parsed, ["--duration-tolerance"], "--duration-tolerance", { min: 0 }) ?? 0.1,
		fpsTolerance: numberValue(parsed, ["--fps-tolerance"], "--fps-tolerance", { min: 0 }) ?? 0.01,
		videoCodec: optionValue(parsed, "--video-codec"),
		audioCodec: optionValue(parsed, "--audio-codec"),
		sampleRate: numberValue(parsed, ["--sample-rate"], "--sample-rate", { integer: true, min: 1 }),
	};
	return { parsed, expected, preset };
}

async function verifyCommand(tokens) {
	const { parsed, expected, preset } = verifyExpected(tokens);
	const mediaPath = parsed.positional[0];
	if (!mediaPath) {
		throw Object.assign(new Error("verify requires a media path"), { code: "CLI_ARGUMENT_ERROR" });
	}
	const absoluteMediaPath = expandPath(mediaPath);
	const verification = await verifyMedia(absoluteMediaPath, expected);
	const [inputHash, baseline] = await Promise.all([hashFiles([absoluteMediaPath]), readBaseline()]);
	const manifestPath = optionValue(parsed, "--manifest", "--write-manifest");
	const absoluteManifestPath = manifestPath ? expandPath(manifestPath) : null;
	if (absoluteManifestPath)
		assertDistinctPath(absoluteManifestPath, [absoluteMediaPath], "Manifest path");
	let manifest = null;
	if (absoluteManifestPath) {
		manifest = await updateManifest(
			absoluteManifestPath,
			buildManifest({
				baseline,
				preset,
				inputs: inputHash,
				verification,
				command: "verify",
			}),
		);
	}
	return {
		ok: verification.passed,
		command: "verify",
		media: verification.path,
		metadata: verification.metadata,
		verification: {
			passed: verification.passed,
			expected,
			checks: verification.checks,
			errors: verification.errors,
		},
		input: inputHash[0],
		manifest,
	};
}

function coordinateList(raw, count, label) {
	const values = String(raw ?? "")
		.split(/[\s,]+/)
		.filter(Boolean)
		.map(Number);
	if (values.length !== count || values.some((value) => !Number.isFinite(value))) {
		throw Object.assign(new Error(`${label} must contain ${count} finite numbers`), {
			code: "CLI_ARGUMENT_ERROR",
		});
	}
	return values;
}

function actionFromParsed(parsed, timing = {}) {
	const time = optionValue(parsed, "--time", "--timestamp", "--timestamp-sec");
	const label = requiredValue(parsed, ["--label"], "--label");
	const autoTime = time === "auto" || parsed.flags.has("--auto-time");
	if (time === undefined && !autoTime) {
		throw Object.assign(new Error("actions add requires --time"), { code: "CLI_ARGUMENT_ERROR" });
	}
	if (autoTime && timing.timestampSec === undefined) {
		throw Object.assign(
			new Error(
				"actions add --time auto requires a recording clock (--clock-file) or a finished recording with cursor telemetry (--recording)",
			),
			{ code: "CLI_ARGUMENT_ERROR" },
		);
	}
	const action = {
		timestampSec: autoTime ? timing.timestampSec : Number(time),
		label,
		...(autoTime && timing.timestampSource ? { timestampSource: timing.timestampSource } : {}),
		...(autoTime && timing.timestampAccuracy
			? { timestampAccuracy: timing.timestampAccuracy }
			: {}),
		...(autoTime && timing.observedAtEpochMs !== undefined
			? { observedAtEpochMs: timing.observedAtEpochMs }
			: {}),
	};
	const point = optionValue(parsed, "--point");
	const rect = optionValue(parsed, "--rect", "--target-rect");
	if (point !== undefined && rect !== undefined)
		throw Object.assign(new Error("Use either --point or --rect, not both"), {
			code: "CLI_ARGUMENT_ERROR",
		});
	if (point === undefined && rect === undefined)
		throw Object.assign(new Error("actions add requires --point or --rect"), {
			code: "CLI_ARGUMENT_ERROR",
		});
	if (point !== undefined) {
		const [x, y] = coordinateList(point, 2, "--point");
		action.point = { x, y };
	}
	if (rect !== undefined) {
		const [x, y, width, height] = coordinateList(rect, 4, "--rect");
		action.targetRect = { x, y, width, height };
	}
	const sceneId = optionValue(parsed, "--scene-id");
	const id = optionValue(parsed, "--id");
	if (sceneId !== undefined) action.sceneId = sceneId;
	if (id !== undefined) action.id = id;
	return action;
}

async function resolveAutoActionTiming(parsed, manifestPath, manifest) {
	const time = optionValue(parsed, "--time", "--timestamp", "--timestamp-sec");
	const autoTime = time === "auto" || parsed.flags.has("--auto-time");
	if (!autoTime) return {};
	const observedAtEpochMs = Date.now();
	const pointValue = optionValue(parsed, "--point");
	const rectValue = optionValue(parsed, "--rect", "--target-rect");
	const target =
		pointValue !== undefined
			? {
					point: (() => {
						const [x, y] = coordinateList(pointValue, 2, "--point");
						return { x, y };
					})(),
				}
			: rectValue !== undefined
				? {
						targetRect: (() => {
							const [x, y, width, height] = coordinateList(rectValue, 4, "--rect");
							return { x, y, width, height };
						})(),
					}
				: {};
	const recordingValue = optionValue(parsed, "--recording", "--media");
	const recordingPath = recordingValue ? expandPath(recordingValue) : null;
	const clockValue =
		optionValue(parsed, "--clock-file", "--recording-clock") ?? manifest.recordingClockPath;
	const clockPath = clockValue === undefined ? undefined : expandPath(clockValue);
	const clock = clockPath === undefined ? null : await readRecordingClock(clockPath);
	if (clock?.status === "stopped") {
		throw Object.assign(
			new Error(
				"actions add --time auto cannot use a stopped recording clock; provide an explicit --time value for post-processing",
			),
			{ code: "ACTION_CLOCK_STOPPED" },
		);
	}
	if (recordingPath) {
		const click = await findCursorTelemetryClick(recordingPath, target, {
			expectedTimeMs:
				clock === null
					? undefined
					: timestampFromRecordingClock(clock, { epochMs: observedAtEpochMs }) * 1000,
		});
		if (click) {
			return {
				timestampSec: click.timeMs / 1000,
				timestampSource: "cursor-telemetry",
				timestampAccuracy: "exact",
				observedAtEpochMs,
			};
		}
	}
	if (clock === null || clockPath === undefined) {
		throw Object.assign(
			new Error(
				"actions add --time auto requires --clock-file or a finished recording with native click telemetry (--recording)",
			),
			{ code: "ACTION_CLOCK_MISSING" },
		);
	}
	return {
		timestampSec: timestampFromRecordingClock(clock, { epochMs: observedAtEpochMs }),
		timestampSource: "recording-clock",
		timestampAccuracy: "approximate",
		observedAtEpochMs,
		clockPath,
	};
}

async function actionsCommand(tokens) {
	const actionName = tokens.shift() ?? "list";
	const command = `actions ${actionName}`;
	if (actionName === "start") {
		const parsed = parseTokens(tokens);
		validateParsedOptions(
			parsed,
			new Set([
				"--output",
				"--out",
				"-o",
				"--project",
				"-p",
				"--project-id",
				"--asset-id",
				"--clock-file",
				"--recording-clock",
			]),
			command,
		);
		validateRequiredValueOptions(
			parsed,
			["--output", "--out", "-o", "--project", "-p", "--project-id", "--asset-id"],
			command,
		);
		validatePositionalCount(parsed, 1, command);
		const projectValue = optionValue(parsed, "--project", "-p") ?? parsed.positional[0];
		let projectId = optionValue(parsed, "--project-id");
		let assetId = optionValue(parsed, "--asset-id");
		if (projectValue) {
			const source = await readJson(expandPath(projectValue));
			projectId ??= source.project?.id;
			assetId ??= source.project?.primaryAssetId ?? source.assets?.[0]?.id;
		}
		const recordingClockValue = optionValue(parsed, "--clock-file", "--recording-clock");
		const recordingClockPath = recordingClockValue ? expandPath(recordingClockValue) : undefined;
		const manifest = startActionManifest({ projectId, assetId, recordingClockPath });
		const outputPath = expandPath(optionValue(parsed, "--output", "--out", "-o") ?? "actions.json");
		await writeActionManifest(outputPath, manifest);
		return result(command, {
			manifestPath: outputPath,
			schemaVersion: ACTION_MANIFEST_SCHEMA_VERSION,
			projectId: manifest.projectId ?? null,
			assetId: manifest.assetId ?? null,
			recordingClockPath: manifest.recordingClockPath ?? null,
			actionCount: 0,
		});
	}
	if (actionName === "add") {
		const parsed = parseTokens(tokens);
		validateParsedOptions(
			parsed,
			new Set([
				"--time",
				"--timestamp",
				"--timestamp-sec",
				"--label",
				"--point",
				"--rect",
				"--target-rect",
				"--scene-id",
				"--id",
				"--clock-file",
				"--recording-clock",
				"--recording",
				"--media",
				"--auto-time",
				"--output",
				"--out",
				"-o",
			]),
			command,
		);
		validateRequiredValueOptions(
			parsed,
			[
				"--time",
				"--timestamp",
				"--timestamp-sec",
				"--label",
				"--point",
				"--rect",
				"--target-rect",
				"--scene-id",
				"--id",
				"--clock-file",
				"--recording-clock",
				"--recording",
				"--media",
				"--output",
				"--out",
				"-o",
			],
			command,
		);
		validatePositionalCount(parsed, 1, command);
		const manifestValue = parsed.positional[0];
		if (!manifestValue)
			throw Object.assign(new Error("actions add requires a manifest path"), {
				code: "CLI_ARGUMENT_ERROR",
			});
		const manifestPath = expandPath(manifestValue);
		const current = await readActionManifest(manifestPath);
		const timing = await resolveAutoActionTiming(parsed, manifestPath, current);
		const next = addActionToManifest(current, actionFromParsed(parsed, timing));
		const outputPath = expandPath(optionValue(parsed, "--output", "--out", "-o") ?? manifestPath);
		await writeActionManifest(outputPath, next);
		return result(command, {
			manifestPath: outputPath,
			action: next.actions.at(-1),
			actionCount: next.actions.length,
		});
	}
	if (actionName === "reconcile") {
		const parsed = parseTokens(tokens);
		validateParsedOptions(
			parsed,
			new Set(["--recording", "--media", "--output", "--out", "-o", "--tolerance-ms"]),
			command,
		);
		validateRequiredValueOptions(
			parsed,
			["--recording", "--media", "--output", "--out", "-o", "--tolerance-ms"],
			command,
		);
		validatePositionalCount(parsed, 1, command);
		const manifestValue = parsed.positional[0];
		if (!manifestValue)
			throw Object.assign(new Error("actions reconcile requires a manifest path"), {
				code: "CLI_ARGUMENT_ERROR",
			});
		const recordingValue = optionValue(parsed, "--recording", "--media");
		if (!recordingValue)
			throw Object.assign(new Error("actions reconcile requires --recording <video>"), {
				code: "CLI_ARGUMENT_ERROR",
			});
		const manifestPath = expandPath(manifestValue);
		const recordingPath = expandPath(recordingValue);
		const current = await readActionManifest(manifestPath);
		const clockPath = current.recordingClockPath;
		const clock = clockPath ? await readRecordingClock(clockPath) : null;
		const toleranceMs =
			numberValue(parsed, ["--tolerance-ms"], "--tolerance-ms", { min: 1 }) ?? 1_500;
		let reconciledCount = 0;
		const unmatchedActionIds = [];
		const actions = await Promise.all(
			current.actions.map(async (action) => {
				if (
					action.timestampAccuracy !== "approximate" &&
					action.timestampSource !== "recording-clock"
				) {
					return action;
				}
				// Without the persisted recording clock, an observed epoch has no
				// source-time origin. Keep the manifest's previously derived source
				// timestamp rather than silently turning it into 0ms.
				const expectedTimeMs =
					clock && action.observedAtEpochMs !== undefined
						? action.observedAtEpochMs - clock.startedAtEpochMs
						: action.timestampSec * 1000;
				const click = await findCursorTelemetryClick(recordingPath, action, {
					expectedTimeMs,
					toleranceMs,
				});
				if (!click) {
					unmatchedActionIds.push(action.id);
					return action;
				}
				reconciledCount += 1;
				return {
					...action,
					timestampSec: click.timeMs / 1000,
					timestampSource: "cursor-telemetry",
					timestampAccuracy: "exact",
				};
			}),
		);
		const next = normalizeActionManifest({ ...current, actions });
		const outputPath = expandPath(optionValue(parsed, "--output", "--out", "-o") ?? manifestPath);
		await writeActionManifest(outputPath, next);
		return result(command, {
			manifestPath: outputPath,
			actionCount: next.actions.length,
			reconciledCount,
			unmatchedActionIds,
		});
	}
	if (actionName === "list") {
		const parsed = parseTokens(tokens);
		validateParsedOptions(parsed, new Set(), command);
		validatePositionalCount(parsed, 1, command);
		const manifestPath = parsed.positional[0];
		if (!manifestPath)
			throw Object.assign(new Error("actions list requires a manifest path"), {
				code: "CLI_ARGUMENT_ERROR",
			});
		const manifest = await readActionManifest(expandPath(manifestPath));
		return result(command, {
			manifestPath: expandPath(manifestPath),
			manifest,
			actions: manifest.actions,
		});
	}
	if (actionName === "import") {
		const parsed = parseTokens(tokens);
		validateParsedOptions(parsed, new Set(["--output", "--out", "-o"]), command);
		validateRequiredValueOptions(parsed, ["--output", "--out", "-o"], command);
		validatePositionalCount(parsed, 1, command);
		const inputPath = parsed.positional[0];
		if (!inputPath)
			throw Object.assign(new Error("actions import requires an input path"), {
				code: "CLI_ARGUMENT_ERROR",
			});
		const outputPath = expandPath(
			optionValue(parsed, "--output", "--out", "-o") ?? "actions.imported.json",
		);
		const manifest = normalizeActionManifest(await readJson(expandPath(inputPath)));
		await writeActionManifest(outputPath, manifest);
		return result(command, {
			inputPath: expandPath(inputPath),
			manifestPath: outputPath,
			actionCount: manifest.actions.length,
		});
	}
	if (actionName === "apply") {
		const parsed = parseTokens(tokens);
		validateParsedOptions(
			parsed,
			new Set(["--manifest", "--output", "--out", "-o", "--in-place", "--callouts"]),
			command,
		);
		validateRequiredValueOptions(parsed, ["--manifest", "--output", "--out", "-o"], command);
		validatePositionalCount(parsed, 1, command);
		const projectValue = parsed.positional[0];
		if (!projectValue)
			throw Object.assign(new Error("actions apply requires a project path"), {
				code: "CLI_ARGUMENT_ERROR",
			});
		const projectPath = expandPath(projectValue);
		const manifestPath = expandPath(requiredValue(parsed, ["--manifest"], "--manifest"));
		const source = await readJson(projectPath);
		// Native recordings commonly arrive as legacy v2 sidecars. Promote them
		// before applying source-time actions so the same command works for both
		// freshly-recorded and already-migrated projects.
		const document = await migrateLegacyProjectForCli(source);
		const manifest = await readActionManifest(manifestPath);
		const applied = applyActionsToDocument(document, manifest, {
			includeCallouts: parsed.flags.has("--callouts"),
		});
		const outputPath = editOutputPath(projectPath, parsed);
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		if (outputPath === projectPath) await writeDocumentAtomically(outputPath, applied.document);
		else await writeDocumentAtomically(outputPath, applied.document);
		const assetId =
			manifest.assetId ??
			applied.document.project?.primaryAssetId ??
			applied.document.assets?.[0]?.id;
		const asset = applied.document.assets?.find((item) => item.id === assetId);
		let cursorTelemetryPath = null;
		let cursorTelemetryPreserved = false;
		if (asset?.originalPath) {
			cursorTelemetryPath = `${asset.originalPath}.cursor.json`;
			cursorTelemetryPreserved = await fs
				.stat(cursorTelemetryPath)
				.then((info) => info.isFile())
				.catch(() => false);
		}
		return result(command, {
			projectPath,
			outputPath,
			manifestPath,
			actionCount: applied.actions.length,
			generatedZoomCount: applied.generatedZoomCount,
			generatedCalloutCount: applied.generatedCalloutCount,
			unmappedActionIds: applied.unmappedActionIds,
			mediaTouched: false,
			cursorTelemetryPath,
			cursorTelemetryPreserved,
		});
	}
	throw Object.assign(new Error(`Unknown actions command: ${actionName}`), {
		code: "CLI_ARGUMENT_ERROR",
	});
}

async function scenesCommand(tokens) {
	const actionName = tokens.shift() ?? "list";
	const command = `scenes ${actionName}`;
	if (actionName === "start") {
		const parsed = parseTokens(tokens);
		validateParsedOptions(
			parsed,
			new Set([
				"--output",
				"--out",
				"-o",
				"--project",
				"-p",
				"--project-id",
				"--asset-id",
				"--clock-file",
				"--recording-clock",
			]),
			command,
		);
		validateRequiredValueOptions(
			parsed,
			[
				"--output",
				"--out",
				"-o",
				"--project",
				"-p",
				"--project-id",
				"--asset-id",
				"--clock-file",
				"--recording-clock",
			],
			command,
		);
		validatePositionalCount(parsed, 1, command);
		const projectValue = optionValue(parsed, "--project", "-p") ?? parsed.positional[0];
		let projectId = optionValue(parsed, "--project-id");
		let assetId = optionValue(parsed, "--asset-id");
		if (projectValue) {
			const source = await readJson(expandPath(projectValue));
			projectId ??= source.project?.id;
			assetId ??= source.project?.primaryAssetId ?? source.assets?.[0]?.id;
		}
		const recordingClockValue = optionValue(parsed, "--clock-file", "--recording-clock");
		const manifest = startSceneManifest({
			projectId,
			assetId,
			recordingClockPath: recordingClockValue ? expandPath(recordingClockValue) : undefined,
		});
		const outputPath = expandPath(optionValue(parsed, "--output", "--out", "-o") ?? "scenes.json");
		await writeSceneManifest(outputPath, manifest);
		return result(command, {
			manifestPath: outputPath,
			schemaVersion: 1,
			projectId: manifest.projectId ?? null,
			assetId: manifest.assetId ?? null,
			recordingClockPath: manifest.recordingClockPath ?? null,
			sceneCount: 0,
		});
	}
	if (actionName === "add") {
		const parsed = parseTokens(tokens);
		validateParsedOptions(
			parsed,
			new Set([
				"--name",
				"--title",
				"--start",
				"--end",
				"--text",
				"--copy",
				"--script",
				"--id",
				"--audio-track-ids",
				"--overlay-ids",
				"--output",
				"--out",
				"-o",
			]),
			command,
		);
		validateRequiredValueOptions(
			parsed,
			[
				"--name",
				"--title",
				"--start",
				"--end",
				"--text",
				"--copy",
				"--script",
				"--id",
				"--audio-track-ids",
				"--overlay-ids",
				"--output",
				"--out",
				"-o",
			],
			command,
		);
		validatePositionalCount(parsed, 1, command);
		const manifestValue = parsed.positional[0];
		if (!manifestValue)
			throw Object.assign(new Error("scenes add requires a manifest path"), {
				code: "CLI_ARGUMENT_ERROR",
			});
		const manifestPath = expandPath(manifestValue);
		const current = await readSceneManifest(manifestPath);
		const startSec = numberValue(parsed, ["--start"], "--start", { min: 0 });
		const endSec = numberValue(parsed, ["--end"], "--end", { min: 0 });
		if (startSec === undefined || endSec === undefined || endSec <= startSec)
			throw Object.assign(new Error("scenes add requires --end greater than --start"), {
				code: "CLI_ARGUMENT_ERROR",
			});
		const scene = {
			id: optionValue(parsed, "--id") ?? undefined,
			name: requiredValue(parsed, ["--name", "--title"], "--name"),
			startSec,
			endSec,
			text: optionValue(parsed, "--text", "--copy", "--script") ?? "",
			audioTrackIds: idListValue(parsed, ["--audio-track-ids"], "--audio-track-ids") ?? [],
			overlayIds: idListValue(parsed, ["--overlay-ids"], "--overlay-ids") ?? [],
		};
		const next = addSceneToManifest(current, scene);
		const outputPath = expandPath(optionValue(parsed, "--output", "--out", "-o") ?? manifestPath);
		await writeSceneManifest(outputPath, next);
		return result(command, {
			manifestPath: outputPath,
			scene: next.scenes.find((item) => item.id === scene.id) ?? next.scenes.at(-1),
			sceneCount: next.scenes.length,
		});
	}
	if (actionName === "list") {
		const parsed = parseTokens(tokens);
		validateParsedOptions(parsed, new Set(), command);
		validatePositionalCount(parsed, 1, command);
		const manifestValue = parsed.positional[0];
		if (!manifestValue)
			throw Object.assign(new Error("scenes list requires a manifest path"), {
				code: "CLI_ARGUMENT_ERROR",
			});
		const manifestPath = expandPath(manifestValue);
		const manifest = await readSceneManifest(manifestPath);
		return result(command, {
			manifestPath,
			manifest,
			scenes: manifest.scenes,
			sceneCount: manifest.scenes.length,
		});
	}
	if (actionName === "import") {
		const parsed = parseTokens(tokens);
		validateParsedOptions(parsed, new Set(["--output", "--out", "-o"]), command);
		validateRequiredValueOptions(parsed, ["--output", "--out", "-o"], command);
		validatePositionalCount(parsed, 1, command);
		const inputValue = parsed.positional[0];
		if (!inputValue)
			throw Object.assign(new Error("scenes import requires an input path"), {
				code: "CLI_ARGUMENT_ERROR",
			});
		const inputPath = expandPath(inputValue);
		const outputPath = expandPath(
			optionValue(parsed, "--output", "--out", "-o") ?? "scenes.imported.json",
		);
		const manifest = normalizeSceneManifest(await readJson(inputPath));
		await writeSceneManifest(outputPath, manifest);
		return result(command, {
			inputPath,
			manifestPath: outputPath,
			sceneCount: manifest.scenes.length,
		});
	}
	if (actionName === "apply") {
		const parsed = parseTokens(tokens);
		validateParsedOptions(
			parsed,
			new Set(["--manifest", "--output", "--out", "-o", "--in-place"]),
			command,
		);
		validateRequiredValueOptions(parsed, ["--manifest", "--output", "--out", "-o"], command);
		validatePositionalCount(parsed, 1, command);
		const projectValue = parsed.positional[0];
		if (!projectValue)
			throw Object.assign(new Error("scenes apply requires a project path"), {
				code: "CLI_ARGUMENT_ERROR",
			});
		const projectPath = expandPath(projectValue);
		const manifestPath = expandPath(requiredValue(parsed, ["--manifest"], "--manifest"));
		const document = await migrateLegacyProjectForCli(await readJson(projectPath));
		const applied = applyScenesToDocument(document, await readSceneManifest(manifestPath));
		const outputPath = editOutputPath(projectPath, parsed);
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		await writeDocumentAtomically(outputPath, applied.document);
		const previousScenes = new Map((document.scenes ?? []).map((scene) => [scene.id, scene]));
		const requiresNarrationSynthesis = applied.scenes.some(
			(scene) => scene.text && scene.text !== previousScenes.get(scene.id)?.text,
		);
		return result(command, {
			projectPath,
			outputPath,
			manifestPath,
			sceneCount: applied.scenes.length,
			changedSceneIds: applied.changedSceneIds,
			mediaTouched: false,
			narrationChanged: false,
			requiresNarrationSynthesis,
			needsNarrationRegeneration: requiresNarrationSynthesis,
		});
	}
	if (actionName === "revise") {
		const parsed = parseTokens(tokens);
		validateParsedOptions(
			parsed,
			new Set([
				"--scene-id",
				"--name",
				"--title",
				"--start",
				"--end",
				"--text",
				"--copy",
				"--script",
				"--audio-track-ids",
				"--overlay-ids",
				"--output",
				"--out",
				"-o",
				"--in-place",
			]),
			command,
		);
		validateRequiredValueOptions(
			parsed,
			[
				"--scene-id",
				"--name",
				"--title",
				"--start",
				"--end",
				"--text",
				"--copy",
				"--script",
				"--audio-track-ids",
				"--overlay-ids",
				"--output",
				"--out",
				"-o",
			],
			command,
		);
		validatePositionalCount(parsed, 1, command);
		const projectValue = parsed.positional[0];
		if (!projectValue)
			throw Object.assign(new Error("scenes revise requires a project path"), {
				code: "CLI_ARGUMENT_ERROR",
			});
		const projectPath = expandPath(projectValue);
		const document = await migrateLegacyProjectForCli(await readJson(projectPath));
		const current = normalizeSceneManifest({
			projectId: document.project?.id,
			scenes: document.scenes ?? [],
		});
		const sceneId = requiredValue(parsed, ["--scene-id"], "--scene-id");
		const patch = {};
		const name = optionValue(parsed, "--name", "--title");
		const text = optionValue(parsed, "--text", "--copy", "--script");
		const audioTrackIds = idListValue(parsed, ["--audio-track-ids"], "--audio-track-ids");
		const overlayIds = idListValue(parsed, ["--overlay-ids"], "--overlay-ids");
		const start = numberValue(parsed, ["--start"], "--start", { min: 0 });
		const end = numberValue(parsed, ["--end"], "--end", { min: 0 });
		if (name !== undefined) patch.name = name;
		if (text !== undefined) patch.text = text;
		if (audioTrackIds !== undefined) patch.audioTrackIds = audioTrackIds;
		if (overlayIds !== undefined) patch.overlayIds = overlayIds;
		if (start !== undefined) patch.startSec = start;
		if (end !== undefined) patch.endSec = end;
		const revisedManifest = reviseSceneInManifest(current, sceneId, patch);
		const applied = applyScenesToDocument(document, revisedManifest);
		const outputPath = editOutputPath(projectPath, parsed, "scene-revised");
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		await writeDocumentAtomically(outputPath, applied.document);
		const needsNarrationRegeneration =
			text !== undefined && text !== current.scenes.find((scene) => scene.id === sceneId)?.text;
		return result(command, {
			projectPath,
			outputPath,
			scene: applied.scenes.find((item) => item.id === sceneId),
			sceneCount: applied.scenes.length,
			mediaTouched: false,
			narrationChanged: false,
			requiresNarrationSynthesis: needsNarrationRegeneration,
			needsNarrationRegeneration,
		});
	}
	throw Object.assign(new Error(`Unknown scenes command: ${actionName}`), {
		code: "CLI_ARGUMENT_ERROR",
	});
}

function editOutputPath(projectPath, parsed, suffix = "edited") {
	const requested = optionValue(parsed, "--output", "--out", "-o");
	const inPlace = parsed.flags.has("--in-place");
	if (inPlace && requested !== undefined) {
		throw Object.assign(new Error("Use either --in-place or --output, not both"), {
			code: "CLI_ARGUMENT_ERROR",
		});
	}
	const outputPath = inPlace
		? projectPath
		: expandPath(
				requested ??
					`${projectPath.replace(/\.(openscreen|axcut)$/i, "")}.${suffix}${path.extname(projectPath)}`,
			);
	if (!inPlace) assertDistinctPath(outputPath, [projectPath], "Edit output");
	return outputPath;
}

async function editCropCommand(tokens) {
	const command = "edit crop";
	const parsed = parseTokens(tokens);
	const edgeNames = ["--top", "--right", "--bottom", "--left"];
	validateParsedOptions(
		parsed,
		new Set(["--region", ...edgeNames, "--clip-id", "--output", "--out", "-o", "--in-place"]),
		command,
	);
	validateRequiredValueOptions(
		parsed,
		["--region", ...edgeNames, "--clip-id", "--output", "--out", "-o"],
		command,
	);
	validatePositionalCount(parsed, 1, command);
	const projectValue = parsed.positional[0];
	if (!projectValue) {
		throw Object.assign(new Error(`${command} requires a project path`), {
			code: "CLI_ARGUMENT_ERROR",
		});
	}
	const regionValue = optionValue(parsed, "--region");
	const edgeValues = Object.fromEntries(
		edgeNames.map((name) => [name.slice(2), numberValue(parsed, [name], name, { min: 0 })]),
	);
	const hasEdges = edgeNames.some((name) => optionValue(parsed, name) !== undefined);
	if (regionValue !== undefined && hasEdges) {
		throw Object.assign(new Error("Use either --region or crop edge flags, not both"), {
			code: "CLI_ARGUMENT_ERROR",
		});
	}
	if (regionValue === undefined && !hasEdges) {
		throw Object.assign(new Error(`${command} requires --region or at least one crop edge flag`), {
			code: "CLI_ARGUMENT_ERROR",
		});
	}
	const cropRegion =
		regionValue !== undefined ? parseCropRegion(regionValue) : cropRegionFromEdges(edgeValues);
	const clipId = optionValue(parsed, "--clip-id") ?? null;
	const projectPath = expandPath(projectValue);
	const source = await readJson(projectPath);
	const document = await migrateLegacyProjectForCli(source);
	if (!Array.isArray(document.timeline?.clips) || document.timeline.clips.length === 0) {
		throw Object.assign(new Error("Project timeline has no video clips to crop"), {
			code: "PROJECT_TIMELINE_EMPTY",
		});
	}
	if (clipId !== null && !document.timeline.clips.some((clip) => clip.id === clipId)) {
		throw Object.assign(new Error(`Unknown clip id: ${clipId}`), {
			code: "CLI_ARGUMENT_ERROR",
		});
	}
	const cropped = applyCropToDocument(document, cropRegion, clipId);
	const outputPath = editOutputPath(projectPath, parsed, "cropped");
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	await writeDocumentAtomically(outputPath, cropped);
	return result(command, {
		operation: "crop",
		projectPath,
		outputPath,
		cropRegion,
		clipId,
		clipCount: cropped.timeline.clips.length,
		changed: cropped !== document,
		mediaTouched: false,
	});
}

async function editDeleteCommand(tokens) {
	const parsed = parseTokens(tokens);
	validateParsedOptions(
		parsed,
		new Set(["--start", "--end", "--output", "--out", "-o", "--in-place"]),
		"edit delete",
	);
	validateRequiredValueOptions(
		parsed,
		["--start", "--end", "--output", "--out", "-o"],
		"edit delete",
	);
	validatePositionalCount(parsed, 1, "edit delete");
	const projectValue = parsed.positional[0];
	if (!projectValue)
		throw Object.assign(new Error("edit delete requires a project path"), {
			code: "CLI_ARGUMENT_ERROR",
		});
	const projectPath = expandPath(projectValue);
	const startSec = numberValue(parsed, ["--start"], "--start", { min: 0 });
	const endSec = numberValue(parsed, ["--end"], "--end", { min: 0 });
	if (startSec === undefined || endSec === undefined || endSec <= startSec) {
		throw Object.assign(new Error("edit delete requires --end greater than --start"), {
			code: "CLI_ARGUMENT_ERROR",
		});
	}
	const source = await readJson(projectPath);
	// Native recordings arrive as legacy v2 sidecars. Promote them at the edit
	// boundary so a ripple cut carries attached narration, overlays, actions and
	// framing through the same current-document remapper as Axcut projects.
	const document = await migrateLegacyProjectForCli(source);
	const edited = deleteRangeFromDocument(document, startSec, endSec);
	const outputPath = editOutputPath(projectPath, parsed);
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	if (edited.changed) await writeDocumentAtomically(outputPath, edited.document);
	else if (outputPath !== projectPath) await fs.copyFile(projectPath, outputPath);
	return result("edit delete", {
		operation: "ripple-delete",
		projectPath,
		outputPath,
		startSec,
		endSec,
		changed: edited.changed,
		mediaTouched: false,
	});
}

function isAxcutProject(value) {
	return Boolean(
		value &&
			typeof value === "object" &&
			value.project &&
			typeof value.project === "object" &&
			value.timeline &&
			typeof value.timeline === "object" &&
			Array.isArray(value.assets),
	);
}

/**
 * Lift a legacy v2 .openscreen file into the current CLI document shape.
 *
 * Native recordings still produce the small v2 sidecar.  Keeping this bridge in
 * the CLI means an agent can immediately attach narration, apply computer-use
 * actions, add overlays, and ripple-cut that recording without first opening it
 * in Electron.  The conversion only writes a new sibling file; source media is
 * never changed.
 */
async function migrateLegacyProjectForCli(source) {
	if (isAxcutProject(source)) return source;
	if (!source || typeof source !== "object" || typeof source.version !== "number") {
		throw Object.assign(new Error("Project is not a supported .openscreen document"), {
			code: "PROJECT_FORMAT_UNSUPPORTED",
		});
	}
	const legacy = source;
	const editor = legacy.editor && typeof legacy.editor === "object" ? legacy.editor : {};
	const media = legacy.media && typeof legacy.media === "object" ? legacy.media : {};
	const screenPath = media.screenVideoPath ?? legacy.videoPath;
	if (typeof screenPath !== "string" || !screenPath) {
		throw Object.assign(new Error("Project does not reference a screen recording"), {
			code: "PROJECT_MEDIA_MISSING",
		});
	}
	const probed = await probeMedia(screenPath);
	const durationSec = probed.metadata.durationSec;
	if (!(typeof durationSec === "number" && durationSec > 0)) {
		throw Object.assign(new Error(`Project video duration is unknown: ${screenPath}`), {
			code: "VIDEO_DURATION_UNKNOWN",
		});
	}
	const now = new Date().toISOString();
	const legacyCropRegion = normalizeCropRegion(editor.cropRegion);
	const projectId =
		typeof legacy.project?.id === "string" ? legacy.project.id : `proj_${randomUUID()}`;
	const assetId = `asset_${randomUUID()}`;
	const clipId = `clip_${randomUUID()}`;
	const cameraPath = typeof media.webcamVideoPath === "string" ? media.webcamVideoPath : "";
	const asset = {
		id: assetId,
		kind: "video",
		label: path.basename(screenPath),
		originalPath: screenPath,
		durationSec,
		...(probed.metadata.video
			? {
					video: {
						codec: probed.metadata.video.codec ?? "unknown",
						width: probed.metadata.video.width ?? 0,
						height: probed.metadata.video.height ?? 0,
						fps: probed.metadata.video.fps ?? 0,
					},
				}
			: {}),
		...(probed.metadata.audio
			? {
					audio: {
						codec: probed.metadata.audio.codec ?? "unknown",
						sampleRate: probed.metadata.audio.sampleRate ?? 0,
						channels: probed.metadata.audio.channels ?? 0,
					},
				}
			: {}),
		cameraTrack: cameraPath
			? {
					sourcePath: cameraPath,
					startMs: 0,
					offsetMs: Math.round(Number(media.webcamOffsetMs) || 0),
					visible: true,
				}
			: null,
	};
	const clip = {
		id: clipId,
		assetId,
		sourceStartSec: 0,
		sourceEndSec: durationSec,
		timelineStartSec: 0,
		timelineEndSec: durationSec,
		wordRefs: [],
		origin: "system",
		reason: "migrated from legacy .openscreen",
		...(isIdentityCrop(legacyCropRegion) ? {} : { cropRegion: legacyCropRegion }),
	};
	const legacyAudioTracks = Array.isArray(legacy.audioTracks)
		? legacy.audioTracks
		: Array.isArray(editor.audioTracks)
			? editor.audioTracks
			: [];
	const audioTracks = legacyAudioTracks.flatMap((raw, index) => {
		if (!raw || typeof raw !== "object") return [];
		const track = raw;
		const sourcePath =
			typeof track.sourcePath === "string" && track.sourcePath ? track.sourcePath : null;
		if (!sourcePath) return [];
		const sourceStartSec = Math.max(0, Number(track.sourceStartSec) || 0);
		const sourceEndSec = Number(track.sourceEndSec);
		const timelineStartSec = Math.max(0, Number(track.timelineStartSec ?? track.startSec) || 0);
		const timelineEndSec = Number(track.timelineEndSec);
		if (!Number.isFinite(sourceEndSec) || sourceEndSec <= sourceStartSec) return [];
		if (!Number.isFinite(timelineEndSec) || timelineEndSec <= timelineStartSec) return [];
		const volumeValue = Number(track.volume);
		return [
			{
				id: typeof track.id === "string" ? track.id : `audio_${index + 1}`,
				kind: track.kind === "narration" ? "narration" : "audio",
				label: typeof track.label === "string" && track.label ? track.label : "Attached audio",
				sourcePath,
				...(typeof track.voice === "string" && track.voice ? { voice: track.voice } : {}),
				sourceStartSec,
				sourceEndSec,
				timelineStartSec,
				timelineEndSec,
				volume: Number.isFinite(volumeValue) ? Math.min(2, Math.max(0, volumeValue)) : 1,
				muted: track.muted === true,
				status: track.status === "missing" || track.status === "error" ? track.status : "ready",
				...(typeof track.error === "string" ? { error: track.error } : {}),
			},
		];
	});
	const trimRanges = Array.isArray(editor.trimRegions)
		? editor.trimRegions.flatMap((raw, index) => {
				if (!raw || typeof raw !== "object") return [];
				const startSec = Math.max(0, Number(raw.startMs) / 1000 || 0);
				const endSec = Math.min(durationSec, Number(raw.endMs) / 1000 || 0);
				return endSec > startSec
					? [
							{
								id: typeof raw.id === "string" ? raw.id : `trim_${index + 1}`,
								assetId,
								clipId,
								startSec,
								endSec,
								reason: "migrated from legacy trim",
								origin: "user",
							},
						]
					: [];
			})
		: [];
	const annotations = Array.isArray(editor.annotationRegions) ? editor.annotationRegions : [];
	const zoomRanges = Array.isArray(editor.zoomRegions) ? editor.zoomRegions : [];
	return {
		schemaVersion: 7,
		project: {
			id: projectId,
			title: "MEGA RECORDER project",
			createdAt: now,
			updatedAt: now,
			primaryAssetId: assetId,
		},
		assets: [asset],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [clip],
			gaps: [],
			trimRanges,
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
			audioTracks,
			audioMixMode:
				legacy.audioMixMode === "replace" || editor.audioMixMode === "replace" ? "replace" : "mix",
		},
		annotations,
		overlays: [],
		zoomRanges,
		actions: [],
		scenes: Array.isArray(legacy.scenes) ? legacy.scenes : [],
		...(legacy.recordingClock && typeof legacy.recordingClock === "object"
			? { recordingClock: legacy.recordingClock }
			: {}),
		legacyEditor: editor,
	};
}

function parsePair(value, label) {
	const parts = String(value ?? "")
		.split(",")
		.map((part) => Number(part.trim()));
	if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part)))
		throw Object.assign(new Error(`${label} must be two comma-separated numbers`), {
			code: "CLI_ARGUMENT_ERROR",
		});
	return { x: parts[0], y: parts[1] };
}

function parseQuad(value, label) {
	const parts = String(value ?? "")
		.split(",")
		.map((part) => Number(part.trim()));
	if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part)))
		throw Object.assign(new Error(`${label} must be two comma-separated numbers (width,height)`), {
			code: "CLI_ARGUMENT_ERROR",
		});
	return { width: parts[0], height: parts[1] };
}

function overlayOutputPath(projectPath, parsed) {
	const requested = optionValue(parsed, "--output", "--out", "-o");
	const inPlace = parsed.flags.has("--in-place");
	if (inPlace && requested !== undefined) {
		throw Object.assign(new Error("Use either --in-place or --output, not both"), {
			code: "CLI_ARGUMENT_ERROR",
		});
	}
	const outputPath = inPlace
		? projectPath
		: expandPath(
				requested ??
					`${projectPath.replace(/\.(openscreen|axcut)$/i, "")}.overlays${path.extname(projectPath)}`,
			);
	if (!inPlace) assertDistinctPath(outputPath, [projectPath], "Overlay output");
	return outputPath;
}

async function editOverlayCommand(tokens) {
	const action = tokens.shift() ?? "list";
	const command = `edit overlay ${action}`;
	const parsed = parseTokens(tokens);
	const common = new Set(["--output", "--out", "-o", "--in-place"]);
	if (action === "list") {
		validateParsedOptions(parsed, new Set(), command);
		validatePositionalCount(parsed, 1, command);
		const projectValue = parsed.positional[0];
		if (!projectValue)
			throw Object.assign(new Error(`${command} requires a project path`), {
				code: "CLI_ARGUMENT_ERROR",
			});
		const projectPath = expandPath(projectValue);
		const source = await readJson(projectPath);
		const document = await migrateLegacyProjectForCli(source);
		const overlays = (document.overlays ?? []).map((overlay) => validateOverlay(overlay));
		return result(command, { projectPath, overlays, overlayCount: overlays.length });
	}
	if (action === "add") {
		validateParsedOptions(
			parsed,
			new Set([
				"--start",
				"--end",
				"--text",
				"--type",
				"--position",
				"--anchor",
				"--size",
				"--space",
				"--color",
				"--background",
				"--font-size",
				"--font-family",
				"--font-weight",
				"--font-style",
				"--text-align",
				"--opacity",
				"--z-index",
				...common,
			]),
			command,
		);
		validateRequiredValueOptions(
			parsed,
			[
				"--start",
				"--end",
				"--text",
				"--type",
				"--position",
				"--anchor",
				"--size",
				"--space",
				"--color",
				"--background",
				"--font-size",
				"--font-family",
				"--font-weight",
				"--font-style",
				"--text-align",
				"--opacity",
				"--z-index",
				"--output",
				"--out",
				"-o",
			],
			command,
		);
		validatePositionalCount(parsed, 1, command);
		const projectValue = parsed.positional[0];
		if (!projectValue)
			throw Object.assign(new Error(`${command} requires a project path`), {
				code: "CLI_ARGUMENT_ERROR",
			});
		const projectPath = expandPath(projectValue);
		const source = await readJson(projectPath);
		const document = await migrateLegacyProjectForCli(source);
		const type = optionValue(parsed, "--type") ?? "label";
		if (!OVERLAY_TYPES.includes(type))
			throw Object.assign(new Error(`--type must be one of ${OVERLAY_TYPES.join(", ")}`), {
				code: "CLI_ARGUMENT_ERROR",
			});
		const anchor = optionValue(parsed, "--anchor");
		if (anchor !== undefined && !OVERLAY_ANCHORS.includes(anchor))
			throw Object.assign(new Error(`--anchor must be one of ${OVERLAY_ANCHORS.join(", ")}`), {
				code: "CLI_ARGUMENT_ERROR",
			});
		const positionValue = optionValue(parsed, "--position");
		const sizeValue = optionValue(parsed, "--size");
		const position = positionValue ? parsePair(positionValue, "--position") : undefined;
		const size = sizeValue ? parseQuad(sizeValue, "--size") : undefined;
		const style = {
			...(optionValue(parsed, "--color") ? { color: optionValue(parsed, "--color") } : {}),
			...(optionValue(parsed, "--background")
				? { backgroundColor: optionValue(parsed, "--background") }
				: {}),
			...(optionValue(parsed, "--font-size")
				? { fontSize: numberValue(parsed, ["--font-size"], "--font-size", { min: 1 }) }
				: {}),
			...(optionValue(parsed, "--font-family")
				? { fontFamily: optionValue(parsed, "--font-family") }
				: {}),
			...(optionValue(parsed, "--font-weight")
				? { fontWeight: optionValue(parsed, "--font-weight") }
				: {}),
			...(optionValue(parsed, "--font-style")
				? { fontStyle: optionValue(parsed, "--font-style") }
				: {}),
			...(optionValue(parsed, "--text-align")
				? { textAlign: optionValue(parsed, "--text-align") }
				: {}),
			...(optionValue(parsed, "--opacity")
				? { opacity: numberValue(parsed, ["--opacity"], "--opacity", { min: 0 }) }
				: {}),
		};
		const startSec = numberValue(parsed, ["--start"], "--start", { min: 0 });
		const endSec = numberValue(parsed, ["--end"], "--end", { min: 0 });
		const overlay = createOverlay({
			startSec,
			endSec,
			text: requiredValue(parsed, ["--text"], "--text"),
			type,
			position,
			anchor,
			size,
			space: optionValue(parsed, "--space"),
			style,
			zIndex: optionValue(parsed, "--z-index")
				? numberValue(parsed, ["--z-index"], "--z-index", { integer: true, min: 0 })
				: undefined,
		});
		const next = {
			...addOverlayToDocument(document, overlay),
			project: { ...document.project, updatedAt: new Date().toISOString() },
		};
		const outputPath = overlayOutputPath(projectPath, parsed);
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		await writeDocumentAtomically(outputPath, next);
		return result(command, {
			projectPath,
			outputPath,
			overlay,
			overlayCount: next.overlays.length,
			mediaTouched: false,
		});
	}
	if (action === "remove") {
		validateParsedOptions(parsed, new Set(["--id", ...common]), command);
		validateRequiredValueOptions(parsed, ["--id", "--output", "--out", "-o"], command);
		validatePositionalCount(parsed, 1, command);
		const projectValue = parsed.positional[0];
		const overlayId = optionValue(parsed, "--id");
		if (!projectValue || !overlayId)
			throw Object.assign(new Error(`${command} requires a project path and --id`), {
				code: "CLI_ARGUMENT_ERROR",
			});
		const projectPath = expandPath(projectValue);
		const source = await readJson(projectPath);
		const document = await migrateLegacyProjectForCli(source);
		const before = Array.isArray(document.overlays) ? document.overlays : [];
		if (!before.some((overlay) => overlay.id === overlayId))
			throw Object.assign(new Error(`Unknown overlay id: ${overlayId}`), {
				code: "OVERLAY_NOT_FOUND",
			});
		const next = {
			...removeOverlayFromDocument(document, overlayId),
			project: { ...document.project, updatedAt: new Date().toISOString() },
		};
		const outputPath = overlayOutputPath(projectPath, parsed);
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		await writeDocumentAtomically(outputPath, next);
		return result(command, {
			projectPath,
			outputPath,
			removedOverlayId: overlayId,
			overlayCount: next.overlays.length,
			mediaTouched: false,
		});
	}
	throw Object.assign(new Error(`Unknown overlay command: ${action}`), {
		code: "CLI_ARGUMENT_ERROR",
	});
}

function audioAttachOutputPath(projectPath, parsed) {
	const requested = optionValue(parsed, "--output", "--out", "-o");
	const inPlace = parsed.flags.has("--in-place");
	if (inPlace && requested !== undefined) {
		throw Object.assign(new Error("Use either --in-place or --output, not both"), {
			code: "CLI_ARGUMENT_ERROR",
		});
	}
	const outputPath = inPlace
		? projectPath
		: expandPath(
				requested ??
					`${projectPath.replace(/\.(openscreen|axcut)$/i, "")}.with-audio${path.extname(projectPath)}`,
			);
	if (!inPlace) assertDistinctPath(outputPath, [projectPath], "Audio attach output");
	return outputPath;
}

async function audioAttachCommand(tokens) {
	const parsed = parseTokens(tokens);
	validateParsedOptions(
		parsed,
		new Set([
			"--file",
			"--audio",
			"--input",
			"-a",
			"--label",
			"--voice",
			"--start",
			"--timeline-start",
			"--source-start",
			"--source-end",
			"--volume",
			"--mode",
			"--output",
			"--out",
			"-o",
			"--in-place",
			"--manifest",
		]),
		"audio attach",
	);
	validateRequiredValueOptions(
		parsed,
		[
			"--file",
			"--audio",
			"--input",
			"-a",
			"--label",
			"--voice",
			"--start",
			"--timeline-start",
			"--source-start",
			"--source-end",
			"--volume",
			"--mode",
			"--output",
			"--out",
			"-o",
			"--manifest",
		],
		"audio attach",
	);
	validatePositionalCount(parsed, 1, "audio attach");
	const projectValue = parsed.positional[0];
	if (!projectValue)
		throw Object.assign(new Error("audio attach requires a project path"), {
			code: "CLI_ARGUMENT_ERROR",
		});
	const audioValue = optionValue(parsed, "--file", "--audio", "--input", "-a");
	if (!audioValue) {
		throw Object.assign(new Error("audio attach requires --file <audio>"), {
			code: "CLI_ARGUMENT_ERROR",
		});
	}
	const projectPath = expandPath(projectValue);
	const audioPath = expandPath(audioValue);
	const source = await readJson(projectPath);
	if (!isAxcutProject(source) && !(typeof source?.version === "number" && source.editor)) {
		throw Object.assign(
			new Error(
				"audio attach requires an Axcut .openscreen project or a legacy OpenScreen project",
			),
			{ code: "PROJECT_FORMAT_UNSUPPORTED" },
		);
	}
	const probed = await probeMedia(audioPath);
	if (!probed.metadata.audio) {
		throw Object.assign(new Error(`Audio file has no audio stream: ${audioPath}`), {
			code: "AUDIO_STREAM_MISSING",
		});
	}
	const durationSec = probed.metadata.durationSec;
	if (!(typeof durationSec === "number" && Number.isFinite(durationSec) && durationSec > 0)) {
		throw Object.assign(new Error(`Audio duration is unknown: ${audioPath}`), {
			code: "AUDIO_DURATION_UNKNOWN",
		});
	}
	const sourceStartSec = numberValue(parsed, ["--source-start"], "--source-start", { min: 0 }) ?? 0;
	const sourceEndSec =
		numberValue(parsed, ["--source-end"], "--source-end", { min: 0 }) ?? durationSec;
	const timelineStartSec =
		numberValue(parsed, ["--timeline-start", "--start"], "--start", { min: 0 }) ?? 0;
	const volumeRaw = optionValue(parsed, "--volume");
	const volume = volumeRaw === undefined ? 1 : Number(volumeRaw);
	if (!Number.isFinite(volume) || volume < 0 || volume > 2) {
		throw Object.assign(new Error("--volume must be a number between 0 and 2"), {
			code: "CLI_ARGUMENT_ERROR",
		});
	}
	if (!(sourceEndSec > sourceStartSec) || sourceEndSec > durationSec + 0.001) {
		throw Object.assign(
			new Error(
				`Audio source range must satisfy 0 <= source-start < source-end <= ${durationSec.toFixed(3)}s`,
			),
			{ code: "AUDIO_RANGE_INVALID", expected: durationSec },
		);
	}
	const mode = optionValue(parsed, "--mode") ?? "mix";
	if (mode !== "mix" && mode !== "replace") {
		throw Object.assign(new Error(`--mode must be mix or replace, got "${mode}"`), {
			code: "CLI_ARGUMENT_ERROR",
		});
	}
	const label = optionValue(parsed, "--label") ?? path.basename(audioPath);
	const voice = optionValue(parsed, "--voice");
	const track = {
		id: `audio_${randomUUID().replaceAll("-", "")}`,
		kind: voice ? "narration" : "audio",
		label,
		sourcePath: audioPath,
		...(voice ? { voice } : {}),
		sourceStartSec,
		sourceEndSec,
		timelineStartSec,
		timelineEndSec: timelineStartSec + sourceEndSec - sourceStartSec,
		volume,
		muted: false,
		status: "ready",
	};
	const next = isAxcutProject(source)
		? {
				...source,
				project: { ...source.project, updatedAt: new Date().toISOString() },
				timeline: {
					...source.timeline,
					audioTracks: [
						...(Array.isArray(source.timeline.audioTracks) ? source.timeline.audioTracks : []),
						track,
					],
					audioMixMode: mode,
				},
			}
		: {
				...source,
				audioTracks: [...(Array.isArray(source.audioTracks) ? source.audioTracks : []), track],
				audioMixMode: mode,
			};
	const outputPath = audioAttachOutputPath(projectPath, parsed);
	const manifestPath = optionValue(parsed, "--manifest");
	const absoluteManifestPath = manifestPath ? expandPath(manifestPath) : null;
	if (absoluteManifestPath)
		assertDistinctPath(absoluteManifestPath, [outputPath, projectPath], "Manifest path");
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	if (outputPath === projectPath) await writeDocumentAtomically(outputPath, next);
	else await writeDocumentAtomically(outputPath, next);
	const [input, output, baseline] = await Promise.all([
		hashFiles([audioPath]),
		hashFiles([outputPath]),
		readBaseline(),
	]);
	const manifest = absoluteManifestPath
		? await updateManifest(
				absoluteManifestPath,
				buildManifest({ baseline, inputs: input, outputs: output, command: "audio attach" }),
			)
		: null;
	return result("audio attach", {
		projectPath,
		outputPath,
		track,
		trackCount: isAxcutProject(next) ? next.timeline.audioTracks.length : next.audioTracks.length,
		mode,
		input: input[0],
		output: output[0],
		manifest,
		mediaTouched: false,
	});
}

async function editCommand(tokens) {
	if (tokens[0] === "crop") return editCropCommand(tokens.slice(1));
	if (tokens[0] === "delete") return editDeleteCommand(tokens.slice(1));
	if (tokens[0] === "overlay") return editOverlayCommand(tokens.slice(1));
	const parsed = parseTokens(tokens);
	validateParsedOptions(
		parsed,
		new Set([
			"--port",
			"--project",
			"-p",
			"--delete",
			"--start",
			"--end",
			"--output",
			"--out",
			"-o",
			"--in-place",
		]),
		"edit",
	);
	validateRequiredValueOptions(
		parsed,
		["--port", "--project", "-p", "--start", "--end", "--output", "--out", "-o"],
		"edit",
	);
	validatePositionalCount(parsed, 1, "edit");
	// `edit <project> --delete --start ... --end ...` is a convenient alias for
	// the explicit `edit delete <project>` form, but still requires the flag so
	// starting a browser server remains the default.
	if (parsed.flags.has("--delete")) {
		const project = optionValue(parsed, "--project", "-p") ?? parsed.positional[0];
		const start = optionValue(parsed, "--start");
		const end = optionValue(parsed, "--end");
		if (!project || start === undefined || end === undefined) {
			throw Object.assign(new Error("edit --delete requires a project, --start, and --end"), {
				code: "CLI_ARGUMENT_ERROR",
			});
		}
		const editTokens = [project, "--start", start, "--end", end];
		const requestedOutput = optionValue(parsed, "--output", "--out", "-o");
		if (requestedOutput !== undefined) editTokens.push("--output", requestedOutput);
		if (parsed.flags.has("--in-place")) editTokens.push("--in-place");
		return editDeleteCommand(editTokens);
	}
	const projectValue = optionValue(parsed, "--project", "-p") ?? parsed.positional[0];
	if (!projectValue)
		throw Object.assign(new Error("edit requires a project path"), { code: "CLI_ARGUMENT_ERROR" });
	const port = numberValue(parsed, ["--port"], "--port", { integer: true, min: 0 }) ?? 0;
	const editor = await createBrowserEditorServer({ projectPath: expandPath(projectValue), port });
	return {
		...result("edit"),
		projectPath: editor.projectPath,
		projectId: editor.projectId,
		host: editor.host,
		port: editor.port,
		url: editor.url,
		localOnly: true,
		capabilities: {
			inspection: true,
			save: true,
			crop: true,
			rippleDelete: true,
			nativeCapture: false,
			export: false,
		},
		server: editor,
	};
}

function upstreamExecutable() {
	if (process.env.MEGA_RECORDER_ELECTRON) return process.env.MEGA_RECORDER_ELECTRON;
	return path.join(
		REPO_ROOT,
		"node_modules",
		".bin",
		process.platform === "win32" ? "electron.cmd" : "electron",
	);
}

export async function delegateUpstream(kind, tokens) {
	const childArgs = [REPO_ROOT, kind, ...tokens];
	if (!tokens.includes("--json")) childArgs.push("--json");
	return new Promise((resolve) => {
		const child = spawn(upstreamExecutable(), childArgs, { stdio: ["inherit", "pipe", "inherit"] });
		let lineBuffer = "";
		let done;
		const consume = (chunk) => {
			lineBuffer += chunk;
			const lines = lineBuffer.split(/\r?\n/);
			lineBuffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line) continue;
				try {
					const event = JSON.parse(line);
					if (event?.event === "done") done = event;
				} catch {
					// The upstream stream may include non-JSON diagnostics; only the
					// terminal done event is part of this wrapper's contract.
				}
			}
		};
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			consume(chunk);
		});
		child.once("error", (error) => {
			resolve(
				failure(kind, "UPSTREAM_NOT_AVAILABLE", error.message, {
					executable: upstreamExecutable(),
				}),
			);
		});
		child.once("close", (exitCode, signal) => {
			if (lineBuffer.trim()) consume(`${lineBuffer}\n`);
			if (!done) {
				resolve(
					failure(kind, "UPSTREAM_FAILED", "Upstream CLI did not return a done event", {
						exitCode,
						signal,
					}),
				);
				return;
			}
			resolve({
				ok: done.success === true && exitCode === 0,
				command: kind,
				upstream: done,
				exitCode,
			});
		});
	});
}

export async function runCommand(argv) {
	if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
		return result("help", { usage: USAGE });
	}
	const [root, ...tokens] = argv;
	let commandName = root;
	try {
		if (root === "doctor") {
			const parsed = parseTokens(tokens);
			validateParsedOptions(parsed, new Set(), "doctor");
			validatePositionalCount(parsed, 0, "doctor");
			return await runDoctor();
		}
		if (root === "preset") {
			const action = tokens.shift() ?? "show";
			commandName = `preset ${action}`;
			if (action === "show") {
				const parsed = parseTokens(tokens);
				validateParsedOptions(parsed, new Set(), "preset show");
				validatePositionalCount(parsed, 1, "preset show");
				return showPreset(parsed.positional[0] ?? "blue-studio");
			}
			if (action === "apply") return await applyPreset(tokens);
			throw Object.assign(new Error(`Unknown preset command: ${action}`), {
				code: "CLI_ARGUMENT_ERROR",
			});
		}
		if (root === "kokoro") {
			const action = tokens.shift() ?? "doctor";
			commandName = `kokoro ${action}`;
			if (action === "doctor") {
				const parsed = parseTokens(tokens);
				validateParsedOptions(parsed, new Set(), "kokoro doctor");
				validatePositionalCount(parsed, 0, "kokoro doctor");
				return await runKokoroDoctor();
			}
			if (action === "synthesize") return await synthesize(tokens);
			throw Object.assign(new Error(`Unknown Kokoro command: ${action}`), {
				code: "CLI_ARGUMENT_ERROR",
			});
		}
		if (root === "verify") return await verifyCommand(tokens);
		if (root === "actions") return await actionsCommand(tokens);
		if (root === "scenes") return await scenesCommand(tokens);
		if (root === "edit") return await editCommand(tokens);
		if (root === "audio") {
			const action = tokens.shift() ?? "attach";
			commandName = `audio ${action}`;
			if (action === "attach") return await audioAttachCommand(tokens);
			throw Object.assign(new Error(`Unknown audio command: ${action}`), {
				code: "CLI_ARGUMENT_ERROR",
			});
		}
		if (root === "record" || root === "export") return await delegateUpstream(root, tokens);
		throw Object.assign(new Error(`Unknown command: ${root}`), { code: "CLI_ARGUMENT_ERROR" });
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: typeof error?.message === "string"
					? error.message
					: String(error);
		const details = {};
		for (const key of ["path", "expected", "actual", "availableVoices", "attempts"]) {
			if (error?.[key] !== undefined) details[key] = error[key];
		}
		return failure(commandName, error?.code ?? "COMMAND_FAILED", message, details);
	}
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
let invokedRealPath = invokedPath;
try {
	invokedRealPath = realpathSync(invokedPath);
} catch {
	// Importing the module in a test runner does not always provide argv[1].
}
if (invokedRealPath === SCRIPT_PATH) {
	const output = await runCommand(process.argv.slice(2));
	const { server, ...stableOutput } = output;
	printJson(stableOutput);
	const argumentErrors = new Set(["CLI_ARGUMENT_ERROR", "PRESET_NOT_FOUND"]);
	process.exitCode = output.ok ? 0 : output.error && argumentErrors.has(output.error.code) ? 2 : 1;
	if (server && output.ok) {
		const close = async () => {
			await server.close().catch(() => undefined);
			process.exit(0);
		};
		process.once("SIGINT", close);
		process.once("SIGTERM", close);
		await new Promise(() => undefined);
	}
}
