import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const PROJECT_EXTENSIONS = new Set([".openscreen", ".axcut"]);

function httpError(status, code, message) {
	const error = new Error(message);
	error.status = status;
	error.code = code;
	return error;
}

function json(value) {
	return `${JSON.stringify(value)}\n`;
}

function isWithin(root, candidate) {
	const relative = path.relative(root, candidate);
	return (
		relative === "" ||
		(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
	);
}

async function readJson(filePath) {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8"));
	} catch (error) {
		throw httpError(
			400,
			error?.code === "ENOENT" ? "PROJECT_NOT_FOUND" : "INVALID_PROJECT",
			"Unable to read the selected project.",
		);
	}
}

function projectIdFromDocument(document, projectPath) {
	const id = document?.project?.id;
	if (typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id)) return id;
	// Older v2 project files are migrated by the renderer. Give the browser bridge
	// a deterministic id for that session while keeping it tied to this one file.
	return `browser_${createHash("sha256").update(projectPath).digest("hex").slice(0, 16)}`;
}

function projectSummary(document, projectPath) {
	return {
		id: projectIdFromDocument(document, projectPath),
		title:
			typeof document?.project?.title === "string"
				? document.project.title
				: path.basename(projectPath),
		updatedAt:
			typeof document?.project?.updatedAt === "string"
				? document.project.updatedAt
				: new Date(0).toISOString(),
		assetCount: Array.isArray(document?.assets) ? document.assets.length : 0,
		audioTrackCount: Array.isArray(document?.timeline?.audioTracks)
			? document.timeline.audioTracks.length
			: 0,
	};
}

