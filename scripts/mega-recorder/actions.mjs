import fs from "node:fs/promises";
import path from "node:path";

/**
 * Versioned, host-agent authored action markers. Times are source-media seconds
 * (the only stable coordinate while a recording is being captured); applied
 * documents additionally carry a derived timelineTimeSec.
 */
export const ACTION_MANIFEST_SCHEMA_VERSION = 1;

function finite(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function bounded(value, label) {
	if (!finite(value) || value < 0 || value > 1) {
		throw new Error(`${label} must be a number between 0 and 1`);
	}
	return value;
}

function optionalString(value, label) {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || value.length > 160)
		throw new Error(`${label} must be a string of at most 160 characters`);
	return value;
}

function normalizePoint(value) {
	if (value === undefined || value === null) return undefined;
	if (!value || typeof value !== "object") throw new Error("point must be an object");
	return { x: bounded(value.x, "point.x"), y: bounded(value.y, "point.y") };
}

function normalizeRect(value) {
	if (value === undefined || value === null) return undefined;
	if (!value || typeof value !== "object") throw new Error("targetRect must be an object");
	const x = bounded(value.x, "targetRect.x");
	const y = bounded(value.y, "targetRect.y");
	const width = bounded(value.width, "targetRect.width");
	const height = bounded(value.height, "targetRect.height");
	if (width <= 0 || height <= 0 || x + width > 1 || y + height > 1)
		throw new Error("targetRect must be a positive rectangle inside the frame");
	return { x, y, width, height };
}

function actionId(value, index) {
	if (value === undefined || value === null || value === "")
		return `action_${String(index + 1).padStart(4, "0")}`;
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value))
		throw new Error("action id must contain only letters, numbers, '_' or '-'");
	return value;
}

export function normalizeAction(value, index = 0) {
	if (!value || typeof value !== "object") throw new Error("Each action must be an object");
	const raw = value;
	const timestampSec = Number(raw.timestampSec ?? raw.timeSec ?? raw.timestamp);
	if (!finite(timestampSec) || timestampSec < 0)
		throw new Error("action timestampSec must be a non-negative number");
	const label = typeof raw.label === "string" ? raw.label.trim() : "";
	if (!label || label.length > 160) throw new Error("action label must be 1–160 characters");
	const point = normalizePoint(raw.point ?? raw.cursor ?? raw.clickPoint);
	const targetRect = normalizeRect(raw.targetRect ?? raw.rect);
	if (!point && !targetRect) throw new Error("action needs a point or targetRect");
	const sceneId = optionalString(raw.sceneId, "sceneId");
	const timelineTimeSec =
		raw.timelineTimeSec === undefined ? undefined : Number(raw.timelineTimeSec);
	if (timelineTimeSec !== undefined && (!finite(timelineTimeSec) || timelineTimeSec < 0))
		throw new Error("timelineTimeSec must be a non-negative number");
	return {
		id: actionId(raw.id, index),
		timestampSec,
		label,
		...(point ? { point } : {}),
		...(targetRect ? { targetRect } : {}),
		...(sceneId ? { sceneId } : {}),
		...(timelineTimeSec !== undefined ? { timelineTimeSec } : {}),
	};
}

