import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeManifest } from "../../integrations/remotion/src/schema.mjs";
import { render, validate } from "./remotion.mjs";
import { playerEntrySource } from "./remotion-preview.mjs";

function titleScene(id, durationInFrames = 30, transition = { type: "none", durationInFrames: 0 }) {
	return {
		id,
		durationInFrames,
		elements: [{ type: "title", text: id }],
		transition,
	};
}

function manifest(scenes = [titleScene("opening")], overrides = {}) {
	return {
		schemaVersion: 1,
		mode: "animation",
		fps: 30,
		width: 1280,
		height: 720,
		scenes,
		...overrides,
	};
}

async function withTempDirectory(callback) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mega-recorder-remotion-validation-"));
	try {
		return await callback(directory);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

describe("Remotion manifest validation", () => {
	it("does not import a scaffold registerRoot entrypoint for preview", async () => {
		await withTempDirectory(async (directory) => {
			const entryPoint = path.join(directory, "index.jsx");
			await fs.writeFile(entryPoint, "registerRoot(() => null);", "utf8");
			await fs.writeFile(
				path.join(directory, "composition.jsx"),
				"export const MegaComposition = () => null;",
				"utf8",
			);

			const source = playerEntrySource(entryPoint);
			expect(source).toContain("SiblingComposition");
			expect(source).not.toContain("CustomEntry");
			expect(source).not.toContain("registerRoot");
		});
	});

	it("schedules scene offsets and audio against overlapping transitions", () => {
		const normalized = normalizeManifest(
			manifest([
				{
					...titleScene("opening", 30, { type: "fade", durationInFrames: 5 }),
					audio: [{ src: "intro.wav", startFrame: 10, durationInFrames: 4 }],
				},
				titleScene("diagram", 20),
			]),
			{ checkAssets: false },
		);

		expect(normalized.sceneStarts).toEqual([0, 25]);
		expect(normalized.audioTimeline).toMatchObject([
			{ sceneId: "opening", src: path.resolve("intro.wav"), startFrame: 10, durationInFrames: 4 },
		]);
		expect(normalized.durationInFrames).toBe(45);
	});

	it("rejects duplicate scene ids and transitions longer than either adjacent scene", () => {
		expect(() =>
			normalizeManifest(manifest([titleScene("same"), titleScene("same")]), { checkAssets: false }),
		).toThrow(/Duplicate scene id/);

		expect(() =>
			normalizeManifest(
				manifest([
					titleScene("opening", 4, { type: "fade", durationInFrames: 5 }),
					titleScene("ending", 10),
				]),
				{ checkAssets: false },
			),
		).toThrow(/longer than its scene/);

		expect(() =>
			normalizeManifest(
				manifest([
					titleScene("opening", 30, { type: "fade", durationInFrames: 11 }),
					titleScene("ending", 10),
				]),
				{ checkAssets: false },
			),
		).toThrow(/longer than the following scene/);
	});

	it("rejects audio that extends past its scene", () => {
		expect(() =>
			normalizeManifest(
				manifest([
					{
						...titleScene("opening"),
						audio: [{ src: "intro.wav", startFrame: 20, durationInFrames: 11 }],
					},
				]),
				{ checkAssets: false },
			),
		).toThrow(/exceeds scene duration/);
	});

	it("reports missing local media and rejects remote media by default", async () => {
		await withTempDirectory(async (directory) => {
			const missingPath = path.join(directory, "missing.json");
			await fs.writeFile(
				missingPath,
				JSON.stringify(
					manifest([{ ...titleScene("video"), elements: [{ type: "video", src: "missing.mp4" }] }]),
				),
				"utf8",
			);
			await expect(validate({ manifestPath: missingPath })).rejects.toMatchObject({
				code: "REMOTION_MANIFEST_INVALID",
			});

			const remotePath = path.join(directory, "remote.json");
			await fs.writeFile(
				remotePath,
				JSON.stringify(
					manifest([
						{
							...titleScene("video"),
							elements: [{ type: "video", src: "https://example.test/video.mp4" }],
						},
					]),
				),
				"utf8",
			);
			await expect(validate({ manifestPath: remotePath })).rejects.toMatchObject({
				code: "REMOTION_MANIFEST_INVALID",
			});
		});
	});

	it("does not overwrite a manifest through a symlinked render output", async () => {
		await withTempDirectory(async (directory) => {
			const manifestPath = path.join(directory, "project.json");
			const outputPath = path.join(directory, "output.mp4");
			await fs.writeFile(manifestPath, JSON.stringify(manifest()), "utf8");
			await fs.symlink(manifestPath, outputPath);

			await expect(
				render({
					manifestPath,
					outputPath,
					browserExecutable: path.join(directory, "missing-brave"),
				}),
			).rejects.toMatchObject({ code: "REMOTION_SOURCE_OVERWRITE" });
		});
	});
});