async function atomicWrite(filePath, document) {
	const temporary = `${filePath}.mega-recorder-${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
	try {
		await fs.writeFile(temporary, json(document), { encoding: "utf8", mode: 0o600 });
		await fs.rename(temporary, filePath);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
		throw httpError(
			500,
			"PROJECT_WRITE_FAILED",
			`Unable to save the selected project: ${error.message}`,
		);
	}
}

function requestToken(request) {
	const authorization = request.headers.authorization;
	return typeof authorization === "string" && authorization.startsWith("Bearer ")
		? authorization.slice("Bearer ".length)
		: null;
}

function tokenFromQuery(url) {
	return url.searchParams.get("token");
}

function contentType(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	return (
		{
			".html": "text/html; charset=utf-8",
			".js": "text/javascript; charset=utf-8",
			".css": "text/css; charset=utf-8",
			".json": "application/json; charset=utf-8",
			".svg": "image/svg+xml",
			".png": "image/png",
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".webm": "video/webm",
			".mp4": "video/mp4",
			".mov": "video/quicktime",
			".m4v": "video/mp4",
			".mp3": "audio/mpeg",
			".m4a": "audio/mp4",
			".aac": "audio/aac",
			".ogg": "audio/ogg",
			".flac": "audio/flac",
			".wav": "audio/wav",
		}[ext] ?? "application/octet-stream"
	);
}

async function bodyJson(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES)
			throw httpError(413, "REQUEST_TOO_LARGE", "Request body is too large.");
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw httpError(400, "INVALID_JSON", "Request body must be JSON.");
	}
}

function canonicalizeSavedDocument(incoming, current, mediaPaths) {
	if (
		!incoming ||
		typeof incoming !== "object" ||
		!incoming.project ||
		typeof incoming.project !== "object"
	) {
		throw httpError(400, "INVALID_DOCUMENT", "Saved document must contain a project object.");
	}
	if (incoming.project.id !== mediaPaths.projectId) {
		throw httpError(403, "PROJECT_SCOPE_VIOLATION", "The document belongs to a different project.");
	}
	const currentAssets = Array.isArray(current.assets) ? current.assets : [];
	const incomingAssets = Array.isArray(incoming.assets) ? incoming.assets : [];
	if (incomingAssets.length !== currentAssets.length) {
		throw httpError(
			403,
			"PROJECT_SCOPE_VIOLATION",
			"Browser editing cannot add or remove project media.",
		);
	}
	const currentById = new Map(currentAssets.map((asset) => [asset?.id, asset]));
	const assets = incomingAssets.map((asset) => {
		const original = currentById.get(asset?.id);
		if (!original || typeof asset?.id !== "string") {
			throw httpError(
				403,
				"PROJECT_SCOPE_VIOLATION",
				"Browser editing cannot change project media.",
			);
		}
		return { ...asset, originalPath: original.originalPath };
	});
	const currentAudioTracks = Array.isArray(current.timeline?.audioTracks)
		? current.timeline.audioTracks
		: [];
	const incomingAudioTracks = Array.isArray(incoming.timeline?.audioTracks)
		? incoming.timeline.audioTracks
		: [];
	if (incomingAudioTracks.length !== currentAudioTracks.length) {
		throw httpError(
			403,
			"PROJECT_SCOPE_VIOLATION",
			"Browser editing cannot add or remove attached audio tracks.",
		);
	}
	const currentAudioById = new Map(currentAudioTracks.map((track) => [track?.id, track]));
	const audioTracks = incomingAudioTracks.map((track) => {
		const original = currentAudioById.get(track?.id);
		if (!original || typeof track?.id !== "string") {
			throw httpError(
				403,
				"PROJECT_SCOPE_VIOLATION",
				"Browser editing cannot change attached audio files.",
			);
		}
		return { ...track, sourcePath: original.sourcePath };
	});
	return {
		...incoming,
		assets,
		timeline: { ...incoming.timeline, audioTracks },
	};
}

export async function createBrowserEditorServer({
	projectPath,
	distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist"),
	host = DEFAULT_HOST,
	port = 0,
	token = randomBytes(32).toString("hex"),
} = {}) {
	if (host !== DEFAULT_HOST)
		throw httpError(400, "LOCALHOST_ONLY", `Browser editor must bind to ${DEFAULT_HOST}.`);
	if (typeof projectPath !== "string" || !projectPath.trim())
		throw httpError(400, "PROJECT_REQUIRED", "A project path is required.");
	const selectedPath = await fs.realpath(path.resolve(projectPath)).catch(() => {
		throw httpError(400, "PROJECT_NOT_FOUND", `Project not found: ${projectPath}`);
	});
	const selectedStat = await fs.stat(selectedPath);
	if (!selectedStat.isFile() || !PROJECT_EXTENSIONS.has(path.extname(selectedPath).toLowerCase())) {
		throw httpError(400, "INVALID_PROJECT", "Project must be an .openscreen or .axcut file.");
	}
	const staticRoot = await fs.realpath(path.resolve(distDir)).catch(() => {
		throw httpError(500, "DIST_NOT_FOUND", `Renderer build not found: ${distDir}`);
	});
	const initialDocument = await readJson(selectedPath);
	const initialProjectId = projectIdFromDocument(initialDocument, selectedPath);
	const mediaPaths = { projectId: initialProjectId };
	let writeTail = Promise.resolve();
	const enqueueWrite = (document) => {
		const run = writeTail.then(() => atomicWrite(selectedPath, document));
		writeTail = run.catch(() => undefined);
		return run;
	};

	const handleBridge = async (request) => {
		const input = await bodyJson(request);
		if (
			!input ||
			typeof input !== "object" ||
			typeof input.domain !== "string" ||
			typeof input.action !== "string"
		) {
			throw httpError(400, "INVALID_BRIDGE_REQUEST", "Bridge requests require domain and action.");
		}
		const document = await readJson(selectedPath);
		const id = projectIdFromDocument(document, selectedPath);
		if (input.domain === "aiEdition" && input.action === "document.listProjects") {
			return { success: true, data: [projectSummary(document, selectedPath)] };
		}
		if (input.domain === "aiEdition" && input.action === "document.get") {
			if (input.payload?.projectId !== id)
				throw httpError(404, "PROJECT_NOT_FOUND", "Project not found.");
			return { success: true, data: { success: true, document } };
		}
		if (input.domain === "aiEdition" && input.action === "document.save") {
			const incoming = input.payload?.document;
			const next = canonicalizeSavedDocument(incoming, document, mediaPaths);
			await enqueueWrite(next);
			return { success: true, data: { success: true, document: next } };
		}
		throw httpError(
			501,
			"UNSUPPORTED_BROWSER_EDITOR_ACTION",
			`Browser editor does not support ${input.domain}.${input.action}.`,
		);
	};

	const handleMedia = async (request, response, assetId) => {
		const document = await readJson(selectedPath);
		const asset = Array.isArray(document.assets)
			? document.assets.find((item) => item?.id === assetId)
			: null;
		if (!asset || typeof asset.originalPath !== "string")
			throw httpError(404, "MEDIA_NOT_FOUND", "Media is not part of the selected project.");
		const mediaPath = await fs.realpath(asset.originalPath).catch(() => null);
		if (!mediaPath) throw httpError(404, "MEDIA_NOT_FOUND", "Referenced media is not available.");
		const mediaStat = await fs.stat(mediaPath);
		if (!mediaStat.isFile())
			throw httpError(404, "MEDIA_NOT_FOUND", "Referenced media is not a file.");
		const range = request.headers.range;
		let start = 0;
		let end = mediaStat.size - 1;
		let status = 200;
		if (typeof range === "string") {
			const match = /^bytes=(\d*)-(\d*)$/.exec(range);
			if (match) {
				if (match[1]) start = Number(match[1]);
				if (match[2]) end = Number(match[2]);
				if (!match[1] && match[2]) start = Math.max(0, mediaStat.size - Number(match[2]));
				end = Math.min(end, mediaStat.size - 1);
				if (start <= end && start >= 0) status = 206;
			}
		}
		if (start > end || start >= mediaStat.size)
			throw httpError(416, "RANGE_NOT_SATISFIABLE", "Requested media range is unavailable.");
		response.writeHead(status, {
			"Content-Type": contentType(mediaPath),
			"Content-Length": end - start + 1,
			"Accept-Ranges": "bytes",
			...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${mediaStat.size}` } : {}),
		});
		createReadStream(mediaPath, { start, end }).pipe(response);
	};

	const handleAudio = async (request, response, trackId) => {
		const document = await readJson(selectedPath);
		const track = Array.isArray(document.timeline?.audioTracks)
			? document.timeline.audioTracks.find((item) => item?.id === trackId)
			: null;
		if (!track || typeof track.sourcePath !== "string")
			throw httpError(404, "AUDIO_NOT_FOUND", "Audio is not attached to the selected project.");
		const mediaPath = await fs.realpath(track.sourcePath).catch(() => null);
		if (!mediaPath)
			throw httpError(404, "AUDIO_NOT_FOUND", "Attached audio file is not available.");
		const mediaStat = await fs.stat(mediaPath);
		if (!mediaStat.isFile())
			throw httpError(404, "AUDIO_NOT_FOUND", "Attached audio file is not a file.");
		const range = request.headers.range;
		let start = 0;
		let end = mediaStat.size - 1;
		let status = 200;
		if (typeof range === "string") {
			const match = /^bytes=(\d*)-(\d*)$/.exec(range);
			if (match) {
				if (match[1]) start = Number(match[1]);
				if (match[2]) end = Number(match[2]);
				if (!match[1] && match[2]) start = Math.max(0, mediaStat.size - Number(match[2]));
				end = Math.min(end, mediaStat.size - 1);
				if (start <= end && start >= 0) status = 206;
			}
		}
		if (start > end || start >= mediaStat.size)
			throw httpError(416, "RANGE_NOT_SATISFIABLE", "Requested audio range is unavailable.");
		response.writeHead(status, {
			"Content-Type": contentType(mediaPath),
			"Content-Length": end - start + 1,
			"Accept-Ranges": "bytes",
			...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${mediaStat.size}` } : {}),
		});
		createReadStream(mediaPath, { start, end }).pipe(response);
	};

	const server = http.createServer(async (request, response) => {
		try {
			const parsedUrl = new URL(request.url ?? "/", `http://${DEFAULT_HOST}`);
			const authenticated = requestToken(request) === token || tokenFromQuery(parsedUrl) === token;
			if (parsedUrl.pathname.startsWith("/api/") && !authenticated)
				throw httpError(401, "UNAUTHORIZED", "A valid browser editor token is required.");
			if (parsedUrl.pathname === "/api/session" && request.method === "GET") {
				const document = await readJson(selectedPath);
				response.writeHead(200, {
					"Content-Type": "application/json; charset=utf-8",
					"Cache-Control": "no-store",
				});
				response.end(
					json({
						project: projectSummary(document, selectedPath),
						capabilities: {
							inspection: true,
							save: true,
							media: true,
							nativeCapture: false,
							export: false,
						},
					}),
				);
				return;
			}
			if (parsedUrl.pathname === "/api/bridge" && request.method === "POST") {
				const result = await handleBridge(request);
				response.writeHead(200, {
					"Content-Type": "application/json; charset=utf-8",
					"Cache-Control": "no-store",
				});
				response.end(json({ ok: true, data: result.data }));
				return;
			}
			if (parsedUrl.pathname.startsWith("/api/media/") && request.method === "GET") {
				const assetId = decodeURIComponent(parsedUrl.pathname.slice("/api/media/".length));
				await handleMedia(request, response, assetId);
				return;
			}
			if (parsedUrl.pathname.startsWith("/api/audio/") && request.method === "GET") {
				const trackId = decodeURIComponent(parsedUrl.pathname.slice("/api/audio/".length));
				await handleAudio(request, response, trackId);
				return;
			}
			if (parsedUrl.pathname.startsWith("/api/"))
				throw httpError(404, "NOT_FOUND", "Unknown browser editor API route.");
			if (request.method !== "GET" && request.method !== "HEAD")
				throw httpError(405, "METHOD_NOT_ALLOWED", "Only static GET requests are supported.");
			const requested = decodeURIComponent(
				parsedUrl.pathname === "/" ? "/index.html" : parsedUrl.pathname,
			);
			const candidate = path.resolve(staticRoot, `.${requested}`);
			if (!isWithin(staticRoot, candidate))
				throw httpError(404, "NOT_FOUND", "Static path is outside the renderer build.");
			const realCandidate = await fs.realpath(candidate).catch(() => null);
			if (!realCandidate || !isWithin(staticRoot, realCandidate))
				throw httpError(404, "NOT_FOUND", "Static asset not found.");
			const stat = await fs.stat(realCandidate);
			if (!stat.isFile()) throw httpError(404, "NOT_FOUND", "Static asset not found.");
			response.writeHead(200, {
				"Content-Type": contentType(realCandidate),
				"Content-Length": stat.size,
				"Cache-Control": realCandidate.endsWith("index.html")
					? "no-cache"
					: "public, max-age=31536000, immutable",
			});
			if (request.method === "HEAD") response.end();
			else createReadStream(realCandidate).pipe(response);
		} catch (error) {
			const status = Number.isInteger(error?.status) ? error.status : 500;
			if (!response.headersSent)
				response.writeHead(status, {
					"Content-Type": "application/json; charset=utf-8",
					"Cache-Control": "no-store",
				});
			response.end(
				json({
					ok: false,
					error: { code: error?.code ?? "SERVER_ERROR", message: error?.message ?? String(error) },
				}),
			);
		}
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: DEFAULT_HOST, port }, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address();
	const boundPort = typeof address === "object" && address ? address.port : port;
	return {
		server,
		host: DEFAULT_HOST,
		port: boundPort,
		token,
		projectPath: selectedPath,
		projectId: initialProjectId,
		url: `http://${DEFAULT_HOST}:${boundPort}/?windowType=editor&browser=1&megaRecorderToken=${encodeURIComponent(token)}`,
		close: () =>
			new Promise((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}

export { DEFAULT_HOST, isWithin };
