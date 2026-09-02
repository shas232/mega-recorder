#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	KOKORO_MODEL_ID,
	KOKORO_SAMPLE_RATE,
	kokoroDoctor,
	synthesizeWithKokoro,
} from "./mega-recorder/kokoro.mjs";
import {
	buildManifest,
	hashFiles,
	hashNarration,
	updateManifest,
} from "./mega-recorder/manifest.mjs";
import { applyPresetToProject, getPreset, listPresets } from "./mega-recorder/preset.mjs";
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
	return path.resolve(
		value.startsWith("~/") ? path.join(process.env.HOME ?? "", value.slice(2)) : value,
	);
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

function numberValue(parsed, names, label, { integer = false, min = 0 } = {}) {
	const raw = optionValue(parsed, ...names);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
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

export async function runDoctor() {
	const [baseline, version, kokoro] = await Promise.all([
		readBaseline(),
		commandVersion(),
		kokoroDoctor(),
	]);
	const ffprobe = executableStatus(process.env.MEGA_RECORDER_FFPROBE || "ffprobe", ["-version"]);
	const nativeBin = path.join(REPO_ROOT, "electron", "native", "bin");
	let nativeHelpersPresent = false;
	try {
		nativeHelpersPresent = (await fs.readdir(nativeBin)).length > 0;
	} catch {
		nativeHelpersPresent = false;
	}
	return result("doctor", {
		product: "MEGA RECORDER",
		version,
		upstream: {
			repository: baseline.project?.upstreamRepository ?? null,
			commit: baseline.project?.upstreamCommit ?? null,
		},
		checks: {
			ffprobe,
			kokoro: { ready: kokoro.ready, model: kokoro.model, modelCache: kokoro.modelCache },
			nativeCapture: {
				status: "delegated",
				helperArtifactsPresent: nativeHelpersPresent,
				note: "Recording uses the upstream Electron/native pipeline; this command does not fake capture.",
			},
		},
		ready: ffprobe.available,
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
	const name = parsed.positional[0] ?? "blue-studio";
	const preset = getPreset(name);
	if (!preset) return failure("preset apply", "PRESET_NOT_FOUND", `Unknown preset: ${name}`);
	const projectPath = expandPath(requiredValue(parsed, ["--project", "-p"], "--project"));
	const source = await readJson(projectPath);
	const project = applyPresetToProject(source, preset);
	const inputHashes = await hashFiles([projectPath]);
	const requestedOutput = optionValue(parsed, "--output", "--out", "-o");
	const inPlace = parsed.flags.has("--in-place");
	const outputPath = inPlace
		? projectPath
		: expandPath(
				requestedOutput ?? `${projectPath.replace(/\.openscreen$/i, "")}.${preset.id}.openscreen`,
			);
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
	const manifestPath = optionValue(parsed, "--manifest");
	let manifest = null;
	if (manifestPath) {
		manifest = await updateManifest(
			expandPath(manifestPath),
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
	const voice = optionValue(parsed, "--voice") ?? "af_heart";
	const outputPath = expandPath(optionValue(parsed, "--output", "--out", "-o") ?? "narration.wav");
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
	const manifestPath = optionValue(parsed, "--manifest");
	let manifest = null;
	if (manifestPath) {
		manifest = await updateManifest(
			expandPath(manifestPath),
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
	let manifest = null;
	if (manifestPath) {
		manifest = await updateManifest(
			expandPath(manifestPath),
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

function upstreamExecutable() {
	return (
		process.env.MEGA_RECORDER_ELECTRON || path.join(REPO_ROOT, "node_modules", ".bin", "electron")
	);
}

export async function delegateUpstream(kind, tokens) {
	const childArgs = [REPO_ROOT, kind, ...tokens];
	if (!tokens.includes("--json")) childArgs.push("--json");
	return new Promise((resolve) => {
		const child = spawn(upstreamExecutable(), childArgs, { stdio: ["inherit", "pipe", "inherit"] });
		let stdout = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.once("error", (error) => {
			resolve(
				failure(kind, "UPSTREAM_NOT_AVAILABLE", error.message, {
					executable: upstreamExecutable(),
				}),
			);
		});
		child.once("close", (exitCode, signal) => {
			const events = stdout
				.trim()
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line) => {
					try {
						return JSON.parse(line);
					} catch {
						return null;
					}
				})
				.filter(Boolean);
			const done = events.findLast((event) => event.event === "done");
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
		if (root === "doctor") return await runDoctor();
		if (root === "preset") {
			const action = tokens.shift() ?? "show";
			commandName = `preset ${action}`;
			if (action === "show") return showPreset(parseTokens(tokens).positional[0] ?? "blue-studio");
			if (action === "apply") return await applyPreset(tokens);
			throw Object.assign(new Error(`Unknown preset command: ${action}`), {
				code: "CLI_ARGUMENT_ERROR",
			});
		}
		if (root === "kokoro") {
			const action = tokens.shift() ?? "doctor";
			commandName = `kokoro ${action}`;
			if (action === "doctor") return await runKokoroDoctor();
			if (action === "synthesize") return await synthesize(tokens);
			throw Object.assign(new Error(`Unknown Kokoro command: ${action}`), {
				code: "CLI_ARGUMENT_ERROR",
			});
		}
		if (root === "verify") return await verifyCommand(tokens);
		if (root === "record" || root === "export") return await delegateUpstream(root, tokens);
		throw Object.assign(new Error(`Unknown command: ${root}`), { code: "CLI_ARGUMENT_ERROR" });
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: typeof error?.message === "string"
					? error.message
					: String(error);
		return failure(commandName, error?.code ?? "COMMAND_FAILED", message, {
			...(error?.path ? { path: error.path } : {}),
		});
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
	printJson(output);
	const argumentErrors = new Set(["CLI_ARGUMENT_ERROR", "PRESET_NOT_FOUND"]);
	process.exitCode = output.ok ? 0 : output.error && argumentErrors.has(output.error.code) ? 2 : 1;
}
