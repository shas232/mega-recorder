import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

function parseRational(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "string" || value.length === 0) return null;
	const [numerator, denominator] = value.split("/").map(Number);
	if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0)
		return null;
	return numerator / denominator;
}

function structuredError(code, message, details = {}) {
	return { code, message, ...details };
}

function runFfprobe(ffprobe, mediaPath) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			ffprobe,
			["-v", "error", "-print_format", "json", "-show_format", "-show_streams", mediaPath],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code !== 0) {
				reject(
					Object.assign(
						new Error(stderr.trim() || `ffprobe exited with code ${code ?? "unknown"}`),
						{ code: "FFPROBE_FAILED", exitCode: code, signal },
					),
				);
				return;
			}
			try {
				resolve(JSON.parse(stdout));
			} catch (error) {
				reject(
					Object.assign(new Error("ffprobe returned invalid JSON"), {
						code: "FFPROBE_INVALID_JSON",
						cause: error,
					}),
				);
			}
		});
	});
}

export function mediaMetadata(probe) {
	const streams = Array.isArray(probe?.streams) ? probe.streams : [];
	const video = streams.find((stream) => stream.codec_type === "video");
	const audio = streams.find((stream) => stream.codec_type === "audio");
	const durationCandidates = [probe?.format?.duration, video?.duration, audio?.duration]
		.map(Number)
		.filter(Number.isFinite);
	const fps = parseRational(video?.avg_frame_rate) ?? parseRational(video?.r_frame_rate);
	return {
		container: probe?.format?.format_name ?? null,
		durationSec: durationCandidates.length > 0 ? Math.max(...durationCandidates) : null,
		video: video
			? {
					codec: video.codec_name ?? null,
					width: Number.isFinite(Number(video.width)) ? Number(video.width) : null,
					height: Number.isFinite(Number(video.height)) ? Number(video.height) : null,
					fps,
				}
			: null,
		audio: audio
			? {
					codec: audio.codec_name ?? null,
					sampleRate: Number.isFinite(Number(audio.sample_rate)) ? Number(audio.sample_rate) : null,
					channels: Number.isFinite(Number(audio.channels)) ? Number(audio.channels) : null,
				}
			: null,
	};
}

export async function probeMedia(mediaPath, options = {}) {
	const absolute = path.resolve(mediaPath);
	try {
		const stat = await fs.stat(absolute);
		if (!stat.isFile()) {
			throw structuredError("MEDIA_NOT_FILE", `Media path is not a file: ${absolute}`);
		}
	} catch (error) {
		if (error?.code === "ENOENT") {
			throw structuredError("MEDIA_NOT_FOUND", `Media file does not exist: ${absolute}`);
		}
		if (error?.code && typeof error.code === "string" && error.code.startsWith("MEDIA_"))
			throw error;
		throw structuredError("MEDIA_UNREADABLE", `Unable to read media file: ${absolute}`);
	}
	const ffprobe = options.ffprobePath || process.env.MEGA_RECORDER_FFPROBE || "ffprobe";
	try {
		const raw = await runFfprobe(ffprobe, absolute);
		return { path: absolute, metadata: mediaMetadata(raw), raw };
	} catch (error) {
		if (error?.code === "ENOENT") {
			throw structuredError("FFPROBE_NOT_FOUND", `ffprobe executable was not found: ${ffprobe}`);
		}
		const code = error?.code || "FFPROBE_FAILED";
		throw structuredError(code, error instanceof Error ? error.message : String(error), {
			path: absolute,
		});
	}
}

function check(name, actual, expected, options = {}) {
	if (expected === undefined || expected === null) {
		return { name, checked: false, passed: true, actual: actual ?? null };
	}
	const tolerance = options.tolerance ?? 0;
	const passed =
		typeof actual === "number" && typeof expected === "number"
			? Math.abs(actual - expected) <= tolerance
			: typeof actual === "string" && typeof expected === "string"
				? actual.toLowerCase() === expected.toLowerCase()
				: actual === expected;
	return {
		name,
		checked: true,
		passed,
		actual: actual ?? null,
		expected,
		...(tolerance ? { tolerance } : {}),
	};
}

export function verifyMetadata(metadata, expected = {}) {
	const checks = [
		check("duration", metadata.durationSec, expected.durationSec, {
			tolerance: expected.durationTolerance,
		}),
		check("videoCodec", metadata.video?.codec, expected.videoCodec),
		check("audioCodec", metadata.audio?.codec, expected.audioCodec),
		check("width", metadata.video?.width, expected.width),
		check("height", metadata.video?.height, expected.height),
		check("fps", metadata.video?.fps, expected.fps, { tolerance: expected.fpsTolerance ?? 0.01 }),
		check("sampleRate", metadata.audio?.sampleRate, expected.sampleRate),
	];
	const errors = checks
		.filter((item) => item.checked && !item.passed)
		.map((item) =>
			structuredError("VERIFY_MISMATCH", `${item.name} did not match the expected value`, {
				field: item.name,
				expected: item.expected,
				actual: item.actual,
			}),
		);
	if (!metadata.video) {
		errors.push(structuredError("VIDEO_STREAM_MISSING", "Media does not contain a video stream"));
	}
	if (expected.audioCodec !== undefined || expected.sampleRate !== undefined) {
		if (!metadata.audio) {
			errors.push(
				structuredError("AUDIO_STREAM_MISSING", "Media does not contain an audio stream"),
			);
		}
	}
	return { passed: errors.length === 0, checks, errors };
}

export async function verifyMedia(mediaPath, expected = {}, options = {}) {
	const probed = await probeMedia(mediaPath, options);
	return {
		path: probed.path,
		metadata: probed.metadata,
		...verifyMetadata(probed.metadata, expected),
	};
}