export function normalizeActionManifest(value, context = {}) {
	if (!value || typeof value !== "object") throw new Error("Action manifest must be an object");
	if (value.schemaVersion !== undefined && value.schemaVersion !== ACTION_MANIFEST_SCHEMA_VERSION)
		throw new Error(`Unsupported action manifest schema version: ${value.schemaVersion}`);
	const projectId = value.projectId ?? context.projectId;
	const assetId = value.assetId ?? context.assetId;
	if (projectId !== undefined && projectId !== null && typeof projectId !== "string")
		throw new Error("projectId must be a string");
	if (assetId !== undefined && assetId !== null && typeof assetId !== "string")
		throw new Error("assetId must be a string");
	const inputActions = Array.isArray(value.actions) ? value.actions : [];
	const actions = inputActions.map((action, index) => {
		const normalized = normalizeAction(action, index);
		const { timelineTimeSec: _timelineTimeSec, ...manifestAction } = normalized;
		return manifestAction;
	});
	const seen = new Set();
	for (const action of actions) {
		if (seen.has(action.id)) throw new Error(`Duplicate action id: ${action.id}`);
		seen.add(action.id);
	}
	actions.sort((a, b) => a.timestampSec - b.timestampSec || a.id.localeCompare(b.id));
	return {
		schemaVersion: ACTION_MANIFEST_SCHEMA_VERSION,
		...(projectId ? { projectId } : {}),
		...(assetId ? { assetId } : {}),
		actions,
	};
}

export function startActionManifest(context = {}) {
	return normalizeActionManifest({
		schemaVersion: ACTION_MANIFEST_SCHEMA_VERSION,
		projectId: context.projectId,
		assetId: context.assetId,
		actions: [],
	});
}

export function addActionToManifest(manifest, action) {
	const current = normalizeActionManifest(manifest);
	const nextActions = [...current.actions, normalizeAction(action, current.actions.length)];
	return normalizeActionManifest({ ...current, actions: nextActions });
}

export function stableJson(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

export async function readActionManifest(filePath) {
	return normalizeActionManifest(JSON.parse(await fs.readFile(filePath, "utf8")));
}

export async function writeActionManifest(filePath, manifest) {
	const next = normalizeActionManifest(manifest);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, stableJson(next), { encoding: "utf8", mode: 0o600 });
	return next;
}

function clipsForAsset(document, assetId) {
	return (document?.timeline?.clips ?? [])
		.filter((clip) => clip?.assetId === assetId && finite(clip.timelineStartSec))
		.sort((a, b) => a.timelineStartSec - b.timelineStartSec);
}

function clipAtSourceTime(clips, timestampSec) {
	return clips.find((clip) => {
		const end = finite(clip.sourceEndSec)
			? clip.sourceEndSec
			: clip.sourceStartSec + (clip.timelineEndSec - clip.timelineStartSec);
		return timestampSec >= clip.sourceStartSec && timestampSec <= end;
	});
}

function focusForAction(action) {
	if (action.targetRect) {
		return {
			cx: action.targetRect.x + action.targetRect.width / 2,
			cy: action.targetRect.y + action.targetRect.height / 2,
		};
	}
	return action.point ? { cx: action.point.x, cy: action.point.y } : { cx: 0.5, cy: 0.5 };
}

function anchoredWindow(action, clip) {
	const clipEnd = finite(clip.sourceEndSec)
		? clip.sourceEndSec
		: clip.sourceStartSec + (clip.timelineEndSec - clip.timelineStartSec);
	const sourceStartSec = Math.max(clip.sourceStartSec, action.timestampSec - 0.6);
	const sourceEndSec = Math.min(clipEnd, action.timestampSec + 0.9);
	if (!(sourceEndSec > sourceStartSec)) return null;
	return {
		clipId: clip.id,
		sourceStartSec,
		sourceEndSec,
		startMs: Math.round((clip.timelineStartSec + sourceStartSec - clip.sourceStartSec) * 1000),
		endMs: Math.round((clip.timelineStartSec + sourceEndSec - clip.sourceStartSec) * 1000),
	};
}

function calloutPosition(focus) {
	return {
		x: Math.min(78, Math.max(8, focus.cx * 100 - 14)),
		y: Math.min(78, Math.max(8, focus.cy * 100 - 8)),
	};
}

/**
 * Merge host actions into a project and derive deterministic, clip-anchored
 * zooms. Existing manual regions survive. Generated regions are keyed by
 * actionId, making repeated apply idempotent. Callouts are opt-in because the
 * action label is already useful to an agent without adding visible text.
 */
