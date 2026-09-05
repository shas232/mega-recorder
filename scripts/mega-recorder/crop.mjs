export const IDENTITY_CROP = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

export function isIdentityCrop(region) {
	return Boolean(
		!region || (region.x === 0 && region.y === 0 && region.width === 1 && region.height === 1),
	);
}

/** Tolerant normalizer for legacy document values. CLI input uses parseCropRegion below. */
export function normalizeCropRegion(value) {
	if (!value || typeof value !== "object") return IDENTITY_CROP;
	const candidate = value;
	const x = Number(candidate.x);
	const y = Number(candidate.y);
	const width = Number(candidate.width);
	const height = Number(candidate.height);
	if (![x, y, width, height].every(Number.isFinite)) return IDENTITY_CROP;
	if (x < 0 || y < 0 || width <= 0 || height <= 0 || x > 1 || y > 1) return IDENTITY_CROP;
	if (x + width > 1 || y + height > 1) return IDENTITY_CROP;
	return { x, y, width, height };
}

function argumentError(message) {
	return Object.assign(new Error(message), { code: "CLI_ARGUMENT_ERROR" });
}

function numericPart(value, label) {
	const number = Number(value);
	if (String(value).trim() === "" || !Number.isFinite(number)) {
		throw argumentError(`${label} must contain finite numbers`);
	}
	return number;
}

function validateRegion(region, label) {
	if (
		region.x < 0 ||
		region.y < 0 ||
		region.width <= 0 ||
		region.height <= 0 ||
		region.x + region.width > 1 ||
		region.y + region.height > 1
	) {
		throw argumentError(`${label} must stay inside the source frame (0..1)`);
	}
	return region;
}

/** Parse x,y,width,height source-frame fractions used by the CLI. */
export function parseCropRegion(value, label = "--region") {
	if (typeof value !== "string") throw argumentError(`${label} requires x,y,width,height`);
	const parts = value.split(",");
	if (parts.length !== 4) throw argumentError(`${label} requires x,y,width,height`);
	return validateRegion(
		{
			x: numericPart(parts[0], label),
			y: numericPart(parts[1], label),
			width: numericPart(parts[2], label),
			height: numericPart(parts[3], label),
		},
		label,
	);
}

/** Convert removed edge fractions into the source rectangle that remains. */
export function cropRegionFromEdges(edges) {
	const top = edges.top ?? 0;
	const right = edges.right ?? 0;
	const bottom = edges.bottom ?? 0;
	const left = edges.left ?? 0;
	for (const [name, value] of Object.entries({ top, right, bottom, left })) {
		if (!Number.isFinite(value) || value < 0 || value >= 1) {
			throw argumentError(`--${name} must be a fraction from 0 up to (but not including) 1`);
		}
	}
	return validateRegion(
		{
			x: left,
			y: top,
			width: 1 - left - right,
			height: 1 - top - bottom,
		},
		"Crop edges",
	);
}

function sameCrop(a, b) {
	return Boolean(
		a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height,
	);
}

/** Apply crop to every Axcut clip while leaving media and source-time data intact. */
export function applyCropToDocument(document, region, clipId = null) {
	const normalized = normalizeCropRegion(region);
	const cropRegion = isIdentityCrop(normalized) ? undefined : { ...normalized };
	let changed = false;
	const clips = document.timeline.clips.map((clip) => {
		if (clipId !== null && clip.id !== clipId) return clip;
		if (sameCrop(clip.cropRegion, cropRegion) || (!clip.cropRegion && !cropRegion)) return clip;
		changed = true;
		return cropRegion ? { ...clip, cropRegion } : { ...clip, cropRegion: undefined };
	});
	return changed
		? {
				...document,
				project: { ...document.project, updatedAt: new Date().toISOString() },
				timeline: { ...document.timeline, clips },
			}
		: document;
}
