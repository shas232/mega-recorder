import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_CONTRACT = "mega-recorder-project";

async function hashFile(filePath) {
	const hash = createHash("sha256");
	const data = await fs.readFile(filePath);
	return {
		path: path.resolve(filePath),
		bytes: data.byteLength,
		sha256: hash.update(data).digest("hex"),
	};
}

export async function hashNarration(text, inputPath = "stdin") {
	return {
		kind: "narration-text",
		path: inputPath,
		bytes: Buffer.byteLength(text, "utf8"),
		sha256: createHash("sha256").update(text, "utf8").digest("hex"),
	};
}

export async function hashFiles(filePaths) {
	return Promise.all(filePaths.map((filePath) => hashFile(filePath)));
}

export function upstreamCommitFromBaseline(baseline) {
	const commit = baseline?.project?.upstreamCommit;
	return typeof commit === "string" && commit.length > 0 ? commit : null;
}

export function buildManifest({
	baseline,
	preset = null,
	kokoro = null,
	inputs = [],
	outputs = [],
	verification = null,
	command = null,
}) {
	return {
		contract: MANIFEST_CONTRACT,
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		project: {
			name: "MEGA RECORDER",
			upstreamCommit: upstreamCommitFromBaseline(baseline),
			upstreamRepository: baseline?.project?.upstreamRepository ?? null,
		},
		preset: preset
			? {
					id: preset.id,
					version: preset.contractVersion,
				}
			: null,
		kokoro: kokoro
			? {
					runtime: kokoro.runtime ?? "local-python",
					model: kokoro.model ?? "hexgrad/Kokoro-82M",
					modelRevision: kokoro.modelRevision ?? null,
					voice: kokoro.voice ?? null,
					sampleRate: kokoro.sampleRate ?? 24000,
				}
			: null,
		inputs,
		outputs,
		verification,
		command,
	};
}

export async function writeManifest(filePath, manifest) {
	const absolute = path.resolve(filePath);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	const temporary = `${absolute}.${process.pid}.tmp`;
	try {
		await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		await fs.rename(temporary, absolute);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
	return absolute;
}

export async function updateManifest(filePath, manifest) {
	const absolute = path.resolve(filePath);
	let previous = null;
	try {
		previous = JSON.parse(await fs.readFile(absolute, "utf8"));
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	const dedupe = (items) => {
		const seen = new Set();
		return items.filter((item) => {
			const key = `${item.path ?? ""}:${item.sha256 ?? ""}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	};
	const merged = previous
		? {
				...previous,
				...manifest,
				preset: manifest.preset ?? previous.preset ?? null,
				kokoro: manifest.kokoro ?? previous.kokoro ?? null,
				inputs: dedupe([...(previous.inputs ?? []), ...(manifest.inputs ?? [])]),
				outputs: dedupe([...(previous.outputs ?? []), ...(manifest.outputs ?? [])]),
				verification: manifest.verification ?? previous.verification ?? null,
			}
		: manifest;
	return writeManifest(absolute, merged);
}
