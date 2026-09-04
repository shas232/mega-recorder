#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserEditorServer } from "./mega-recorder/browser-editor-server.mjs";
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
import { applyPresetToProject, getPreset, listPresets } from "./mega-recorder/preset.mjs";
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
	"  mega-recorder edit <project> [--port <port>]  (browser editor; localhost only)",
	"  mega-recorder edit delete <project> --start <seconds> --end <seconds> [--output <file> | --in-place]",
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

function editOutputPath(projectPath, parsed) {
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
					`${projectPath.replace(/\.(openscreen|axcut)$/i, "")}.edited${path.extname(projectPath)}`,
			);
	if (!inPlace) assertDistinctPath(outputPath, [projectPath], "Edit output");
	return outputPath;
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
	const edited = deleteRangeFromDocument(source, startSec, endSec);
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

async function editCommand(tokens) {
	if (tokens[0] === "delete") return editDeleteCommand(tokens.slice(1));
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
		if (root === "edit") return await editCommand(tokens);
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
