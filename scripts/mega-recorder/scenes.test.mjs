import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../mega-recorder-cli.mjs";
import {
	addSceneToManifest,
	applyScenesToDocument,
	normalizeSceneManifest,
	reviseSceneInManifest,
	startSceneManifest,
} from "./scenes.mjs";

function documentFixture() {
	return {
		schemaVersion: 7,
		project: { id: "project-scenes", title: "Scenes", primaryAssetId: "asset-1" },
		assets: [{ id: "asset-1", originalPath: "/tmp/capture.mp4", durationSec: 30 }],
		timeline: {
			clips: [
				{
					id: "clip-1",
					assetId: "asset-1",
					sourceStartSec: 0,
					sourceEndSec: 30,
					timelineStartSec: 0,
					timelineEndSec: 30,
				},
			],
		},
		actions: [{ id: "save", timestampSec: 3, label: "Save", point: { x: 0.5, y: 0.5 } }],
		scenes: [],
	};
}

describe("named scene revisions", () => {
	it("uses a deterministic id, maps actions/text, and increments revision without changing id", () => {
		let manifest = startSceneManifest({ projectId: "project-scenes", assetId: "asset-1" });
		manifest = addSceneToManifest(manifest, {
			name: "Save settings",
			startSec: 1,
			endSec: 5,
			text: "Save the settings",
			audioTrackIds: ["narration-save"],
			overlayIds: ["overlay-save"],
		});
		const sceneId = manifest.scenes[0].id;
		const applied = applyScenesToDocument(documentFixture(), manifest);
		expect(applied.document.scenes[0]).toMatchObject({
			id: sceneId,
			name: "Save settings",
			revision: 1,
			actionIds: ["save"],
			audioTrackIds: ["narration-save"],
			overlayIds: ["overlay-save"],
			textMappings: [{ actionId: "save", text: "Save" }],
		});
		expect(applied.document.actions[0].sceneId).toBe(sceneId);

		const revised = reviseSceneInManifest(manifest, sceneId, {
			startSec: 2,
			endSec: 7,
			text: "Save the updated settings",
		});
		const reapplied = applyScenesToDocument(applied.document, revised);
		expect(reapplied.document.scenes[0]).toMatchObject({
			id: sceneId,
			startSec: 2,
			endSec: 7,
			revision: 2,
			text: "Save the updated settings",
		});
	});

	it("rejects duplicate scene ids and unknown revision targets", () => {
		const manifest = normalizeSceneManifest({
			scenes: [{ id: "settings", name: "Settings", startSec: 0, endSec: 1 }],
		});
		expect(() =>
			addSceneToManifest(manifest, { id: "settings", name: "Again", startSec: 2, endSec: 3 }),
		).toThrow("Duplicate scene id");
		expect(() => reviseSceneInManifest(manifest, "missing", { text: "Nope" })).toThrow(
			"Scene not found",
		);
	});

	it("keeps existing scenes when applying a partial manifest", () => {
		const existing = normalizeSceneManifest({
			scenes: [{ id: "existing", name: "Existing", startSec: 8, endSec: 10, text: "Keep me" }],
		});
		const document = { ...documentFixture(), scenes: existing.scenes };
		const applied = applyScenesToDocument(
			document,
			normalizeSceneManifest({
				scenes: [{ id: "new-scene", name: "New scene", startSec: 1, endSec: 3 }],
			}),
		);
		expect(applied.document.scenes.map((scene) => scene.id)).toEqual(["new-scene", "existing"]);
		expect(applied.changedSceneIds).toEqual(["new-scene"]);
	});

	it("persists scene ids and copy revisions through the CLI", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mega-recorder-scenes-cli-"));
		try {
			const projectPath = path.join(root, "capture.openscreen");
			const manifestPath = path.join(root, "capture.scenes.json");
			const appliedPath = path.join(root, "capture.with-scenes.openscreen");
			const revisedPath = path.join(root, "capture.revised.openscreen");
			await fs.writeFile(projectPath, JSON.stringify(documentFixture()));
			await runCommand(["scenes", "start", projectPath, "--output", manifestPath]);
			const added = await runCommand([
				"scenes",
				"add",
				manifestPath,
				"--name",
				"Save settings",
				"--start",
				"1",
				"--end",
				"5",
				"--text",
				"Save the settings",
			]);
			expect(added.scene.id).toBe("scene-save-settings");
			const applied = await runCommand([
				"scenes",
				"apply",
				projectPath,
				"--manifest",
				manifestPath,
				"--output",
				appliedPath,
			]);
			expect(applied).toMatchObject({ ok: true, sceneCount: 1, narrationChanged: false });
			const saved = JSON.parse(await fs.readFile(appliedPath, "utf8"));
			expect(saved.scenes[0]).toMatchObject({
				id: "scene-save-settings",
				revision: 1,
				text: "Save the settings",
			});

			const revised = await runCommand([
				"scenes",
				"revise",
				appliedPath,
				"--scene-id",
				"scene-save-settings",
				"--text",
				"Save the updated settings",
				"--output",
				revisedPath,
			]);
			expect(revised).toMatchObject({
				ok: true,
				narrationChanged: false,
				requiresNarrationSynthesis: true,
			});
			const revisedDocument = JSON.parse(await fs.readFile(revisedPath, "utf8"));
			expect(revisedDocument.scenes[0]).toMatchObject({
				id: "scene-save-settings",
				revision: 2,
				text: "Save the updated settings",
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
