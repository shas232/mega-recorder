import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createStarterManifest,
	isRemoteAsset,
	normalizeManifest,
	resolveManifestPath,
} from "../../integrations/remotion/src/schema.mjs";
import { probeMedia } from "./verify.mjs";

export const REMOTION_VERSION = "4.0.521";
export const BRAVE_EXECUTABLE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
export const COMPOSITION_ID = "MegaRecorder";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
export const RUNTIME_ROOT = path.join(REPO_ROOT, "integrations", "remotion");
export const DEFAULT_ENTRYPOINT = path.join(RUNTIME_ROOT, "src", "index.jsx");
const PACKAGE_PATH = path.join(RUNTIME_ROOT, "package.json");
const LOCK_PATH = path.join(RUNTIME_ROOT, "package-lock.json");
let remotionModules;

async function loadRemotionModules() {
	if (!remotionModules) {
		const bundler = await import(
			pathToFileURL(
				path.join(RUNTIME_ROOT, "node_modules", "@remotion", "bundler", "dist", "index.js"),
			).href
		);
		const renderer = await import(
			pathToFileURL(
				path.join(RUNTIME_ROOT, "node_modules", "@remotion", "renderer", "dist", "index.js"),
			).href
		);
		remotionModules = {
			bundle: bundler.bundle,
			renderMedia: renderer.renderMedia,
			selectComposition: renderer.selectComposition,
		};
	}
	return remotionModules;
}

function errorWithCode(code, message, details = {}) {
	const error = new Error(message);
	error.code = code;
	Object.assign(error, details);
	return error;
}

async function readJson(filePath) {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT")
			throw errorWithCode("REMOTION_FILE_NOT_FOUND", `File not found: ${filePath}`, {
				path: filePath,
			});
		if (error instanceof SyntaxError)
			throw errorWithCode("REMOTION_JSON_INVALID", `Invalid JSON: ${filePath}`, { path: filePath });
		throw error;
	}
}

function asAbsolute(value, baseDir = process.cwd()) {
	return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDir, value);
}

function canonicalPath(value) {
	const absolute = path.resolve(value);
	try {
		return fsSync.realpathSync.native(absolute);
	} catch {
		try {
			return path.join(fsSync.realpathSync.native(path.dirname(absolute)), path.basename(absolute));
		} catch {
			return absolute;
		}
	}
}

function packageVersions(packageJson) {
	return {
		remotion: packageJson.dependencies?.remotion ?? null,
		"@remotion/bundler": packageJson.dependencies?.["@remotion/bundler"] ?? null,
		"@remotion/renderer": packageJson.dependencies?.["@remotion/renderer"] ?? null,
		"@remotion/transitions": packageJson.dependencies?.["@remotion/transitions"] ?? null,
	};
}

export async function doctor() {
	const checks = {};
	try {
		const packageJson = await readJson(PACKAGE_PATH);
		const versions = packageVersions(packageJson);
		checks.package = {
			ok: true,
			versions,
			exact: Object.values(versions).every((value) => value === REMOTION_VERSION),
		};
	} catch (error) {
		checks.package = { ok: false, error: error.message };
	}
	checks.lockfile = { ok: fsSync.existsSync(LOCK_PATH), path: LOCK_PATH };
	checks.nodeModules = {
		ok: fsSync.existsSync(path.join(RUNTIME_ROOT, "node_modules", "remotion")),
	};
	checks.brave = { ok: fsSync.existsSync(BRAVE_EXECUTABLE), executable: BRAVE_EXECUTABLE };
	checks.ffmpeg = {
		ok: Boolean(spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0),
	};
	checks.node = {
		ok: Number.parseInt(process.versions.node.split(".")[0], 10) >= 22,
		version: process.versions.node,
	};
	return {
		ok:
			checks.package.ok &&
			checks.package.exact &&
			checks.lockfile.ok &&
			checks.nodeModules.ok &&
			checks.brave.ok &&
			checks.node.ok,
		ready:
			checks.package.ok &&
			checks.package.exact &&
			checks.nodeModules.ok &&
			checks.brave.ok &&
			checks.node.ok,
		version: REMOTION_VERSION,
		browser: "Brave",
		checks,
	};
}

