import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRuntimeEnvironment, modelCacheCandidates, resolveDefaultVoice } from "./kokoro.mjs";

describe("local Kokoro runtime contract", () => {
	it("uses an explicit model cache while forcing offline, no-telemetry mode", () => {
		const runtime = buildRuntimeEnvironment(
			{ HF_HUB_OFFLINE: "0", HF_HUB_CACHE: "/old/cache", KEEP_ME: "yes" },
			{ path: "/tmp/custom/hub/models--hexgrad--Kokoro-82M" },
		);

		expect(runtime).toMatchObject({
			HF_HUB_CACHE: "/tmp/custom/hub",
			HUGGINGFACE_HUB_CACHE: "/tmp/custom/hub",
			HF_HUB_OFFLINE: "1",
			TRANSFORMERS_OFFLINE: "1",
			HF_DATASETS_OFFLINE: "1",
			HF_HUB_DISABLE_TELEMETRY: "1",
			MEGA_RECORDER_NO_NETWORK: "1",
			KEEP_ME: "yes",
		});
	});

	it("recognizes a caller-selected model cache directory", () => {
		expect(
			modelCacheCandidates({
				MEGA_RECORDER_KOKORO_MODEL_CACHE: "/tmp/custom/models--hexgrad--Kokoro-82M",
			}),
		).toContain("/tmp/custom/models--hexgrad--Kokoro-82M");
		expect(modelCacheCandidates({ HF_HUB_CACHE: "/tmp/custom/hub" })).toContain(
			"/tmp/custom/hub/models--hexgrad--Kokoro-82M",
		);
	});

	it("falls back to a cached voice when the preferred default is absent", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mega-recorder-kokoro-"));
		try {
			const cache = path.join(root, "models--hexgrad--Kokoro-82M");
			const snapshot = path.join(cache, "snapshots", "local", "voices");
			await fs.mkdir(snapshot, { recursive: true });
			await fs.writeFile(path.join(cache, "snapshots", "local", "config.json"), "{}", "utf8");
			await fs.writeFile(path.join(cache, "snapshots", "local", "model.pth"), "weights");
			await fs.writeFile(path.join(snapshot, "am_michael.pt"), "voice");

			expect(await resolveDefaultVoice({ MEGA_RECORDER_KOKORO_MODEL_CACHE: cache })).toBe(
				"am_michael",
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
