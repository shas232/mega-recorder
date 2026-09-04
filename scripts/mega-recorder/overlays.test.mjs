import { describe, expect, it } from "vitest";
import {
	addOverlayToDocument,
	createOverlay,
	remapOverlaysAfterDelete,
	removeOverlayFromDocument,
} from "./overlays.mjs";

const overlay = (id, startSec, endSec, text = id) =>
	createOverlay({ id, startSec, endSec, text, type: id.includes("callout") ? "callout" : "label" });

describe("MEGA RECORDER overlays", () => {
	it("creates stable defaults and adds/removes overlays without touching other document data", () => {
		const source = { project: { id: "p1" }, overlays: [], custom: "keep" };
		const added = addOverlayToDocument(source, {
			id: "label1",
			startSec: 1,
			endSec: 3,
			text: "Click Save",
			type: "label",
		});
		expect(added.custom).toBe("keep");
		expect(added.overlays[0]).toMatchObject({
			id: "label1",
			startSec: 1,
			endSec: 3,
			text: "Click Save",
			space: "screen",
			anchor: "top-left",
		});
		expect(removeOverlayFromDocument(added, "label1").overlays).toEqual([]);
	});

	it("ripple-remaps, splits, and drops overlays at a deleted timeline span", () => {
		const source = [
			overlay("before", 0, 2),
			overlay("split", 2, 8),
			overlay("inside", 4, 5),
			overlay("after", 9, 11),
		];
		const next = remapOverlaysAfterDelete(source, 3, 6);
		expect(next.map(({ id, startSec, endSec }) => ({ id, startSec, endSec }))).toEqual([
			{ id: "before", startSec: 0, endSec: 2 },
			{ id: "split", startSec: 2, endSec: 3 },
			{ id: "split_part2", startSec: 3, endSec: 5 },
			{ id: "after", startSec: 6, endSec: 8 },
		]);
	});
});
