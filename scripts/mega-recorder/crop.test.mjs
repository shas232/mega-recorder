import { describe, expect, it } from "vitest";
import { applyCropToDocument, cropRegionFromEdges, parseCropRegion } from "./crop.mjs";

function fixture() {
	return {
		schemaVersion: 7,
		project: { id: "proj_crop", title: "Crop", primaryAssetId: "asset_1" },
		assets: [{ id: "asset_1", kind: "video", label: "Capture", originalPath: "/tmp/capture.mp4" }],
		timeline: {
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 4,
					timelineStartSec: 0,
					timelineEndSec: 4,
					wordRefs: [],
					origin: "system",
					reason: "",
				},
				{
					id: "clip_2",
					assetId: "asset_1",
					sourceStartSec: 8,
					sourceEndSec: 12,
					timelineStartSec: 4,
					timelineEndSec: 8,
					wordRefs: [],
					origin: "system",
					reason: "",
				},
			],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
			audioTracks: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
	};
}

describe("MEGA RECORDER crop transform", () => {
	it("parses a kept source-frame region and rejects out-of-bounds input", () => {
		expect(parseCropRegion("0,0.08,1,0.92")).toEqual({ x: 0, y: 0.08, width: 1, height: 0.92 });
		expect(() => parseCropRegion("0,0.2,1,0.9")).toThrow(/inside the source frame/);
	});

	it("turns removed edge fractions into the same source crop", () => {
		expect(cropRegionFromEdges({ top: 0.08 })).toEqual({
			x: 0,
			y: 0.08,
			width: 1,
			height: 0.92,
		});
	});

	it("applies one crop to all clips without mutating source media or clip timing", () => {
		const source = fixture();
		const next = applyCropToDocument(source, parseCropRegion("0,0.08,1,0.92"));
		expect(next.timeline.clips.map((clip) => clip.cropRegion)).toEqual([
			{ x: 0, y: 0.08, width: 1, height: 0.92 },
			{ x: 0, y: 0.08, width: 1, height: 0.92 },
		]);
		expect(next.timeline.clips.map((clip) => [clip.sourceStartSec, clip.sourceEndSec])).toEqual([
			[0, 4],
			[8, 12],
		]);
		expect(source.timeline.clips.every((clip) => clip.cropRegion === undefined)).toBe(true);
		expect(source.assets[0].originalPath).toBe("/tmp/capture.mp4");
	});

	it("can target one clip and treats a full-frame crop as a no-op", () => {
		const source = fixture();
		const one = applyCropToDocument(source, { x: 0.1, y: 0, width: 0.9, height: 1 }, "clip_2");
		expect(one.timeline.clips[0].cropRegion).toBeUndefined();
		expect(one.timeline.clips[1].cropRegion).toEqual({ x: 0.1, y: 0, width: 0.9, height: 1 });
		expect(applyCropToDocument(source, { x: 0, y: 0, width: 1, height: 1 })).toBe(source);
	});
});
