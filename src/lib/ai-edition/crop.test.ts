import { describe, expect, it } from "vitest";
import { applyCropToDocument, normalizeCropRegion } from "./crop";
import { type AxcutDocument, documentSchema } from "./schema";

function documentFixture(): AxcutDocument {
	return documentSchema.parse({
		schemaVersion: 7,
		project: {
			id: "proj_crop",
			title: "Crop",
			primaryAssetId: "asset_1",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "Capture",
				originalPath: "/tmp/capture.mp4",
				cameraTrack: null,
			},
		],
		transcript: null,
		transcripts: [],
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
			audioMixMode: "mix",
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
	});
}

describe("shared crop document transform", () => {
	it("normalizes malformed persisted data to the identity frame", () => {
		expect(normalizeCropRegion({ x: 2, y: 0, width: 1, height: 1 })).toEqual({
			x: 0,
			y: 0,
			width: 1,
			height: 1,
		});
		expect(normalizeCropRegion({ x: 0, y: 0, width: 0, height: 1 })).toEqual({
			x: 0,
			y: 0,
			width: 1,
			height: 1,
		});
	});

	it("keeps clip source and modifier coordinates unchanged while updating all clips", () => {
		const source = documentFixture();
		const next = applyCropToDocument(source, { x: 0, y: 0.08, width: 1, height: 0.92 });
		expect(next.timeline.clips.map((clip) => clip.cropRegion)).toEqual([
			{ x: 0, y: 0.08, width: 1, height: 0.92 },
			{ x: 0, y: 0.08, width: 1, height: 0.92 },
		]);
		expect(next.timeline.clips.map((clip) => [clip.sourceStartSec, clip.sourceEndSec])).toEqual([
			[0, 4],
			[8, 12],
		]);
		expect(source.timeline.clips.every((clip) => clip.cropRegion === undefined)).toBe(true);
	});
});
