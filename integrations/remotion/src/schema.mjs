import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REMOTION_SCHEMA_VERSION = 1;
export const MODES = ["animation", "mixed"];
export const TRANSITIONS = ["none", "fade", "slide"];
export const SLIDE_DIRECTIONS = ["from-left", "from-right", "from-top", "from-bottom"];
export const DEFAULT_FPS = 30;
export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 720;

const remotePattern = /^https?:\/\//i;
const protocolPattern = /^[a-z][a-z\d+.-]*:/i;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const integer = (value) => Number.isInteger(value);

function fail(message, details = {}) {
	const error = new Error(message);
	error.code = "REMOTION_MANIFEST_INVALID";
	Object.assign(error, details);
	throw error;
}

function assertObject(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail(`${label} must be an object.`);
}

function assertString(value, label) {
	if (typeof value !== "string" || value.trim() === "")
		fail(`${label} must be a non-empty string.`);
}

function assertInteger(value, label, minimum = 0) {
	if (!integer(value) || value < minimum) fail(`${label} must be an integer >= ${minimum}.`);
}

function assertNumber(value, label, minimum = 0, maximum = Number.POSITIVE_INFINITY) {
	if (!finite(value) || value < minimum || value > maximum)
		fail(`${label} must be a number between ${minimum} and ${maximum}.`);
}

function assertNoPathTraversal(value, label) {
	if (value.split(/[\\/]/u).includes(".."))
		fail(`${label} must not contain path traversal segments.`);
}

export function isRemoteAsset(value) {
	return remotePattern.test(value);
}

export function resolveManifestPath(value, baseDir = process.cwd()) {
	assertString(value, "Asset path");
	if (isRemoteAsset(value)) return value;
	if (value.startsWith("file://")) {
		try {
			return fileURLToPath(value);
		} catch {
			fail(`Asset path is not a valid file URL: ${value}`);
		}
	}
	if (!path.isAbsolute(value)) {
		assertNoPathTraversal(value, "Asset path");
		return path.resolve(baseDir, value);
	}
	return path.normalize(value);
}

function validateAsset(value, label, { baseDir, allowRemoteAssets, checkAssets }) {
	assertString(value, label);
	if (isRemoteAsset(value)) {
		if (!allowRemoteAssets)
			fail(`${label} must be local; set allowRemoteAssets=true explicitly for remote media.`);
		return value;
	}
	if (protocolPattern.test(value) && !value.startsWith("file://"))
		fail(`${label} uses an unsupported asset protocol.`);
	const resolved = resolveManifestPath(value, baseDir);
	if (checkAssets) {
		if (!fs.existsSync(resolved)) fail(`${label} does not exist: ${resolved}`, { path: resolved });
		if (!fs.statSync(resolved).isFile())
			fail(`${label} must point to a regular file: ${resolved}`, { path: resolved });
	}
	return resolved;
}

function validateBackground(value, label) {
	if (value === undefined) return;
	assertString(value, label);
	if (/url\s*\(|https?:\/\/|data:/iu.test(value))
		fail(`${label} may only contain local color/gradient CSS, not remote assets.`);
}

function validateTransition(transition, sceneIndex, sceneCount) {
	if (transition === undefined || transition === null) return { type: "none", durationInFrames: 0 };
	assertObject(transition, `Scene ${sceneIndex} transition`);
	const type = transition.type ?? "none";
	if (!TRANSITIONS.includes(type)) fail(`Scene ${sceneIndex} transition type is invalid: ${type}`);
	const durationInFrames = transition.durationInFrames ?? 0;
	assertInteger(durationInFrames, `Scene ${sceneIndex} transition durationInFrames`);
	const direction = transition.direction ?? "from-right";
	if (!SLIDE_DIRECTIONS.includes(direction))
		fail(`Scene ${sceneIndex} transition direction is invalid: ${direction}`);
	if (sceneIndex === sceneCount - 1 && durationInFrames > 0)
		fail("The last scene cannot have a transition because there is no following scene.");
	return { type, durationInFrames: type === "none" ? 0 : durationInFrames, direction };
}

function validateTitle(element, sceneIndex, elementIndex) {
	assertString(element.text, `Scene ${sceneIndex} element ${elementIndex} title text`);
	if (element.subtitle !== undefined) assertString(element.subtitle, "Title subtitle");
	if (element.x !== undefined) assertNumber(element.x, "Title x", 0, 100);
	if (element.y !== undefined) assertNumber(element.y, "Title y", 0, 100);
	if (element.align !== undefined && !["left", "center", "right"].includes(element.align))
		fail("Title align must be left, center, or right.");
	return { ...element, type: "title" };
}

function validateDiagram(element, sceneIndex, elementIndex) {
	if (!Array.isArray(element.nodes) || element.nodes.length === 0)
		fail(`Scene ${sceneIndex} element ${elementIndex} diagram needs at least one node.`);
	const nodeIds = new Set();
	const nodes = element.nodes.map((node, nodeIndex) => {
		assertObject(node, `Diagram node ${nodeIndex}`);
		assertString(node.id, "Diagram node id");
		assertString(node.label, "Diagram node label");
		if (nodeIds.has(node.id)) fail(`Duplicate diagram node id: ${node.id}`);
		nodeIds.add(node.id);
		assertNumber(node.x, "Diagram node x", 0, 100);
		assertNumber(node.y, "Diagram node y", 0, 100);
		return { ...node };
	});
	const edges = (element.edges ?? []).map((edge, edgeIndex) => {
		assertObject(edge, `Diagram edge ${edgeIndex}`);
		assertString(edge.from, "Diagram edge from");
		assertString(edge.to, "Diagram edge to");
		if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to))
			fail(`Diagram edge ${edge.from}->${edge.to} points to an unknown node.`);
		return { ...edge };
	});
	for (const [key, minimum, maximum] of [
		["x", 0, 100],
		["y", 0, 100],
		["width", 0.1, 100],
		["height", 0.1, 100],
	]) {
		if (element[key] !== undefined) assertNumber(element[key], `Diagram ${key}`, minimum, maximum);
	}
	return { ...element, type: "diagram", nodes, edges };
}

