import type { AxcutClipCropRegion, AxcutDocument } from "./schema";

/** The full source frame. An omitted clip crop has these same semantics. */
export const IDENTITY_CROP: AxcutClipCropRegion = {
	x: 0,
	y: 0,
	width: 1,
	height: 1,
};

function finiteOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Normalize an untrusted crop rectangle to source-frame fractions.
 *
 * Crop data is persisted in project documents and can come from old v2
 * sidecars, so malformed values must degrade to the identity crop rather than
 * making the whole project unloadable. Width and height are clipped to the
 * remaining frame after x/y, which keeps the native compositor and the CSS
 * preview in agreement about the rectangle's bounds.
 */
export function normalizeCropRegion(value: unknown): AxcutClipCropRegion {
	if (!value || typeof value !== "object") return IDENTITY_CROP;
	const candidate = value as Record<string, unknown>;
	const x = clamp(finiteOr(candidate.x, 0), 0, 1);
	const y = clamp(finiteOr(candidate.y, 0), 0, 1);
	const width = clamp(finiteOr(candidate.width, 1), 0, 1 - x);
	const height = clamp(finiteOr(candidate.height, 1), 0, 1 - y);
	if (width <= 0 || height <= 0) return IDENTITY_CROP;
	return { x, y, width, height };
}

export function isIdentityCrop(region: AxcutClipCropRegion | null | undefined): boolean {
	return (
		!region ||
		(region.x === IDENTITY_CROP.x &&
			region.y === IDENTITY_CROP.y &&
			region.width === IDENTITY_CROP.width &&
			region.height === IDENTITY_CROP.height)
	);
}

function sameCrop(a: AxcutClipCropRegion | undefined, b: AxcutClipCropRegion | undefined): boolean {
	if (isIdentityCrop(a) && isIdentityCrop(b)) return true;
	return Boolean(
		a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height,
	);
}

/**
 * Apply one source-frame crop to every video clip without touching media or
 * any source-relative modifier data. The returned document is the one passed
 * to the existing save/native renderer path; identity crops are omitted so
 * untouched documents stay backwards-compatible and compact.
 */
export function applyCropToDocument(
	document: AxcutDocument,
	value: AxcutClipCropRegion | null | undefined,
): AxcutDocument {
	const normalized = normalizeCropRegion(value);
	const cropRegion = isIdentityCrop(normalized) ? undefined : normalized;
	let changed = false;
	const clips = document.timeline.clips.map((clip) => {
		if (sameCrop(clip.cropRegion, cropRegion)) return clip;
		changed = true;
		return cropRegion ? { ...clip, cropRegion } : { ...clip, cropRegion: undefined };
	});
	if (!changed) return document;
	return {
		...document,
		project: { ...document.project, updatedAt: new Date().toISOString() },
		timeline: {
			...document.timeline,
			clips,
		},
	};
}
