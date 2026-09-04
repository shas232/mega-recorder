import { describe, expect, it } from "vitest";
import { validateTimelineAudioTrackRanges } from "./voiceoverMix";

describe("attached timeline audio export validation", () => {
	it("accepts bounded source and timeline ranges", () => {
		expect(() =>
			validateTimelineAudioTrackRanges(
				[
					{
						label: "Kokoro intro",
						sourceStartSec: 0,
						sourceEndSec: 2,
						timelineStartSec: 4,
						timelineEndSec: 6,
					},
				],
				10,
			),
		).not.toThrow();
	});

	it("reports an explicit error when audio outlives the video", () => {
		expect(() =>
			validateTimelineAudioTrackRanges(
				[
					{
						label: "Narration",
						sourceStartSec: 0,
						sourceEndSec: 4,
						timelineStartSec: 8,
						timelineEndSec: 12,
					},
				],
				10,
			),
		).toThrow(
			'Audio duration sync error "Narration": track ends at 12.000s, but video ends at 10.000s',
		);
	});

	it("rejects reversed source ranges before decoding", () => {
		expect(() =>
			validateTimelineAudioTrackRanges(
				[
					{
						label: "Bad track",
						sourceStartSec: 3,
						sourceEndSec: 2,
						timelineStartSec: 0,
						timelineEndSec: 1,
					},
				],
				10,
			),
		).toThrow('Audio duration sync error "Bad track": invalid source range');
	});
});