function validateVideo(element, sceneIndex, elementIndex, options) {
	const src = validateAsset(
		element.src,
		`Scene ${sceneIndex} element ${elementIndex} video src`,
		options,
	);
	if (element.startFrom !== undefined) assertInteger(element.startFrom, "Video startFrom");
	if (element.endAt !== undefined) {
		assertInteger(element.endAt, "Video endAt", 1);
		if (element.endAt <= (element.startFrom ?? 0))
			fail("Video endAt must be greater than startFrom.");
	}
	if (element.fit !== undefined && !["contain", "cover"].includes(element.fit))
		fail("Video fit must be contain or cover.");
	if (element.opacity !== undefined) assertNumber(element.opacity, "Video opacity", 0, 1);
	if (element.volume !== undefined) assertNumber(element.volume, "Video volume", 0, 1);
	if (element.muted !== undefined && typeof element.muted !== "boolean")
		fail("Video muted must be boolean.");
	return {
		...element,
		type: "video",
		src,
		volume: element.volume ?? 1,
		muted: element.muted ?? false,
	};
}

function validateElement(element, sceneIndex, elementIndex, options) {
	assertObject(element, `Scene ${sceneIndex} element ${elementIndex}`);
	if (element.type === "title") return validateTitle(element, sceneIndex, elementIndex);
	if (element.type === "diagram") return validateDiagram(element, sceneIndex, elementIndex);
	if (element.type === "video") return validateVideo(element, sceneIndex, elementIndex, options);
	fail(`Scene ${sceneIndex} element ${elementIndex} has unsupported type: ${element.type}`);
}

function validateAudio(audio, sceneIndex, audioIndex, sceneDurationInFrames, options) {
	assertObject(audio, `Scene ${sceneIndex} audio ${audioIndex}`);
	const src = validateAsset(audio.src, `Scene ${sceneIndex} audio ${audioIndex} src`, options);
	assertInteger(audio.startFrame, `Scene ${sceneIndex} audio ${audioIndex} startFrame`);
	assertInteger(
		audio.durationInFrames,
		`Scene ${sceneIndex} audio ${audioIndex} durationInFrames`,
		1,
	);
	if (audio.trimBefore !== undefined) assertInteger(audio.trimBefore, "Audio trimBefore");
	if (audio.volume !== undefined) assertNumber(audio.volume, "Audio volume", 0, 1);
	if (audio.startFrame + audio.durationInFrames > sceneDurationInFrames)
		fail(
			`Scene ${sceneIndex} audio ${audioIndex} exceeds scene duration (${audio.startFrame}+${audio.durationInFrames}>${sceneDurationInFrames}).`,
		);
	return { ...audio, src, volume: audio.volume ?? 1, trimBefore: audio.trimBefore ?? 0 };
}

