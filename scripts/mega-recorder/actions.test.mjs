import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../mega-recorder-cli.mjs";
import {
	addActionToManifest,
	applyActionsToDocument,
	normalizeActionManifest,
	startActionManifest,
	writeActionManifest,
} from "./actions.mjs";
import { createRecordingClockReference, writeRecordingClock } from "./recording-clock.mjs";
import { deleteRangeFromDocument } from "./timeline.mjs";

function fixture() {
	return {
		schemaVersion: 7,
		project: { id: "proj_actions", title: "Actions", primaryAssetId: "asset_1" },
		assets: [{ id: "asset_1", originalPath: "/tmp/source.mp4", durationSec: 20 }],
		timeline: {
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 20,
					timelineStartSec: 0,
					timelineEndSec: 20,
				},
			],
		},
		annotations: [],
		zoomRanges: [],
		actions: [],
	};
}

describe("host-agent action manifests", () => {
	it("normalizes stable ids/order and supports point or rectangle targets", () => {
		let manifest = startActionManifest({ projectId: "p", assetId: "a" });
		manifest = addActionToManifest(manifest, {
			timestampSec: 4,
			label: "Open settings",
			targetRect: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 },
		});
		manifest = addActionToManifest(manifest, {
			timestampSec: 1,
			label: "Click",
			point: { x: 0.8, y: 0.7 },
			sceneId: "settings",
		});
		expect(manifest).toEqual({
			schemaVersion: 1,
			projectId: "p",
			assetId: "a",
			actions: [
				{
					id: "action_0002",
					timestampSec: 1,
					label: "Click",
					point: { x: 0.8, y: 0.7 },
					sceneId: "settings",
				},
				{
					id: "action_0001",
					timestampSec: 4,
					label: "Open settings",
					targetRect: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 },
				},
			],
		});
		expect(() =>
			normalizeActionManifest({ schemaVersion: 1, actions: [{ timestampSec: 1, label: "bad" }] }),
		).toThrow("action needs a point or targetRect");
	});

	it("applies idempotent clip-anchored framing and optional callouts", () => {
		const manifest = normalizeActionManifest({
			schemaVersion: 1,
			projectId: "proj_actions",
			assetId: "asset_1",
			actions: [
				{ id: "click-1", timestampSec: 5, label: "Click save", point: { x: 0.75, y: 0.25 } },
			],
		});
		const first = applyActionsToDocument(fixture(), manifest, { includeCallouts: true });
		const second = applyActionsToDocument(first.document, manifest, { includeCallouts: true });
		expect(first.generatedZoomCount).toBe(1);
		expect(first.generatedCalloutCount).toBe(1);
		expect(first.document.actions[0].timelineTimeSec).toBe(5);
		expect(first.document.zoomRanges[0]).toMatchObject({
			actionId: "click-1",
			clipId: "clip_1",
			startMs: 4400,
			endMs: 5900,
			focus: { cx: 0.75, cy: 0.25 },
		});
		expect(second.document.zoomRanges).toHaveLength(1);
		expect(second.document.annotations).toHaveLength(1);
	});

	it("remaps and drops action markers and generated framing through a ripple delete", () => {
		const applied = applyActionsToDocument(
			fixture(),
			normalizeActionManifest({
				actions: [
					{ id: "before", timestampSec: 2, label: "Before", point: { x: 0.1, y: 0.1 } },
					{ id: "inside", timestampSec: 6, label: "Inside", point: { x: 0.2, y: 0.2 } },
					{ id: "after", timestampSec: 12, label: "After", point: { x: 0.3, y: 0.3 } },
				],
			}),
			{ includeCallouts: true },
		);
		const deleted = deleteRangeFromDocument(applied.document, 5, 8);
		expect(
			deleted.document.actions.map((action) => [
				action.id,
				action.timestampSec,
				action.timelineTimeSec,
			]),
		).toEqual([
			["before", 2, 2],
			["after", 12, 9],
		]);
		expect(deleted.document.zoomRanges.map((region) => region.actionId)).toEqual([
			"before",
			"after",
		]);
		expect(deleted.document.annotations.map((region) => region.actionId)).toEqual([
			"before",
			"after",
		]);
	});

	it("persists a disposable manifest through the stable CLI JSON contract", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mega-recorder-actions-"));
		try {
			const manifestPath = path.join(root, "actions.json");
			const started = await runCommand(["actions", "start", "--output", manifestPath]);
			expect(started).toMatchObject({ ok: true, command: "actions start", actionCount: 0 });
			const added = await runCommand([
				"actions",
				"add",
				manifestPath,
				"--time",
				"2.5",
				"--label",
				"Open menu",
				"--rect",
				"0.2,0.3,0.4,0.2",
			]);
			expect(added).toMatchObject({ ok: true, command: "actions add", actionCount: 1 });
			const listed = await runCommand(["actions", "list", manifestPath]);
			expect(listed.actions[0]).toMatchObject({ timestampSec: 2.5, label: "Open menu" });
			const importedPath = path.join(root, "imported.actions.json");
			const imported = await runCommand([
				"actions",
				"import",
				manifestPath,
				"--output",
				importedPath,
			]);
			expect(imported).toMatchObject({ ok: true, command: "actions import", actionCount: 1 });
			expect(JSON.parse(await fs.readFile(importedPath, "utf8")).schemaVersion).toBe(1);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("derives auto action time from the recording start clock, not manifest/tool arrival order", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mega-recorder-actions-clock-"));
		try {
			const manifestPath = path.join(root, "actions.json");
			const clockPath = path.join(root, "capture.clock.json");
			await runCommand(["actions", "start", "--output", manifestPath, "--clock-file", clockPath]);
			await writeRecordingClock(
				clockPath,
				createRecordingClockReference({ epochMs: Date.now() - 2_000, monotonicMs: 1 }),
			);
			const added = await runCommand([
				"actions",
				"add",
				manifestPath,
				"--time",
				"auto",
				"--label",
				"Open menu",
				"--point",
				"0.2,0.3",
			]);
			expect(added).toMatchObject({
				ok: true,
				action: {
					timestampSource: "recording-clock",
					timestampAccuracy: "approximate",
				},
			});
			expect(added.action.timestampSec).toBeGreaterThanOrEqual(1.9);
			expect(added.action.timestampSec).toBeLessThan(3);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("snaps auto action time only to a spatially matching native click", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mega-recorder-actions-click-"));
		try {
			const manifestPath = path.join(root, "actions.json");
			const mediaPath = path.join(root, "capture.mp4");
			const clockPath = path.join(root, "capture.clock.json");
			await fs.writeFile(
				`${mediaPath}.cursor.json`,
				JSON.stringify({
					samples: [
						{ timeMs: 1_250, cx: 0.2, cy: 0.3, interactionType: "click" },
						{ timeMs: 2_000, cx: 0.2, cy: 0.3, interactionType: "click" },
					],
				}),
			);
			await writeRecordingClock(
				clockPath,
				createRecordingClockReference({ epochMs: Date.now() - 1_250, monotonicMs: 1 }),
			);
			await runCommand(["actions", "start", "--output", manifestPath, "--clock-file", clockPath]);
			const added = await runCommand([
				"actions",
				"add",
				manifestPath,
				"--time",
				"auto",
				"--recording",
				mediaPath,
				"--clock-file",
				clockPath,
				"--label",
				"Open menu",
				"--point",
				"0.2,0.3",
			]);
			expect(added.action).toMatchObject({
				timestampSec: 1.25,
				timestampSource: "cursor-telemetry",
				timestampAccuracy: "exact",
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects auto timing after the recording clock is closed", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mega-recorder-actions-stopped-"));
		try {
			const manifestPath = path.join(root, "actions.json");
			const clockPath = path.join(root, "capture.clock.json");
			await runCommand(["actions", "start", "--output", manifestPath, "--clock-file", clockPath]);
			await writeRecordingClock(clockPath, {
				...createRecordingClockReference({ epochMs: Date.now() - 1_000, monotonicMs: 1 }),
				status: "stopped",
				endedAtEpochMs: Date.now(),
				durationMs: 1_000,
			});
			const response = await runCommand([
				"actions",
				"add",
				manifestPath,
				"--time",
				"auto",
				"--label",
				"Too late",
				"--point",
				"0.2,0.3",
			]);
			expect(response).toMatchObject({ ok: false, error: { code: "ACTION_CLOCK_STOPPED" } });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("reconciles approximate actions to bounded native click telemetry after capture", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mega-recorder-actions-reconcile-"));
		try {
			const manifestPath = path.join(root, "actions.json");
			const outputPath = path.join(root, "reconciled.actions.json");
			const mediaPath = path.join(root, "capture.mp4");
			const startedAtEpochMs = Date.now() - 1_250;
			const clockPath = path.join(root, "capture.clock.json");
			await fs.writeFile(
				`${mediaPath}.cursor.json`,
				JSON.stringify({
					samples: [
						{ timeMs: 1_250, cx: 0.2, cy: 0.3, interactionType: "click" },
						{ timeMs: 2_000, cx: 0.2, cy: 0.3, interactionType: "click" },
					],
				}),
			);
			const clock = await writeRecordingClock(clockPath, {
				...createRecordingClockReference({ startedAtEpochMs, monotonicMs: 1 }),
				status: "stopped",
				endedAtEpochMs: Math.round(startedAtEpochMs) + 3_000,
				durationMs: 3_000,
			});
			await writeActionManifest(
				manifestPath,
				normalizeActionManifest({
					recordingClockPath: clockPath,
					actions: [
						{
							id: "save",
							timestampSec: 1.25,
							label: "Save",
							point: { x: 0.2, y: 0.3 },
							timestampSource: "recording-clock",
							timestampAccuracy: "approximate",
							observedAtEpochMs: clock.startedAtEpochMs + 1_250,
						},
					],
				}),
			);
			const response = await runCommand([
				"actions",
				"reconcile",
				manifestPath,
				"--recording",
				mediaPath,
				"--output",
				outputPath,
			]);
			expect(response).toMatchObject({ ok: true, reconciledCount: 1, unmatchedActionIds: [] });
			expect(JSON.parse(await fs.readFile(outputPath, "utf8")).actions[0]).toMatchObject({
				timestampSec: 1.25,
				timestampSource: "cursor-telemetry",
				timestampAccuracy: "exact",
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("reconciles from the persisted source timestamp when no recording clock is available", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "mega-recorder-actions-reconcile-no-clock-"),
		);
		try {
			const manifestPath = path.join(root, "actions.json");
			const outputPath = path.join(root, "reconciled.actions.json");
			const mediaPath = path.join(root, "capture.mp4");
			await fs.writeFile(
				`${mediaPath}.cursor.json`,
				JSON.stringify({
					samples: [{ timeMs: 1_500, cx: 0.2, cy: 0.3, interactionType: "click" }],
				}),
			);
			await writeActionManifest(
				manifestPath,
				normalizeActionManifest({
					actions: [
						{
							id: "open",
							timestampSec: 1.5,
							label: "Open",
							point: { x: 0.2, y: 0.3 },
							timestampSource: "recording-clock",
							timestampAccuracy: "approximate",
							observedAtEpochMs: Date.now(),
						},
					],
				}),
			);
			const response = await runCommand([
				"actions",
				"reconcile",
				manifestPath,
				"--recording",
				mediaPath,
				"--output",
				outputPath,
			]);
			expect(response).toMatchObject({ ok: true, reconciledCount: 1, unmatchedActionIds: [] });
			expect(JSON.parse(await fs.readFile(outputPath, "utf8")).actions[0]).toMatchObject({
				timestampSec: 1.5,
				timestampSource: "cursor-telemetry",
				timestampAccuracy: "exact",
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("applies to a disposable project without rewriting source media or cursor telemetry", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mega-recorder-actions-fixture-"));
		try {
			const mediaPath = path.join(root, "capture.mp4");
			const cursorPath = `${mediaPath}.cursor.json`;
			const projectPath = path.join(root, "capture.openscreen");
			const manifestPath = path.join(root, "capture.actions.json");
			const outputPath = path.join(root, "capture.framed.openscreen");
			await fs.writeFile(mediaPath, Buffer.from("disposable media fixture"));
			await fs.writeFile(cursorPath, Buffer.from('{"samples":[{"time":1,"x":0.2,"y":0.3}]}'));
			await fs.writeFile(
				projectPath,
				JSON.stringify({
					schemaVersion: 7,
					project: {
						id: "fixture_project",
						title: "Fixture",
						primaryAssetId: "fixture_asset",
						createdAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
					assets: [{ id: "fixture_asset", originalPath: mediaPath, durationSec: 5 }],
					timeline: {
						clips: [
							{
								id: "fixture_clip",
								assetId: "fixture_asset",
								sourceStartSec: 0,
								sourceEndSec: 5,
								timelineStartSec: 0,
								timelineEndSec: 5,
							},
						],
					},
					annotations: [],
					zoomRanges: [],
				}),
				"utf8",
			);
			await fs.writeFile(
				manifestPath,
				JSON.stringify({
					schemaVersion: 1,
					projectId: "fixture_project",
					assetId: "fixture_asset",
					actions: [
						{
							id: "fixture-click",
							timestampSec: 2,
							label: "Choose file",
							point: { x: 0.4, y: 0.6 },
						},
					],
				}),
				"utf8",
			);
			const mediaBefore = await fs.readFile(mediaPath);
			const cursorBefore = await fs.readFile(cursorPath);
			const result = await runCommand([
				"actions",
				"apply",
				projectPath,
				"--manifest",
				manifestPath,
				"--output",
				outputPath,
			]);
			expect(result).toMatchObject({
				ok: true,
				mediaTouched: false,
				cursorTelemetryPreserved: true,
				generatedZoomCount: 1,
			});
			expect(await fs.readFile(mediaPath)).toEqual(mediaBefore);
			expect(await fs.readFile(cursorPath)).toEqual(cursorBefore);
			expect(JSON.parse(await fs.readFile(outputPath, "utf8")).actions[0].timelineTimeSec).toBe(2);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
