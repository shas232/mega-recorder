#!/usr/bin/env node

/**
 * Loopback-only Remotion preview server.
 *
 * This intentionally does not use `remotion studio` or @remotion/cli. The
 * selected manifest is validated, its local media is rewritten to opaque
 * allowlisted URLs, and a small React/@remotion/player shell is bundled with
 * the selected composition. The server never opens a browser and never serves
 * arbitrary filesystem paths.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	isRemoteAsset,
	normalizeManifest,
	resolveManifestPath,
} from "../../integrations/remotion/src/schema.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(MODULE_PATH);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const RUNTIME_ROOT = path.join(REPO_ROOT, "integrations", "remotion");
const DEFAULT_COMPONENT = path.join(RUNTIME_ROOT, "src", "composition.jsx");
const DEFAULT_ENTRYPOINT = path.join(RUNTIME_ROOT, "src", "index.jsx");
const DEFAULT_HOST = "127.0.0.1";
const MANIFEST_ROUTE = "/__mega_recorder_manifest.json";
const MEDIA_ROUTE_PREFIX = "/__mega_recorder_media/";

let activePreview = null;

function errorWithCode(code, message, details = {}) {
	const error = new Error(message);
	error.code = code;
	Object.assign(error, details);
	return error;
}

function absolute(value, baseDir = process.cwd()) {
	if (typeof value !== "string" || value.trim() === "") {
		throw errorWithCode("REMOTION_PATH_REQUIRED", "A non-empty path is required.");
	}
	return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDir, value);
}

async function readManifest(manifestPath) {
	const absolutePath = absolute(manifestPath);
	let input;
	try {
		input = JSON.parse(await fsp.readFile(absolutePath, "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT") {
			throw errorWithCode("REMOTION_FILE_NOT_FOUND", `Manifest not found: ${absolutePath}`, {
				path: absolutePath,
			});
		}
		if (error instanceof SyntaxError) {
			throw errorWithCode("REMOTION_JSON_INVALID", `Invalid manifest JSON: ${absolutePath}`, {
				path: absolutePath,
			});
		}
		throw error;
	}
	const manifest = normalizeManifest(input, {
		baseDir: path.dirname(absolutePath),
		checkAssets: true,
	});
	return { path: absolutePath, manifest };
}

function mediaContentType(filePath) {
	const extension = path.extname(filePath).toLowerCase();
	return (
		{
			".mp4": "video/mp4",
			".m4v": "video/mp4",
			".webm": "video/webm",
			".mov": "video/quicktime",
			".mkv": "video/x-matroska",
			".mp3": "audio/mpeg",
			".wav": "audio/wav",
			".m4a": "audio/mp4",
			".aac": "audio/aac",
			".ogg": "audio/ogg",
			".oga": "audio/ogg",
			".flac": "audio/flac",
		}[extension] ?? "application/octet-stream"
	);
}

function staticContentType(filePath) {
	const extension = path.extname(filePath).toLowerCase();
	return (
		{
			".html": "text/html; charset=utf-8",
			".js": "text/javascript; charset=utf-8",
			".mjs": "text/javascript; charset=utf-8",
			".css": "text/css; charset=utf-8",
			".json": "application/json; charset=utf-8",
			".map": "application/json; charset=utf-8",
			".svg": "image/svg+xml",
			".ico": "image/x-icon",
			".png": "image/png",
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".woff": "font/woff",
			".woff2": "font/woff2",
		}[extension] ?? "application/octet-stream"
	);
}

function routeMedia(manifest) {
	const files = new Map();
	const ids = new Map();
	const clone = structuredClone(manifest);
	delete clone.baseDir;

	const register = (value) => {
		if (typeof value !== "string" || isRemoteAsset(value)) return value;
		const normalized = path.normalize(value);
		const existing = ids.get(normalized);
		if (existing) return `${MEDIA_ROUTE_PREFIX}${existing}`;
		const id = randomBytes(12).toString("hex");
		ids.set(normalized, id);
		files.set(id, normalized);
		return `${MEDIA_ROUTE_PREFIX}${id}`;
	};

	for (const scene of clone.scenes ?? []) {
		for (const element of scene.elements ?? []) {
			if (element.type === "video") element.src = register(element.src);
		}
		for (const clip of scene.audio ?? []) clip.src = register(clip.src);
	}
	for (const clip of clone.audioTimeline ?? []) clip.src = register(clip.src);
	return { manifest: clone, files };
}

function jsonResponse(response, statusCode, value) {
	const body = Buffer.from(JSON.stringify(value));
	response.writeHead(statusCode, {
		"Cache-Control": "no-store",
		"Content-Length": body.length,
		"Content-Type": "application/json; charset=utf-8",
	});
	response.end(body);
}

function notFound(response) {
	jsonResponse(response, 404, { ok: false, error: "Not found" });
}

function methodNotAllowed(response) {
	response.writeHead(405, { Allow: "GET, HEAD" });
	response.end();
}

function unauthorized(response) {
	jsonResponse(response, 401, { ok: false, error: "Preview authentication required" });
}

function forbidden(response) {
	jsonResponse(response, 403, { ok: false, error: "Preview request rejected" });
}

function cookieValue(request, name) {
	const cookies = request.headers.cookie?.split(";") ?? [];
	for (const cookie of cookies) {
		const separator = cookie.indexOf("=");
		if (separator < 0) continue;
		if (cookie.slice(0, separator).trim() === name) return cookie.slice(separator + 1).trim();
	}
	return null;
}

async function serveMedia(response, request, filePath, headOnly) {
	let stat;
	try {
		stat = await fsp.stat(filePath);
	} catch {
		notFound(response);
		return;
	}
	if (!stat.isFile()) {
		notFound(response);
		return;
	}

	const headers = {
		"Accept-Ranges": "bytes",
		"Cache-Control": "no-store",
		"Content-Type": mediaContentType(filePath),
		"Cross-Origin-Resource-Policy": "same-origin",
	};
	let start = 0;
	let end = stat.size - 1;
	let statusCode = 200;
	const range = request.headers.range;
	if (range) {
		const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
		if (!match) {
			response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
			response.end();
			return;
		}
		if (match[1] === "" && match[2] === "") {
			response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
			response.end();
			return;
		}
		if (match[1] === "") {
			const suffix = Number(match[2]);
			if (!Number.isSafeInteger(suffix) || suffix <= 0) {
				response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
				response.end();
				return;
			}
			start = Math.max(0, stat.size - suffix);
		} else {
			start = Number(match[1]);
			if (!Number.isSafeInteger(start) || start >= stat.size) {
				response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
				response.end();
				return;
			}
		}
		if (match[1] !== "" && match[2] !== "") end = Math.min(end, Number(match[2]));
		if (!Number.isSafeInteger(end) || end < start) {
			response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
			response.end();
			return;
		}
		statusCode = 206;
		headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
	}
	headers["Content-Length"] = end - start + 1;
	response.writeHead(statusCode, headers);
	if (headOnly) {
		response.end();
		return;
	}
	fs.createReadStream(filePath, { start, end }).pipe(response);
}

async function serveStatic(response, request, bundleRoot, pathname, headOnly) {
	let relative = pathname === "/" ? "index.html" : pathname.slice(1);
	try {
		relative = decodeURIComponent(relative);
	} catch {
		notFound(response);
		return;
	}
	if (relative.includes("\\") || relative.split("/").includes("..")) {
		notFound(response);
		return;
	}
	const candidate = path.resolve(bundleRoot, relative);
	const rootWithSeparator = `${path.resolve(bundleRoot)}${path.sep}`;
	if (candidate !== path.resolve(bundleRoot) && !candidate.startsWith(rootWithSeparator)) {
		notFound(response);
		return;
	}
	let stat;
	try {
		stat = await fsp.stat(candidate);
	} catch {
		notFound(response);
		return;
	}
	if (!stat.isFile()) {
		notFound(response);
		return;
	}
	response.writeHead(200, {
		"Cache-Control": "no-store",
		"Content-Length": stat.size,
		"Content-Type": staticContentType(candidate),
	});
	if (headOnly) {
		response.end();
		return;
	}
	fs.createReadStream(candidate).pipe(response);
}

function entrySource({ entryPoint, manifestPath }) {
	const supplied = entryPoint ?? null;
	const resolved = supplied
		? resolveManifestPath(supplied, path.dirname(manifestPath))
		: DEFAULT_ENTRYPOINT;
	if (isRemoteAsset(resolved))
		throw errorWithCode("REMOTION_ENTRY_REMOTE", "Entrypoint must be local.");
	if (!fs.existsSync(resolved)) {
		throw errorWithCode("REMOTION_ENTRY_NOT_FOUND", `Remotion entrypoint not found: ${resolved}`, {
			path: resolved,
		});
	}
	return resolved;
}

export function playerEntrySource(componentEntry) {
	const componentImport =
		componentEntry === DEFAULT_ENTRYPOINT ? DEFAULT_COMPONENT : componentEntry;
	const custom = componentEntry !== DEFAULT_ENTRYPOINT;
	const siblingComposition = custom
		? path.join(path.dirname(componentEntry), "composition.jsx")
		: null;
	const hasSiblingComposition = Boolean(siblingComposition && fs.existsSync(siblingComposition));
	const compositionImport = custom
		? hasSiblingComposition
			? `import {MegaComposition as SiblingComposition} from ${JSON.stringify(siblingComposition)};`
			: `import * as CustomEntry from ${JSON.stringify(componentImport)};`
		: `import {MegaComposition as DefaultComposition} from ${JSON.stringify(componentImport)};`;
	const componentExpression = custom
		? hasSiblingComposition
			? "SiblingComposition"
			: "CustomEntry.MegaComposition ?? CustomEntry.Composition ?? CustomEntry.default ?? CustomEntry.Root"
		: "DefaultComposition";
	return `
import React, {useEffect, useState} from "react";
import {createRoot} from "react-dom/client";
import {Player} from "@remotion/player";
${compositionImport}
import "./preview.css";

const component = ${componentExpression};

function Preview() {
  const [state, setState] = useState({status: "loading", manifest: null, error: null});
  useEffect(() => {
    fetch(${JSON.stringify(MANIFEST_ROUTE)}, {cache: "no-store"})
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Unable to load preview manifest")))
      .then((manifest) => setState({status: "ready", manifest, error: null}))
      .catch((error) => setState({status: "error", manifest: null, error: error.message}));
  }, []);
  if (state.status === "loading") return <main className="status">Loading manifest…</main>;
  if (state.status === "error") return <main className="status error">{state.error}</main>;
  if (!component) return <main className="status error">The custom entrypoint must export a React composition component.</main>;
  const manifest = state.manifest;
  return <main className="shell">
    <header><div><strong>MEGA RECORDER</strong><span>Remotion preview</span></div><small>{manifest.mode} · {manifest.width}×{manifest.height} · {manifest.fps} fps</small></header>
    <section className="player"><Player component={component} inputProps={{manifest}} durationInFrames={manifest.durationInFrames} compositionWidth={manifest.width} compositionHeight={manifest.height} fps={manifest.fps} controls autoPlay={false} loop={false} clickToPlay acknowledgeRemotionLicense style={{width: "100%", height: "100%"}} /></section>
    <footer>Local preview · playback and scrubbing stay in this page</footer>
  </main>;
}

createRoot(document.getElementById("video-container")).render(<Preview />);
`;
}

async function writePlayerEntry(workRoot, componentEntry) {
	const source = playerEntrySource(componentEntry);
	await fsp.writeFile(path.join(workRoot, "preview-entry.jsx"), source, "utf8");
	await fsp.writeFile(
		path.join(workRoot, "preview.css"),
		`*{box-sizing:border-box}html,body,#root{margin:0;width:100%;min-height:100%;background:#080b12;color:#e5e7eb;font-family:Inter,ui-sans-serif,system-ui,sans-serif}body{min-height:100vh}.shell{width:min(1180px,100%);margin:0 auto;padding:24px 24px 16px}.shell header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:16px;color:#8f9bb0}.shell header div{display:flex;align-items:baseline;gap:12px}.shell header strong{font-size:12px;letter-spacing:.16em;color:#f8fafc}.shell header span{font-size:13px}.shell header small{font-size:12px}.player{width:100%;aspect-ratio:16/9;background:#03050a;border:1px solid #222a38;border-radius:14px;overflow:hidden;box-shadow:0 22px 70px #0008}.shell footer{padding-top:12px;font-size:12px;color:#778399}.status{display:grid;place-items:center;min-height:100vh;color:#aeb9ca}.status.error{color:#ff9b9b;padding:24px;text-align:center}`,
		"utf8",
	);
}

async function createPreview(options = {}) {
	if (activePreview)
		throw errorWithCode("REMOTION_PREVIEW_ACTIVE", "A Remotion preview is already running.");
	const { path: manifestPath, manifest } = await readManifest(
		options.manifestPath ?? options.projectPath,
	);
	const routed = routeMedia(manifest);
	const componentEntry = entrySource({
		entryPoint: options.entryPoint ?? manifest.entryPoint,
		manifestPath,
	});
	// Keep the generated entrypoint below the isolated runtime so webpack can
	// resolve its React/Remotion dependencies without consulting the workspace
	// or any user-level package tree. It is removed when the preview closes.
	const workRoot = await fsp.mkdtemp(path.join(RUNTIME_ROOT, ".preview-"));
	const bundleRoot = path.join(workRoot, "bundle");
	try {
		await fsp.mkdir(path.join(workRoot, "public"), { recursive: true });
		await writePlayerEntry(workRoot, componentEntry);
		const { bundle } = await import(
			"../../integrations/remotion/node_modules/@remotion/bundler/dist/index.js"
		);
		await bundle({
			entryPoint: path.join(workRoot, "preview-entry.jsx"),
			outDir: bundleRoot,
			rootDir: RUNTIME_ROOT,
			publicDir: path.join(workRoot, "public"),
			ignoreRegisterRootWarning: true,
			enableCaching: false,
			webpackOverride: (configuration) => ({
				...configuration,
				resolve: {
					...configuration.resolve,
					modules: [
						path.join(RUNTIME_ROOT, "node_modules"),
						...(configuration.resolve?.modules ?? []),
					],
				},
			}),
		});
		const port = Number.isInteger(options.port) && options.port >= 0 ? options.port : 0;
		const authToken = randomBytes(24).toString("base64url");
		let boundPort = null;
		const server = http.createServer(async (request, response) => {
			if (request.method !== "GET" && request.method !== "HEAD") {
				methodNotAllowed(response);
				return;
			}
			const requestUrl = new URL(request.url ?? "/", `http://${DEFAULT_HOST}`);
			const allowedHosts = new Set([`${DEFAULT_HOST}:${boundPort}`, `localhost:${boundPort}`]);
			if (typeof request.headers.host !== "string" || !allowedHosts.has(request.headers.host)) {
				forbidden(response);
				return;
			}
			const allowedOrigins = new Set([
				`http://${DEFAULT_HOST}:${boundPort}`,
				`http://localhost:${boundPort}`,
			]);
			if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) {
				forbidden(response);
				return;
			}
			const tokenInQuery = requestUrl.searchParams.get("token");
			const initialHandshake = requestUrl.pathname === "/" && tokenInQuery === authToken;
			if (cookieValue(request, "megaRecorderPreview") !== authToken && !initialHandshake) {
				unauthorized(response);
				return;
			}
			if (initialHandshake) {
				response.setHeader(
					"Set-Cookie",
					"megaRecorderPreview=" + authToken + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600",
				);
			}
			if (requestUrl.pathname === MANIFEST_ROUTE) {
				const body = Buffer.from(JSON.stringify(routed.manifest));
				response.writeHead(200, {
					"Cache-Control": "no-store",
					"Content-Length": body.length,
					"Content-Type": "application/json; charset=utf-8",
				});
				if (request.method === "HEAD") response.end();
				else response.end(body);
				return;
			}
			if (requestUrl.pathname.startsWith(MEDIA_ROUTE_PREFIX)) {
				const id = requestUrl.pathname.slice(MEDIA_ROUTE_PREFIX.length);
				const mediaPath = routed.files.get(id);
				if (!mediaPath || id.includes("/") || id.includes("\\")) {
					notFound(response);
					return;
				}
				await serveMedia(response, request, mediaPath, request.method === "HEAD");
				return;
			}
			await serveStatic(
				response,
				request,
				bundleRoot,
				requestUrl.pathname,
				request.method === "HEAD",
			);
		});

		await new Promise((resolve, reject) => {
			const onError = (error) => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(port, DEFAULT_HOST);
		});
		const address = server.address();
		const actualPort = typeof address === "object" && address ? address.port : port;
		boundPort = actualPort;
		let closing = false;
		const close = async () => {
			if (closing) return;
			closing = true;
			await new Promise((resolve) => {
				server.close(() => resolve());
			});
			await fsp.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
			if (activePreview?.server === server) activePreview = null;
		};
		const onSignal = () => {
			void close();
		};
		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);
		activePreview = { server, close, onSignal, workRoot, port: actualPort, authToken };
		return {
			ok: true,
			url: `http://${DEFAULT_HOST}:${actualPort}/?token=${encodeURIComponent(authToken)}`,
			host: DEFAULT_HOST,
			port: actualPort,
			pid: process.pid,
			manifestPath,
			entryPoint: componentEntry,
			mediaCount: routed.files.size,
		};
	} catch (error) {
		await fsp.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

export async function preview(options = {}) {
	return createPreview(options);
}

export async function closePreview() {
	if (!activePreview) return { ok: true, closed: false };
	const current = activePreview;
	process.off("SIGINT", current.onSignal);
	process.off("SIGTERM", current.onSignal);
	await current.close();
	return { ok: true, closed: true, port: current.port };
}

async function main(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token.startsWith("--")) continue;
		const key = token.slice(2);
		const value = argv[index + 1];
		if (value !== undefined && !value.startsWith("--")) {
			values.set(key, value);
			index += 1;
		} else values.set(key, true);
	}
	const result = await preview({
		manifestPath: values.get("manifest") ?? argv.find((item) => !item.startsWith("--")),
		entryPoint: values.get("entry") ?? values.get("entry-point"),
		port: values.has("port") ? Number(values.get("port")) : 0,
	});
	process.stdout.write(`${JSON.stringify(result)}\n`);
	await new Promise((resolve) => {
		const done = () => {
			void closePreview().finally(resolve);
		};
		process.once("SIGINT", done);
		process.once("SIGTERM", done);
	});
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === path.resolve(MODULE_PATH)) {
	try {
		await main(process.argv.slice(2));
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({ ok: false, error: { code: error.code ?? "REMOTION_PREVIEW_FAILED", message: error.message } })}\n`,
		);
		process.exitCode = 1;
	}
}