export async function setup({ install = true } = {}) {
	if (!install) return { ok: true, skipped: true, runtimeRoot: RUNTIME_ROOT };
	const result = spawnSync("npm", ["ci", "--ignore-scripts"], {
		cwd: RUNTIME_ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		throw errorWithCode(
			"REMOTION_SETUP_FAILED",
			result.stderr?.trim() || "Remotion npm install failed.",
		);
	}
	return { ok: true, runtimeRoot: RUNTIME_ROOT, stdout: result.stdout?.trim() ?? "" };
}

export async function init({
	outputPath = "remotion.scene.json",
	mode = "animation",
	fps = 30,
	width = 1280,
	height = 720,
	overwrite = false,
} = {}) {
	const absolute = asAbsolute(outputPath);
	if (!overwrite && fsSync.existsSync(absolute))
		throw errorWithCode(
			"REMOTION_OUTPUT_EXISTS",
			`Refusing to overwrite existing manifest: ${absolute}`,
			{ path: absolute },
		);
	const manifest = createStarterManifest({ mode, fps, width, height });
	const sourceDir = path.join(
		path.dirname(absolute),
		`${path.basename(absolute, path.extname(absolute))}.src`,
	);
	if (!overwrite && fsSync.existsSync(sourceDir))
		throw errorWithCode(
			"REMOTION_OUTPUT_EXISTS",
			`Refusing to overwrite existing source scaffold: ${sourceDir}`,
			{ path: sourceDir },
		);
	const scaffoldEntry = path.join(sourceDir, "index.jsx");
	manifest.entryPoint = path.relative(path.dirname(absolute), scaffoldEntry);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	await fs.mkdir(path.join(sourceDir, "assets"), { recursive: true });
	await fs.copyFile(path.join(RUNTIME_ROOT, "src", "index.jsx"), scaffoldEntry);
	await fs.copyFile(
		path.join(RUNTIME_ROOT, "src", "composition.jsx"),
		path.join(sourceDir, "composition.jsx"),
	);
	await fs.writeFile(path.join(sourceDir, "assets", ".gitkeep"), "", "utf8");
	await fs.writeFile(absolute, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	return { ok: true, path: absolute, sourceDir, entryPoint: scaffoldEntry, manifest };
}

export async function readAndValidate({ manifestPath, projectPath, checkAssets = true } = {}) {
	const inputPath = manifestPath ?? projectPath;
	if (!inputPath) throw errorWithCode("REMOTION_MANIFEST_REQUIRED", "A manifest path is required.");
	const absolute = asAbsolute(inputPath);
	const input = await readJson(absolute);
	const manifest = normalizeManifest(input, { baseDir: path.dirname(absolute), checkAssets });
	if (checkAssets) await validateMediaRanges(manifest);
	return { path: absolute, input, manifest };
}

async function validateMediaRanges(manifest) {
	const probes = new Map();
	const getProbe = async (src) => {
		if (!probes.has(src)) probes.set(src, probeMedia(src));
		return probes.get(src);
	};
	for (const scene of manifest.scenes) {
		for (const element of scene.elements) {
			if (
				element.type !== "video" ||
				(element.startFrom === undefined && element.endAt === undefined)
			)
				continue;
			const probed = await getProbe(element.src);
			const fps = probed.metadata.video?.fps;
			const durationInFrames =
				fps && probed.metadata.durationSec ? Math.ceil(fps * probed.metadata.durationSec) : null;
			if (durationInFrames === null) continue;
			if (element.startFrom !== undefined && element.startFrom >= durationInFrames)
				throw errorWithCode(
					"REMOTION_MEDIA_RANGE_INVALID",
					`Video startFrom is outside the source duration: ${element.src}`,
					{ path: element.src, startFrom: element.startFrom, durationInFrames },
				);
			if (element.endAt !== undefined && element.endAt > durationInFrames)
				throw errorWithCode(
					"REMOTION_MEDIA_RANGE_INVALID",
					`Video endAt is outside the source duration: ${element.src}`,
					{ path: element.src, endAt: element.endAt, durationInFrames },
				);
		}
		for (const clip of scene.audio ?? []) {
			if (!clip.trimBefore) continue;
			const probed = await getProbe(clip.src);
			const durationInFrames = probed.metadata.durationSec
				? Math.ceil(manifest.fps * probed.metadata.durationSec)
				: null;
			if (durationInFrames !== null && clip.trimBefore >= durationInFrames)
				throw errorWithCode(
					"REMOTION_MEDIA_RANGE_INVALID",
					`Audio trimBefore is outside the source duration: ${clip.src}`,
					{ path: clip.src, trimBefore: clip.trimBefore, durationInFrames },
				);
		}
	}
}

export async function validate({ manifestPath, projectPath, checkAssets = true } = {}) {
	const { path: absolute, manifest } = await readAndValidate({
		manifestPath,
		projectPath,
		checkAssets,
	});
	return {
		ok: true,
		path: absolute,
		manifest,
		timeline: {
			durationInFrames: manifest.durationInFrames,
			sceneStarts: manifest.sceneStarts,
			audio: manifest.audioTimeline,
		},
	};
}

async function stageManifestAssets(manifest) {
	const publicDir = await fs.mkdtemp(path.join(os.tmpdir(), "mega-recorder-remotion-public-"));
	const assetsDir = path.join(publicDir, "assets");
	await fs.mkdir(assetsDir, { recursive: true });
	const mapping = new Map();
	const copyAsset = async (value) => {
		if (isRemoteAsset(value)) return value;
		if (mapping.has(value)) return mapping.get(value);
		const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
		const safeName = path.basename(value).replace(/[^A-Za-z0-9._-]+/gu, "_");
		const relative = `assets/${digest}-${safeName}`;
		await fs.copyFile(value, path.join(publicDir, relative));
		mapping.set(value, relative);
		return relative;
	};
	const copy = structuredClone(manifest);
	for (const scene of copy.scenes) {
		for (const element of scene.elements) {
			if (element.type === "video") element.src = await copyAsset(element.src);
		}
		for (const clip of scene.audio ?? []) clip.src = await copyAsset(clip.src);
	}
	for (const clip of copy.audioTimeline ?? []) clip.src = await copyAsset(clip.src);
	return { manifest: copy, publicDir };
}

function collectProtectedPaths(manifestPath, manifest) {
	const protectedPaths = [manifestPath];
	for (const scene of manifest.scenes) {
		for (const element of scene.elements)
			if (element.type === "video" && !isRemoteAsset(element.src)) protectedPaths.push(element.src);
		for (const clip of scene.audio ?? [])
			if (!isRemoteAsset(clip.src)) protectedPaths.push(clip.src);
	}
	return protectedPaths.map((item) => path.normalize(item));
}

function resolveEntryPoint(entryPoint, manifest, manifestPath) {
	const raw = entryPoint ?? manifest.entryPoint ?? DEFAULT_ENTRYPOINT;
	if (typeof raw !== "string" || raw.trim() === "")
		throw errorWithCode("REMOTION_ENTRY_REQUIRED", "Remotion entrypoint must be a non-empty path.");
	const resolved = resolveManifestPath(raw, path.dirname(manifestPath));
	if (isRemoteAsset(resolved))
		throw errorWithCode("REMOTION_ENTRY_REMOTE", "Remotion entrypoint must be local.");
	return resolved;
}

export async function render({
	manifestPath,
	projectPath,
	outputPath,
	overwrite = false,
	entryPoint,
	concurrency = 1,
	browserExecutable = BRAVE_EXECUTABLE,
} = {}) {
	const { path: absoluteManifestPath, manifest } = await readAndValidate({
		manifestPath,
		projectPath,
		checkAssets: true,
	});
	if (!outputPath && !manifest.output)
		throw errorWithCode(
			"REMOTION_OUTPUT_REQUIRED",
			"Render requires --output or manifest.output; source files are never replaced by default.",
		);
	const output = asAbsolute(outputPath ?? manifest.output, path.dirname(absoluteManifestPath));
	const entry = resolveEntryPoint(entryPoint, manifest, absoluteManifestPath);
	const protectedPaths = [...collectProtectedPaths(absoluteManifestPath, manifest), entry];
	const outputCanonical = canonicalPath(output);
	const sameSourcePath = protectedPaths.some((item) => canonicalPath(item) === outputCanonical);
	const sameSourceFile =
		fsSync.existsSync(output) &&
		protectedPaths.some((item) => {
			try {
				const sourceStat = fsSync.statSync(item);
				const outputStat = fsSync.statSync(output);
				return sourceStat.dev === outputStat.dev && sourceStat.ino === outputStat.ino;
			} catch {
				return false;
			}
		});
	if (sameSourcePath || sameSourceFile)
		throw errorWithCode(
			"REMOTION_SOURCE_OVERWRITE",
			"Output path points to a manifest or source asset; choose a new output path.",
			{ path: output },
		);
	if (!overwrite && fsSync.existsSync(output))
		throw errorWithCode(
			"REMOTION_OUTPUT_EXISTS",
			`Refusing to overwrite existing output: ${output}`,
			{ path: output },
		);
	if (!fsSync.existsSync(browserExecutable))
		throw errorWithCode(
			"REMOTION_BRAVE_NOT_FOUND",
			`Brave executable not found at ${browserExecutable}; no Chrome fallback is permitted.`,
			{ path: browserExecutable },
		);
	if (!fsSync.existsSync(entry))
		throw errorWithCode("REMOTION_ENTRY_NOT_FOUND", `Remotion entrypoint not found: ${entry}`, {
			path: entry,
		});
	await fs.mkdir(path.dirname(output), { recursive: true });
	const outputExtension = path.extname(output) || ".mp4";
	const renderLocation = path.join(
		path.dirname(output),
		`.${path.basename(output, outputExtension)}.${process.pid}.tmp${outputExtension}`,
	);
	if (fsSync.existsSync(renderLocation))
		throw errorWithCode(
			"REMOTION_TEMP_EXISTS",
			`Temporary render path already exists: ${renderLocation}`,
		);
	const staged = await stageManifestAssets(manifest);
	const props = { manifest: staged.manifest };
	let serveUrl = null;
	let selectedComposition = null;
	try {
		const { bundle, selectComposition, renderMedia } = await loadRemotionModules();
		serveUrl = await bundle({
			entryPoint: entry,
			rootDir: RUNTIME_ROOT,
			publicDir: staged.publicDir,
			enableCaching: true,
			webpackOverride: (config) => ({
				...config,
				resolve: {
					...config.resolve,
					modules: [path.join(RUNTIME_ROOT, "node_modules"), ...(config.resolve?.modules ?? [])],
				},
			}),
		});
		selectedComposition = await selectComposition({
			serveUrl,
			id: COMPOSITION_ID,
			inputProps: props,
			browserExecutable,
			logLevel: "error",
		});
		await renderMedia({
			serveUrl,
			composition: selectedComposition,
			inputProps: props,
			codec: "h264",
			outputLocation: renderLocation,
			browserExecutable,
			concurrency: Math.max(1, Number(concurrency) || 1),
			overwrite,
			disallowParallelEncoding: true,
			logLevel: "info",
		});
		await fs.rename(renderLocation, output);
	} finally {
		if (serveUrl && fsSync.existsSync(serveUrl))
			await fs.rm(serveUrl, { recursive: true, force: true }).catch(() => undefined);
		await fs.rm(staged.publicDir, { recursive: true, force: true }).catch(() => undefined);
		if (fsSync.existsSync(renderLocation))
			await fs.rm(renderLocation, { force: true }).catch(() => undefined);
	}
	const stat = await fs.stat(output);
	return {
		ok: true,
		path: output,
		bytes: stat.size,
		composition: COMPOSITION_ID,
		fps: selectedComposition.fps,
		width: selectedComposition.width,
		height: selectedComposition.height,
		durationInFrames: selectedComposition.durationInFrames,
		durationSeconds: selectedComposition.durationInFrames / selectedComposition.fps,
		browserExecutable,
	};
}

export async function preview(options = {}) {
	// Keep the optional preview implementation out of the helper's module-load
	// path. Doctor/setup/validate must remain usable before Remotion is
	// installed, while direct helper consumers still get the same loopback-only
	// Player server as the public CLI.
	const runtime = await import(pathToFileURL(path.join(SCRIPT_DIR, "remotion-preview.mjs")).href);
	return runtime.preview({
		...options,
		manifestPath: options.manifestPath ?? options.projectPath,
		projectPath: options.projectPath,
	});
}

async function main(argv) {
	const [command, ...tokens] = argv;
	const values = new Map();
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token.startsWith("--")) continue;
		const key = token.slice(2);
		const value = tokens[index + 1];
		if (value !== undefined && !value.startsWith("--")) {
			values.set(key, value);
			index += 1;
		} else values.set(key, true);
	}
	if (command === "doctor") return doctor();
	if (command === "setup") return setup();
	if (command === "init")
		return init({
			outputPath: values.get("output"),
			mode: values.get("mode") ?? "animation",
			overwrite: values.get("overwrite") === true,
		});
	if (command === "validate")
		return validate({
			manifestPath:
				values.get("manifest") ??
				values.get("project") ??
				tokens.find((item) => !item.startsWith("--")),
		});
	if (command === "render")
		return render({
			manifestPath: values.get("manifest") ?? values.get("project"),
			outputPath: values.get("output"),
			overwrite: values.get("overwrite") === true,
			concurrency: values.get("concurrency") ?? 1,
		});
	if (command === "preview")
		return preview({
			manifestPath: values.get("manifest") ?? values.get("project"),
			projectPath: values.get("project"),
			entryPoint: values.get("entry") ?? DEFAULT_ENTRYPOINT,
			port: Number(values.get("port") ?? 4310),
		});
	throw errorWithCode("REMOTION_COMMAND_UNKNOWN", `Unknown Remotion command: ${command ?? ""}`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === path.resolve(fileURLToPath(import.meta.url))) {
	try {
		const result = await main(process.argv.slice(2));
		const { process: child, ...json } = result ?? {};
		process.stdout.write(`${JSON.stringify(json)}\n`);
		if (child) await new Promise((resolve) => child.once("exit", resolve));
		if (!child) process.exit(0);
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({ ok: false, error: { code: error.code ?? "REMOTION_FAILED", message: error.message } })}\n`,
		);
		process.exitCode = 1;
	}
}
