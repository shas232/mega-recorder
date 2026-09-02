import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBrowserEditorServer } from "./browser-editor-server.mjs";

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "mega-recorder-browser-editor-"));
	const mediaPath = path.join(root, "capture.mp4");
	const projectPath = path.join(root, "demo.openscreen");
	await fs.writeFile(mediaPath, Buffer.from("test media bytes"));
	await fs.writeFile(
		projectPath,
		JSON.stringify({
			schemaVersion: 7,
			project: {
				id: "proj_browser_test",
				title: "Browser test",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				primaryAssetId: "asset_screen",
			},
			assets: [{ id: "asset_screen", kind: "video", label: "Capture", originalPath: mediaPath }],
			timeline: {
				clips: [],
				gaps: [],
				trimRanges: [],
				muteRanges: [],
				speedRanges: [],
				captionRanges: [],
			},
			annotations: [],
			zoomRanges: [],
			legacyEditor: null,
		}),
	);
	return { root, mediaPath, projectPath };
}

function apiHeaders(token) {
	return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

describe("browser editor server", () => {
	it("binds to loopback, requires its token, serves referenced media, and persists saves", async () => {
		const files = await fixture();
		const editor = await createBrowserEditorServer({
			projectPath: files.projectPath,
			distDir: path.resolve("dist"),
		});
		try {
			expect(editor.host).toBe("127.0.0.1");
			expect(editor.port).toBeGreaterThan(0);
			expect(editor.token).toMatch(/^[a-f0-9]{64}$/);
			const base = `http://${editor.host}:${editor.port}`;
			const unauthorized = await fetch(`${base}/api/session`);
			expect(unauthorized.status).toBe(401);

			const session = await fetch(`${base}/api/session?token=${editor.token}`);
			expect(session.status).toBe(200);
			expect((await session.json()).project.id).toBe("proj_browser_test");

			const list = await fetch(`${base}/api/bridge`, {
				method: "POST",
				headers: apiHeaders(editor.token),
				body: JSON.stringify({ domain: "aiEdition", action: "document.listProjects" }),
			});
			expect((await list.json()).data[0].title).toBe("Browser test");

			const save = await fetch(`${base}/api/bridge`, {
				method: "POST",
				headers: apiHeaders(editor.token),
				body: JSON.stringify({
					domain: "aiEdition",
					action: "document.save",
					payload: {
						document: {
							schemaVersion: 7,
							project: {
								id: "proj_browser_test",
								title: "Saved from browser",
								createdAt: "2026-01-01T00:00:00.000Z",
								updatedAt: "2026-01-01T00:00:00.000Z",
								primaryAssetId: "asset_screen",
							},
							assets: [
								{
									id: "asset_screen",
									kind: "video",
									label: "Capture",
									originalPath: `${base}/api/media/asset_screen?token=wrong`,
								},
							],
							timeline: {
								clips: [],
								gaps: [],
								trimRanges: [],
								muteRanges: [],
								speedRanges: [],
								captionRanges: [],
							},
							annotations: [],
							zoomRanges: [],
							legacyEditor: null,
						},
					},
				}),
			});
			expect(save.status).toBe(200);
			expect(await fs.readFile(files.projectPath, "utf8")).toContain("Saved from browser");
			expect(await fs.readFile(files.projectPath, "utf8")).toContain(files.mediaPath);

			const media = await fetch(`${base}/api/media/asset_screen?token=${editor.token}`);
			expect(media.status).toBe(200);
			expect(await media.text()).toBe("test media bytes");
			const arbitrary = await fetch(`${base}/api/media/not-an-asset?token=${editor.token}`);
			expect(arbitrary.status).toBe(404);
			const outOfScopeSave = await fetch(`${base}/api/bridge`, {
				method: "POST",
				headers: apiHeaders(editor.token),
				body: JSON.stringify({
					domain: "aiEdition",
					action: "document.save",
					payload: { document: { project: { id: "proj_other" }, assets: [] } },
				}),
			});
			expect(outOfScopeSave.status).toBe(403);
		} finally {
			await editor.close();
			await fs.rm(files.root, { recursive: true, force: true });
		}
	});

	it("rejects non-loopback binds and never serves files outside the renderer build", async () => {
		const files = await fixture();
		await expect(
			createBrowserEditorServer({ projectPath: files.projectPath, host: "0.0.0.0" }),
		).rejects.toMatchObject({ code: "LOCALHOST_ONLY" });
		const editor = await createBrowserEditorServer({
			projectPath: files.projectPath,
			distDir: path.resolve("dist"),
		});
		try {
			const outside = await fetch(`http://${editor.host}:${editor.port}/../package.json`);
			expect(outside.status).toBe(404);
		} finally {
			await editor.close();
			await fs.rm(files.root, { recursive: true, force: true });
		}
	});
});