export function applyActionsToDocument(document, manifest, { includeCallouts = false } = {}) {
	const assetId =
		manifest.assetId ?? document?.project?.primaryAssetId ?? document?.assets?.[0]?.id;
	if (!assetId) throw new Error("Project has no primary video asset.");
	const normalized = normalizeActionManifest(manifest, {
		projectId: document?.project?.id,
		assetId,
	});
	if (normalized.projectId && document?.project?.id && normalized.projectId !== document.project.id)
		throw new Error("Action manifest belongs to a different project.");
	const clips = clipsForAsset(document, assetId);
	const existing = Array.isArray(document.actions) ? document.actions : [];
	const mergedById = new Map();
	for (const action of existing) mergedById.set(action.id, normalizeAction(action));
	for (const action of normalized.actions) mergedById.set(action.id, action);
	const actions = [...mergedById.values()]
		.sort((a, b) => a.timestampSec - b.timestampSec || a.id.localeCompare(b.id))
		.map((action) => {
			const clip = clipAtSourceTime(clips, action.timestampSec);
			if (!clip) return action;
			return {
				...action,
				timelineTimeSec: clip.timelineStartSec + action.timestampSec - clip.sourceStartSec,
			};
		});
	const generatedZooms = [];
	const generatedCallouts = [];
	for (const action of actions) {
		const clip = clipAtSourceTime(clips, action.timestampSec);
		const window = clip ? anchoredWindow(action, clip) : null;
		if (!window) continue;
		const focus = focusForAction(action);
		generatedZooms.push({
			id: `action-zoom-${action.id}`,
			actionId: action.id,
			...window,
			depth: 2,
			focus,
			focusMode: "manual",
			source: "auto",
		});
		if (includeCallouts) {
			generatedCallouts.push({
				id: `action-callout-${action.id}`,
				actionId: action.id,
				...window,
				type: "text",
				content: action.label,
				textContent: action.label,
				position: calloutPosition(focus),
				size: { width: 28, height: 10 },
				style: {
					color: "#ffffff",
					backgroundColor: "rgba(15, 23, 42, 0.82)",
					fontSize: 28,
					fontFamily: "Inter",
					fontWeight: "bold",
					fontStyle: "normal",
					textDecoration: "none",
					textAlign: "center",
					textAnimation: "fade",
				},
				zIndex: 1000,
				annotationSource: "action-callout",
			});
		}
	}
	const actionIds = new Set(actions.map((action) => action.id));
	const zoomRanges = [
		...(document.zoomRanges ?? []).filter(
			(region) => !region.actionId || !actionIds.has(region.actionId),
		),
		...generatedZooms,
	];
	const annotations = [
		...(document.annotations ?? []).filter(
			(region) => !region.actionId || !actionIds.has(region.actionId),
		),
		...(includeCallouts
			? generatedCallouts
			: (document.annotations ?? []).filter(
					(region) => region.annotationSource === "action-callout",
				)),
	];
	return {
		document: { ...document, actions, zoomRanges, annotations },
		actions,
		generatedZoomCount: generatedZooms.length,
		generatedCalloutCount: includeCallouts ? generatedCallouts.length : 0,
		unmappedActionIds: actions
			.filter((action) => action.timelineTimeSec === undefined)
			.map((action) => action.id),
	};
}

/** Recompute action marker ruler positions after a source-time ripple delete. */
export function remapActionsAfterDelete(actions, clips, startSec, endSec) {
	return (actions ?? []).flatMap((raw, index) => {
		const action = normalizeAction(raw, index);
		if (action.timestampSec >= startSec && action.timestampSec <= endSec) return [];
		const clip = clipAtSourceTime(clips, action.timestampSec);
		return [
			{
				...action,
				...(clip
					? { timelineTimeSec: clip.timelineStartSec + action.timestampSec - clip.sourceStartSec }
					: {}),
			},
		];
	});
}