export function normalizeManifest(input, options = {}) {
	assertObject(input, "Remotion manifest");
	const baseDir = options.baseDir ?? process.cwd();
	const allowRemoteAssets = input.allowRemoteAssets === true;
	const checkAssets = options.checkAssets !== false;
	if (input.schemaVersion !== REMOTION_SCHEMA_VERSION)
		fail(`schemaVersion must be ${REMOTION_SCHEMA_VERSION}.`);
	if (!MODES.includes(input.mode)) fail(`mode must be one of: ${MODES.join(", ")}.`);
	assertInteger(input.fps, "fps", 1);
	if (input.fps > 120) fail("fps must be <= 120.");
	assertInteger(input.width, "width", 16);
	assertInteger(input.height, "height", 16);
	if (!Array.isArray(input.scenes) || input.scenes.length === 0)
		fail("scenes must contain at least one scene.");
	const ids = new Set();
	const scenes = input.scenes.map((scene, sceneIndex) => {
		assertObject(scene, `Scene ${sceneIndex}`);
		assertString(scene.id, `Scene ${sceneIndex} id`);
		if (!/^[A-Za-z0-9_-]+$/u.test(scene.id))
			fail(`Scene ${sceneIndex} id contains unsupported characters.`);
		if (ids.has(scene.id)) fail(`Duplicate scene id: ${scene.id}`);
		ids.add(scene.id);
		assertInteger(scene.durationInFrames, `Scene ${sceneIndex} durationInFrames`, 1);
		validateBackground(scene.background, `Scene ${sceneIndex} background`);
		if (!Array.isArray(scene.elements)) fail(`Scene ${sceneIndex} elements must be an array.`);
		const sceneOptions = { baseDir, allowRemoteAssets, checkAssets };
		const elements = scene.elements.map((element, elementIndex) =>
			validateElement(element, sceneIndex, elementIndex, sceneOptions),
		);
		const audio = (scene.audio ?? []).map((clip, audioIndex) =>
			validateAudio(clip, sceneIndex, audioIndex, scene.durationInFrames, sceneOptions),
		);
		const transition = validateTransition(scene.transition, sceneIndex, input.scenes.length);
		return {
			...scene,
			elements,
			audio,
			transition,
		};
	});
	for (let index = 0; index < scenes.length - 1; index += 1) {
		const transition = scenes[index].transition;
		if (transition.durationInFrames > scenes[index].durationInFrames)
			fail(`Scene ${index} transition is longer than its scene.`);
		if (transition.durationInFrames > scenes[index + 1].durationInFrames)
			fail(`Scene ${index} transition is longer than the following scene.`);
	}
	const sceneStarts = [];
	const audioTimeline = [];
	let cursor = 0;
	for (const scene of scenes) {
		sceneStarts.push(cursor);
		for (const clip of scene.audio) {
			audioTimeline.push({
				...clip,
				sceneId: scene.id,
				startFrame: cursor + clip.startFrame,
			});
		}
		cursor += scene.durationInFrames - scene.transition.durationInFrames;
	}
	return {
		...input,
		schemaVersion: REMOTION_SCHEMA_VERSION,
		allowRemoteAssets,
		baseDir,
		scenes,
		sceneStarts,
		audioTimeline,
		durationInFrames: cursor,
	};
}

export function createStarterManifest({
	mode = "animation",
	fps = DEFAULT_FPS,
	width = DEFAULT_WIDTH,
	height = DEFAULT_HEIGHT,
} = {}) {
	if (!MODES.includes(mode)) fail(`mode must be one of: ${MODES.join(", ")}.`);
	return {
		schemaVersion: REMOTION_SCHEMA_VERSION,
		mode,
		fps,
		width,
		height,
		allowRemoteAssets: false,
		scenes: [
			{
				id: "opening",
				durationInFrames: fps * 3,
				background: "#0b1020",
				elements: [
					{
						type: "title",
						text: "MEGA RECORDER",
						subtitle: "Edit this manifest or src/composition.jsx",
						x: 50,
						y: 44,
						align: "center",
					},
				],
				transition: { type: "fade", durationInFrames: Math.min(12, Math.floor(fps / 2)) },
			},
			{
				id: "diagram",
				durationInFrames: fps * 3,
				background: "#101a33",
				elements: [
					{
						type: "diagram",
						title: "A local, frame-addressed timeline",
						nodes: [
							{ id: "capture", label: "Capture", x: 18, y: 50, color: "#59d5ff" },
							{ id: "edit", label: "Edit", x: 50, y: 50, color: "#a78bfa" },
							{ id: "export", label: "Export", x: 82, y: 50, color: "#34d399" },
						],
						edges: [
							{ from: "capture", to: "edit" },
							{ from: "edit", to: "export" },
						],
					},
				],
				transition: { type: "none", durationInFrames: 0 },
			},
		],
	};
}
