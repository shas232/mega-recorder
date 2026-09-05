import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODEL_ID = "hexgrad/Kokoro-82M";
const SAMPLE_RATE = 24000;
const PREFERRED_DEFAULT_VOICE = "af_sky";
const FALLBACK_DEFAULT_VOICE = "am_michael";
const RUNTIME_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "kokoro_runtime.py");

function expandHome(value) {
	return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function unique(values) {
	return [...new Set(values.filter(Boolean).map((value) => path.resolve(expandHome(value))))];
}

export function modelCacheCandidates(env = process.env) {
	const cacheRoot = env.HF_HUB_CACHE || env.HUGGINGFACE_HUB_CACHE || env.HF_HOME;
	return unique([
		env.MEGA_RECORDER_KOKORO_MODEL_CACHE,
		cacheRoot && path.basename(cacheRoot) === "hub"
			? path.join(cacheRoot, "models--hexgrad--Kokoro-82M")
			: cacheRoot && path.join(cacheRoot, "hub", "models--hexgrad--Kokoro-82M"),
		path.join(os.homedir(), ".cache", "huggingface", "hub", "models--hexgrad--Kokoro-82M"),
		path.join(os.homedir(), ".cache", "huggingface", "hub", "models--hexgrad--Kokoro-82M"),
	]);
}

export async function findModelCache(env = process.env) {
	for (const candidate of modelCacheCandidates(env)) {
		try {
			const entries = await fs.readdir(candidate, { recursive: true });
			const hasConfig = entries.some((entry) => path.basename(entry) === "config.json");
			const hasWeights = entries.some((entry) =>
				/\.(pth|safetensors|bin)$/i.test(path.basename(entry)),
			);
			if (hasConfig || hasWeights) {
				const voices = [
					...new Set(
						entries
							.filter((entry) => /(?:^|[/\\])voices[/\\][^/\\]+\.pt$/i.test(entry))
							.map((entry) => path.basename(entry, path.extname(entry))),
					),
				].sort();
				return { path: candidate, hasConfig, hasWeights, voices };
			}
		} catch {
			// A missing cache is expected on a first install.
		}
	}
	return null;
}

export async function resolveDefaultVoice(env = process.env) {
	const cache = await findModelCache(env);
	const voices = cache?.voices ?? [];
	if (voices.includes(PREFERRED_DEFAULT_VOICE)) return PREFERRED_DEFAULT_VOICE;
	if (voices.includes(FALLBACK_DEFAULT_VOICE)) return FALLBACK_DEFAULT_VOICE;
	return voices[0] ?? PREFERRED_DEFAULT_VOICE;
}

function pythonCandidates(env = process.env) {
	// Keep bare `python3`/`python` names intact so the child process can use
	// PATH.  Resolving those names against the repo would make a normal system
	// interpreter look missing.
	return [
		...new Set(
			[
				env.MEGA_RECORDER_KOKORO_PYTHON,
				env.VIRTUAL_ENV && path.join(env.VIRTUAL_ENV, "bin", "python"),
				env.VIRTUAL_ENV && path.join(env.VIRTUAL_ENV, "bin", "python3"),
				path.join(os.homedir(), ".venvs", "kokoro", "bin", "python"),
				path.join(os.homedir(), ".venvs", "kokoro", "bin", "python3"),
				"python3",
				"python",
			]
				.filter(Boolean)
				.map((candidate) =>
					candidate.includes(path.sep) ? path.resolve(expandHome(candidate)) : candidate,
				),
		),
	];
}

export function buildRuntimeEnvironment(environment = process.env, modelCache = null) {
	const runtime = { ...environment };
	if (modelCache?.path) {
		// MEGA_RECORDER_KOKORO_MODEL_CACHE points at the Hugging Face model
		// directory, while the library expects its parent `hub` directory.
		// Keep the explicit cache selection and the offline contract aligned.
		const hubCache = path.dirname(modelCache.path);
		runtime.HF_HUB_CACHE = hubCache;
		runtime.HUGGINGFACE_HUB_CACHE = hubCache;
	}
	return {
		...runtime,
		HF_HUB_OFFLINE: "1",
		TRANSFORMERS_OFFLINE: "1",
		HF_DATASETS_OFFLINE: "1",
		HF_HUB_DISABLE_TELEMETRY: "1",
		MEGA_RECORDER_NO_NETWORK: "1",
	};
}

async function runPython(python, args, input = "", environment = process.env, modelCache = null) {
	return new Promise((resolve) => {
		const child = spawn(python, [RUNTIME_SCRIPT, ...args], {
			cwd: path.dirname(RUNTIME_SCRIPT),
			env: buildRuntimeEnvironment(environment, modelCache),
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => resolve({ code: null, stdout, stderr, error }));
		child.on("close", (code) => resolve({ code, stdout, stderr }));
		child.stdin.end(input);
	});
}

function parseRuntimeOutput(result) {
	const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
	const last = lines.at(-1);
	if (!last) return null;
	try {
		return JSON.parse(last);
	} catch {
		return null;
	}
}

export async function kokoroDoctor(env = process.env) {
	const cache = await findModelCache(env);
	const attempts = [];
	for (const python of pythonCandidates(env)) {
		const result = await runPython(python, ["--doctor"], "", env, cache);
		const parsed = parseRuntimeOutput(result);
		const dependenciesAvailable =
			parsed?.dependencies &&
			Object.keys(parsed.dependencies).length > 0 &&
			Object.values(parsed.dependencies).every((available) => available === true);
		attempts.push({
			python,
			available: result.code === 0 && parsed?.moduleAvailable === true,
			moduleAvailable: parsed?.moduleAvailable ?? false,
			dependenciesAvailable: Boolean(dependenciesAvailable),
			version: parsed?.version ?? null,
			dependencies: parsed?.dependencies ?? {},
			error: parsed?.error ?? result.error?.message ?? (result.stderr.trim() || null),
		});
		if (result.code === 0 && parsed?.moduleAvailable === true && dependenciesAvailable) {
			return {
				ready: Boolean(cache?.hasConfig && cache?.hasWeights && cache.voices?.length),
				model: MODEL_ID,
				sampleRate: SAMPLE_RATE,
				defaultVoice: await resolveDefaultVoice(env),
				modelCache: cache,
				runtime: attempts.at(-1),
				network: "disabled",
				attempts,
			};
		}
	}
	return {
		ready: false,
		model: MODEL_ID,
		sampleRate: SAMPLE_RATE,
		defaultVoice: await resolveDefaultVoice(env),
		modelCache: cache,
		runtime: null,
		network: "disabled",
		attempts,
	};
}

export async function synthesizeWithKokoro({ text, voice, outputPath, env = process.env }) {
	const cache = await findModelCache(env);
	if (!cache?.hasConfig || !cache?.hasWeights || !cache.voices?.length) {
		const error = new Error(`Kokoro model cache is unavailable for ${MODEL_ID}`);
		error.code = "KOKORO_MODEL_UNAVAILABLE";
		throw error;
	}
	if (!cache.voices.includes(voice)) {
		const error = new Error(
			`Kokoro voice is unavailable in the local cache: ${voice} (available: ${cache.voices.join(", ")})`,
		);
		error.code = "KOKORO_VOICE_UNAVAILABLE";
		error.availableVoices = cache.voices;
		throw error;
	}
	let lastFailure = null;
	const failures = [];
	for (const python of pythonCandidates(env)) {
		const result = await runPython(
			python,
			[
				"--synthesize",
				"--voice",
				voice,
				"--output",
				outputPath,
				"--sample-rate",
				String(SAMPLE_RATE),
			],
			text,
			env,
			cache,
		);
		const parsed = parseRuntimeOutput(result);
		if (result.code === 0 && parsed?.ok === true) {
			return { ...parsed, python, model: MODEL_ID, sampleRate: SAMPLE_RATE, modelCache: cache };
		}
		const failureMessage = parsed?.error ?? (result.stderr.trim() || result.error?.message);
		lastFailure = new Error(
			failureMessage || `Kokoro runtime exited with code ${result.code ?? "unknown"}`,
		);
		lastFailure.code = parsed?.code ?? "KOKORO_RUNTIME_FAILED";
		failures.push({ python, code: lastFailure.code, message: lastFailure.message });
	}
	if (!lastFailure) throw new Error("No compatible local Kokoro runtime found");
	lastFailure.message = `No compatible local Kokoro runtime succeeded: ${failures
		.map((failure) => `${failure.python}: ${failure.message}`)
		.join("; ")}`;
	lastFailure.attempts = failures;
	throw lastFailure;
}

export const KOKORO_MODEL_ID = MODEL_ID;
export const KOKORO_SAMPLE_RATE = SAMPLE_RATE;
export const KOKORO_DEFAULT_VOICE = PREFERRED_DEFAULT_VOICE;
