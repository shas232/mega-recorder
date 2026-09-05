import fs from "node:fs/promises";
import path from "node:path";
import { normalizeAction } from "./actions.mjs";

export const SCENE_MANIFEST_SCHEMA_VERSION = 1;

function finite(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function nonNegative(value, label) {
	const number = Number(value);
	if (!finite(number) || number < 0) throw new Error(`${label} must be a non-negative number`);
	return number;
}

function optionalString(value, label, max = 160) {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || value.trim().length > max)
		throw new Error(`${label} must be a string of at most ${max} characters`);
	return value.trim();
}

function stableSceneId(value, index = 0) {
	if (value !== undefined && value !== null && value !== "") {
		if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value))
			throw new Error(
				"scene id must contain only letters, numbers, '_' or '-' and be at most 80 characters",
			);
		return value;
	}
	return `scene_${String(index + 1).padStart(4, "0")}`;
}

function slugSceneId(name, index = 0) {
	const slug = String(name ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return stableSceneId(slug ? `scene-${slug}` : undefined, index);
}

function normalizeTextMappings(value) {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) throw new Error("scene textMappings must be an array");
	const seen = new Set();
	const mappings = value.map((raw) => {
		if (!raw || typeof raw !== "object") throw new Error("scene text mapping must be an object");
		const actionId = optionalString(raw.actionId, "text mapping actionId", 80);
		const text = optionalString(raw.text, "text mapping text", 1000);
		if (!actionId || !text) throw new Error("scene text mapping needs actionId and text");
		if (seen.has(actionId)) throw new Error(`Duplicate scene text mapping actionId: ${actionId}`);
		seen.add(actionId);
		return { actionId, text };
	});
	return mappings;
}

function normalizeIdList(value, label) {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id.trim()))
		throw new Error(`${label} must be an array of non-empty strings`);
	return [...new Set(value.map((id) => id.trim()))];
}

/** A scene keeps one stable id while its timing and copy are revised. */
export function normalizeScene(value, index = 0, { requireName = true } = {}) {
	if (!value || typeof value !== "object") throw new Error("Each scene must be an object");
	const raw = value;
	const name = optionalString(raw.name ?? raw.title, "scene name", 160);
	if (requireName && !name) throw new Error("scene name is required");
	const timing = raw.timing && typeof raw.timing === "object" ? raw.timing : raw;
	const startSec = nonNegative(timing.startSec ?? timing.start, "scene startSec");
	const endSec = nonNegative(timing.endSec ?? timing.end, "scene endSec");
	if (!(endSec > startSec)) throw new Error("scene endSec must be greater than startSec");
	// A named scene without an explicit id gets a name-derived id.  Position-based
	// ids are only the last-resort fallback: inserting a scene before it must not
	// silently retarget a later revision.
	const id =
		raw.id === undefined || raw.id === null || raw.id === ""
			? slugSceneId(name, index)
			: stableSceneId(raw.id, index);
	const text = optionalString(raw.text ?? raw.copy ?? raw.script, "scene text", 2000) ?? "";
	const revisionValue = raw.revision === undefined ? 1 : Number(raw.revision);
	if (!Number.isInteger(revisionValue) || revisionValue < 1)
		throw new Error("scene revision must be a positive integer");
	const uniqueActionIds = normalizeIdList(raw.actionIds, "scene actionIds");
	const audioTrackIds = normalizeIdList(raw.audioTrackIds, "scene audioTrackIds");
	const overlayIds = normalizeIdList(raw.overlayIds, "scene overlayIds");
	const textMappings = normalizeTextMappings(raw.textMappings);
	return {
		id,
		name: name ?? id,
		startSec,
		endSec,
		text,
		revision: revisionValue,
		actionIds: uniqueActionIds,
		audioTrackIds,
		overlayIds,
		...(textMappings ? { textMappings } : {}),
	};
}

function sceneChanged(a, b) {
	return (
		a.name !== b.name ||
		a.startSec !== b.startSec ||
		a.endSec !== b.endSec ||
		a.text !== b.text ||
		JSON.stringify(a.actionIds) !== JSON.stringify(b.actionIds) ||
		JSON.stringify(a.audioTrackIds) !== JSON.stringify(b.audioTrackIds) ||
		JSON.stringify(a.overlayIds) !== JSON.stringify(b.overlayIds) ||
		JSON.stringify(a.textMappings ?? []) !== JSON.stringify(b.textMappings ?? [])
	);
}

export function normalizeSceneManifest(value, context = {}) {
	if (!value || typeof value !== "object") throw new Error("Scene manifest must be an object");
	if (value.schemaVersion !== undefined && value.schemaVersion !== SCENE_MANIFEST_SCHEMA_VERSION)
		throw new Error(`Unsupported scene manifest schema version: ${value.schemaVersion}`);
	const projectId = value.projectId ?? context.projectId;
	const assetId = value.assetId ?? context.assetId;
	const recordingClockPath = value.recordingClockPath ?? context.recordingClockPath;
	for (const [label, item] of [
		["projectId", projectId],
		["assetId", assetId],
		["recordingClockPath", recordingClockPath],
	]) {
		if (item !== undefined && item !== null && typeof item !== "string")
			throw new Error(`${label} must be a string`);
	}
	const input = Array.isArray(value.scenes) ? value.scenes : [];
	const seen = new Set();
	const scenes = input.map((scene, index) => {
		const normalized = normalizeScene(scene, index);
		if (seen.has(normalized.id)) throw new Error(`Duplicate scene id: ${normalized.id}`);
		seen.add(normalized.id);
		return normalized;
	});
	scenes.sort((a, b) => a.startSec - b.startSec || a.id.localeCompare(b.id));
	return {
		schemaVersion: SCENE_MANIFEST_SCHEMA_VERSION,
		...(projectId ? { projectId } : {}),
		...(assetId ? { assetId } : {}),
		...(recordingClockPath ? { recordingClockPath } : {}),
		scenes,
	};
}

