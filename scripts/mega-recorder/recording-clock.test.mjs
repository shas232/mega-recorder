import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	createRecordingClockReference,
	normalizeRecordingClockReference,
	readRecordingClock,
	timestampFromRecordingClock,
	writeRecordingClock,
} from "./recording-clock.mjs";

describe("recording source clock", () => {
	it("keeps the confirmed start edge and derives cross-process source time", () => {
		const clock = createRecordingClockReference({
			epochMs: 1_700_000_000_123,
			monotonicMs: 456.75,
			source: "native-first-frame",
		});
		expect(clock).toMatchObject({
			ready: true,
			startedAtEpochMs: 1_700_000_000_123,
			startedAtMonotonicMs: 456.75,
			source: "native-first-frame",
		});
		expect(timestampFromRecordingClock(clock, { epochMs: 1_700_000_001_623 })).toBe(1.5);
		expect(normalizeRecordingClockReference(clock).startedAtIso).toBe("2023-11-14T22:13:20.123Z");
	});

	it("writes atomically and rejects an unready reference", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mega-recorder-clock-"));
		try {
			const clockPath = path.join(directory, "capture.clock.json");
			const clock = createRecordingClockReference({ epochMs: 1_000, monotonicMs: 2_000 });
			await writeRecordingClock(clockPath, clock);
			expect(await readRecordingClock(clockPath)).toMatchObject({
				ready: true,
				startedAtEpochMs: 1_000,
			});
			expect(() => normalizeRecordingClockReference({ ready: false, startedAtEpochMs: 1 })).toThrow(
				"not ready",
			);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
