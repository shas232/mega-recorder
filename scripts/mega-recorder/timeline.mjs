import fs from "node:fs/promises";

function finite(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function intervalOverlap(a, b) {
	const start = Math.max(a.startSec, b.startSec);
	const end = Math.min(a.endSec, b.endSec);
	return end > start ? { startSec: start, endSec: end } : null;
}

function sourceDuration(document, assetId) {
	const asset = document.assets?.find((item) => item?.id === assetId);
	if (finite(asset?.durationSec) && asset.durationSec > 0) return asset.durationSec;
	return Math.max(
		0,
		...(document.timeline?.clips ?? [])
			.filter((clip) => clip.assetId === assetId)
			.map((clip) => (finite(clip.sourceEndSec) ? clip.sourceEndSec : 0)),
	);
}

function normalizeIntervals(intervals) {
	const sorted = intervals
		.filter((item) => finite(item.startSec) && finite(item.endSec) && item.endSec > item.startSec)
		.sort((a, b) => a.startSec - b.startSec);
	const merged = [];
	for (const interval of sorted) {
		const previous = merged.at(-1);
		if (!previous || interval.startSec > previous.endSec) merged.push({ ...interval });
		else previous.endSec = Math.max(previous.endSec, interval.endSec);
	}
	return merged;
}

function clipId(index) {
	return `clip_mega_${index + 1}`;
}

/**
 * Remove a source-time span from the active timeline and resequence the
 * surviving clips. This is the CLI counterpart of the editor's drop_range
 * operation; it changes only the selected project document and never touches
 * media bytes.
 */
export function deleteRangeFromDocument(document, startSec, endSec) {
	const assetId = document?.project?.primaryAssetId ?? document?.assets?.[0]?.id;
	if (!assetId) throw new Error("Project has no primary video asset.");
	const duration = sourceDuration(document, assetId);
	if (!(duration > 0)) throw new Error("Project video duration is unknown; probe the media first.");
	const lo = Math.max(0, Math.min(startSec, endSec));
	const hi = Math.min(duration, Math.max(startSec, endSec));
	if (!finite(lo) || !finite(hi) || hi <= lo)
		return { document, changed: false, keptIntervals: [] };
	const originalClips = (document.timeline?.clips ?? []).filter((clip) => clip.assetId === assetId);
	const existing = originalClips.length
		? originalClips.map((clip) => ({
				startSec: Math.max(0, clip.sourceStartSec),
				endSec: Math.min(duration, clip.sourceEndSec ?? duration),
			}))
		: [{ startSec: 0, endSec: duration }];
	const keptIntervals = normalizeIntervals(
		existing.flatMap((interval) => {
			const pieces = [];
			if (interval.startSec < lo) pieces.push({ startSec: interval.startSec, endSec: lo });
			if (hi < interval.endSec) pieces.push({ startSec: hi, endSec: interval.endSec });
			return pieces;
		}),
	);
	if (
		keptIntervals.length === existing.length &&
		keptIntervals.every(
			(item, i) => item.startSec === existing[i].startSec && item.endSec === existing[i].endSec,
		)
	) {
		return { document, changed: false, keptIntervals };
	}
	const first = originalClips[0];
	let timelineCursor = 0;
	const clips = keptIntervals.map((interval, index) => {
		const matching = originalClips.find(
			(clip) =>
				clip.sourceStartSec === interval.startSec &&
				(clip.sourceEndSec ?? duration) === interval.endSec,
		);
		const next = {
			...(matching ?? first ?? { origin: "user", reason: "" }),
			id: matching?.id ?? clipId(index),
			assetId,
			sourceStartSec: interval.startSec,
			sourceEndSec: interval.endSec,
			timelineStartSec: timelineCursor,
			timelineEndSec: timelineCursor + interval.endSec - interval.startSec,
			origin: "user",
			reason: `deleted ${lo}–${hi}s via mega-recorder CLI`,
		};
		timelineCursor = next.timelineEndSec;
		return next;
	});
	const survivingClipIds = new Set(clips.map((clip) => clip.id));
	const trimRanges = (document.timeline?.trimRanges ?? []).flatMap((trim) => {
		if (trim.assetId !== assetId) return [trim];
		const pieces = keptIntervals.map((interval) => intervalOverlap(interval, trim)).filter(Boolean);
		return pieces.map((piece, index) => ({
			...trim,
			id: index === 0 ? trim.id : `${trim.id}_part${index + 1}`,
			startSec: piece.startSec,
			endSec: piece.endSec,
			clipId: clips.find(
				(clip) => clip.sourceStartSec <= piece.startSec && clip.sourceEndSec >= piece.endSec,
			)?.id,
		}));
	});
	const next = {
		...document,
		project: { ...document.project, updatedAt: new Date().toISOString() },
		timeline: {
			...document.timeline,
			clips,
			trimRanges,
			gaps: [],
		},
		// Anchored annotations/zooms from the deleted clip are no longer addressable.
		// Unanchored legacy regions retain their raw ruler spans for the renderer's
		// existing back-compat handling.
		annotations: (document.annotations ?? []).filter(
			(region) => !region.clipId || survivingClipIds.has(region.clipId),
		),
		zoomRanges: (document.zoomRanges ?? []).filter(
			(region) => !region.clipId || survivingClipIds.has(region.clipId),
		),
	};
	return { document: next, changed: true, keptIntervals };
}

export async function writeDocumentAtomically(filePath, document) {
	const temporary = `${filePath}.${process.pid}.mega.tmp`;
	try {
		await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await fs.rename(temporary, filePath);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}