export function startSceneManifest(context = {}) {
	return normalizeSceneManifest({
		schemaVersion: SCENE_MANIFEST_SCHEMA_VERSION,
		projectId: context.projectId,
		assetId: context.assetId,
		recordingClockPath: context.recordingClockPath,
		scenes: [],
	});
}

export function addSceneToManifest(manifest, scene) {
	const current = normalizeSceneManifest(manifest);
	const next = normalizeScene(scene, current.scenes.length);
	if (current.scenes.some((item) => item.id === next.id))
		throw new Error(`Duplicate scene id: ${next.id}`);
	return normalizeSceneManifest({ ...current, scenes: [...current.scenes, next] });
}

export function reviseSceneInManifest(manifest, sceneId, patch) {
	const current = normalizeSceneManifest(manifest);
	if (typeof sceneId !== "string" || !sceneId.trim()) throw new Error("scene id is required");
	const index = current.scenes.findIndex((scene) => scene.id === sceneId);
	if (index < 0) throw new Error(`Scene not found: ${sceneId}`);
	const existing = current.scenes[index];
	const candidate = normalizeScene(
		{ ...existing, ...patch, id: existing.id, revision: existing.revision },
		index,
	);
	const revised = sceneChanged(existing, candidate)
		? { ...candidate, revision: existing.revision + 1 }
		: existing;
	return normalizeSceneManifest({
		...current,
		scenes: current.scenes.map((item, i) => (i === index ? revised : item)),
	});
}

/** Merge named scenes into a project without changing media bytes. */
export function applyScenesToDocument(document, manifest) {
	const normalized = normalizeSceneManifest(manifest, {
		projectId: document?.project?.id,
		assetId: document?.project?.primaryAssetId ?? document?.assets?.[0]?.id,
	});
	if (normalized.projectId && document?.project?.id && normalized.projectId !== document.project.id)
		throw new Error("Scene manifest belongs to a different project.");
	const existing = Array.isArray(document.scenes) ? document.scenes : [];
	const existingById = new Map();
	for (const scene of existing) {
		const normalizedScene = normalizeScene(scene);
		existingById.set(normalizedScene.id, normalizedScene);
	}
	const actions = Array.isArray(document.actions) ? document.actions : [];
	const normalizedActions = actions.map((raw, index) => normalizeAction(raw, index));
	const appliedScenes = normalized.scenes.map((scene) => {
		const previous = existingById.get(scene.id);
		const assignedActionIds = scene.actionIds.length
			? scene.actionIds
			: normalizedActions
					.filter(
						(action) =>
							action.timestampSec >= scene.startSec && action.timestampSec <= scene.endSec,
					)
					.map((action) => action.id);
		const previousText = new Map(
			(previous?.textMappings ?? []).map((item) => [item.actionId, item.text]),
		);
		const textMappings = assignedActionIds.flatMap((actionId) => {
			const text =
				previousText.get(actionId) ??
				normalizedActions.find((action) => action.id === actionId)?.label ??
				scene.text;
			return text ? [{ actionId, text }] : [];
		});
		const candidate = {
			...scene,
			actionIds: assignedActionIds,
			...(textMappings.length ? { textMappings } : {}),
		};
		if (!previous) return candidate;
		return sceneChanged(previous, candidate)
			? { ...candidate, revision: previous.revision + 1 }
			: previous;
	});
	// A manifest can be a partial revision set. Keep scenes already persisted on
	// the project when they are not mentioned, so revising one scene cannot erase
	// unrelated scene mappings created by another take or editor save.
	const appliedSceneIds = new Set(appliedScenes.map((scene) => scene.id));
	const scenes = [
		...appliedScenes,
		...existingById.values().filter((scene) => !appliedSceneIds.has(scene.id)),
	].sort((a, b) => a.startSec - b.startSec || a.id.localeCompare(b.id));
	const sceneIds = new Set(scenes.map((scene) => scene.id));
	const actionsWithScene = normalizedActions.map((action) => {
		if (action.sceneId && sceneIds.has(action.sceneId)) return action;
		const scene = scenes.find((item) => item.actionIds.includes(action.id));
		return scene ? { ...action, sceneId: scene.id } : action;
	});
	return {
		document: {
			...document,
			project: { ...document.project, updatedAt: new Date().toISOString() },
			scenes,
			actions: actionsWithScene,
		},
		scenes,
		changedSceneIds: scenes
			.filter(
				(scene) => !existingById.has(scene.id) || sceneChanged(existingById.get(scene.id), scene),
			)
			.map((scene) => scene.id),
	};
}

export async function readSceneManifest(filePath) {
	return normalizeSceneManifest(JSON.parse(await fs.readFile(filePath, "utf8")));
}

export async function writeSceneManifest(filePath, manifest) {
	const normalized = normalizeSceneManifest(manifest);
	const absolute = path.resolve(filePath);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	const temporary = `${absolute}.${process.pid}.tmp`;
	try {
		await fs.writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await fs.rename(temporary, absolute);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
	return normalized;
}
