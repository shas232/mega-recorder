import { describe, expect, it } from "vitest";
import { deleteRangeFromDocument, remapAudioTracksAfterTimelineDelete } from "./timeline.mjs";

function documentFixture() {
	return {
		schemaVersion: 7,
		project: { id: "proj_1", title: "Cut me", primaryAssetId: "asset_1" },
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "Capture",
				originalPath: "/tmp/capture.mp4",
				durationSec: 20,
			},
		],
		timeline: {
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 20,
					timelineStartSec: 0,
					timelineEndSec: 20,
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
			audioTracks: [
				{
					id: "audio_1",
					kind: "narration",
					label: "Kokoro intro",
					sourcePath: "/tmp/kokoro.wav",
					voice: "af_heart",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 2,
					timelineEndSec: 12,
					volume: 1,
					muted: false,
					status: "ready",
				},
			],
			audioMixMode: "mix",
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
	};
}

describe("MEGA RECORDER CLI timeline edits", () => {
	it("ripple-deletes a middle source span without touching media or mutating input", () => {
		const source = documentFixture();
		const result = deleteRangeFromDocument(source, 5, 8);
		expect(result.changed).toBe(true);
		expect(
			result.document.timeline.clips.map((clip) => [
				clip.sourceStartSec,
				clip.sourceEndSec,
				clip.timelineStartSec,
				clip.timelineEndSec,
			]),
		).toEqual([
			[0, 5, 0, 5],
			[8, 20, 5, 17],
		]);
		expect(source.timeline.clips).toHaveLength(1);
		expect(result.document.project.updatedAt).not.toBeUndefined();
		expect(result.document.timeline.audioTracks).toEqual([
			expect.objectContaining({
				id: "audio_1",
				sourceStartSec: 0,
				sourceEndSec: 3,
				timelineStartSec: 2,
				timelineEndSec: 5,
			}),
			expect.objectContaining({
				id: "audio_1_part2",
				sourceStartSec: 6,
				sourceEndSec: 10,
				timelineStartSec: 5,
				timelineEndSec: 9,
			}),
		]);
	});

	it("clamps the requested range to the media and treats an outside range as a no-op", () => {
		const source = documentFixture();
		expect(deleteRangeFromDocument(source, 21, 30).changed).toBe(false);
		const result = deleteRangeFromDocument(source, -5, 4);
		expect(result.changed).toBe(true);
		expect(result.document.timeline.clips[0].sourceStartSec).toBe(4);
	});

	it("removes an attached track when a ripple delete covers it", () => {
		const source = documentFixture();
		const result = deleteRangeFromDocument(source, 0, 20);
		expect(result.changed).toBe(true);
		expect(result.document.timeline.audioTracks).toEqual([]);
	});

	it("remaps audio fragments deterministically for multiple removal spans", () => {
		const source = documentFixture();
		const remapped = remapAudioTracksAfterTimelineDelete(source, [
			{ startSec: 3, endSec: 4 },
			{ startSec: 7, endSec: 9 },
		]);
		expect(
			remapped.map((track) => [
				track.sourceStartSec,
				track.sourceEndSec,
				track.timelineStartSec,
				track.timelineEndSec,
			]),
		).toEqual([
			[0, 1, 2, 3],
			[2, 5, 3, 6],
			[7, 10, 6, 9],
		]);
	});
});
