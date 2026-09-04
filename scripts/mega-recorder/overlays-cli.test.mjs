import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../mega-recorder-cli.mjs";

describe("MEGA RECORDER overlay CLI", () => {
	it("adds, lists, and removes a typed overlay while preserving the source project", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mega-recorder-overlay-cli-"));
		try {
			const projectPath = path.join(directory, "demo.openscreen");
			await fs.writeFile(
				projectPath,
				JSON.stringify({
					schemaVersion: 7,
					project: { id: "proj_overlay", title: "Overlay project" },
					assets: [],
					timeline: { clips: [] },
					overlays: [],
				}),
				"utf8",
			);
			const addedPath = path.join(directory, "with-overlay.openscreen");
			const added = await runCommand([
				"edit",
				"overlay",
				"add",
				projectPath,
				"--start",
				"1",
				"--end",
				"3.5",
				"--text",
				"Click Save",
				"--type",
				"callout",
				"--position",
				"86,52",
				"--size",
				"36,14",
				"--output",
				addedPath,
			]);
			expect(added).toMatchObject({ ok: true, overlay: { type: "callout", text: "Click Save" } });
			const listed = await runCommand(["edit", "overlay", "list", addedPath]);
			expect(listed).toMatchObject({ ok: true, overlayCount: 1, overlays: [{ type: "callout" }] });

			const removedPath = path.join(directory, "without-overlay.openscreen");
			const removed = await runCommand([
				"edit",
				"overlay",
				"remove",
				addedPath,
				"--id",
				added.overlay.id,
				"--output",
				removedPath,
			]);
			expect(removed).toMatchObject({
				ok: true,
				overlayCount: 0,
				removedOverlayId: added.overlay.id,
			});
			expect(JSON.parse(await fs.readFile(projectPath, "utf8")).overlays).toEqual([]);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
