// Post-export voiceover mixing for the CLI (`openscreen export --audio`).
//
// Takes the finished MP4 blob, copies its video packets untouched (no
// re-encode), renders a new audio track with OfflineAudioContext — the
// original audio and the voiceover mixed, or the voiceover alone — and
// re-muxes both into a new MP4 via mediabunny.

import {
	ALL_FORMATS,
	AudioBufferSource,
	BlobSource,
	BufferTarget,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	Input,
	Mp4OutputFormat,
	Output,
} from "mediabunny";

export type VoiceoverMixMode = "mix" | "replace";

export interface VoiceoverMixOptions {
	/** Encoded audio file bytes (mp3/wav/m4a — anything decodeAudioData accepts). */
	voiceoverData: ArrayBuffer;
	mode: VoiceoverMixMode;
	/** Delay before the voiceover starts, in seconds. */
	offsetSec: number;
	/** Gain applied to the original track in "mix" mode (0..1). */
	originalGain?: number;
}

/** An audio source placed on the edited (virtual) timeline. */
export interface TimelineAudioTrackInput {
	/** Encoded bytes for the source file. */
	data: ArrayBuffer;
	/** Start/end in source-file seconds. */
	sourceStartSec: number;
	sourceEndSec: number;
	/** Start/end on the exported timeline. */
	timelineStartSec: number;
	timelineEndSec: number;
	volume: number;
	muted: boolean;
	label?: string;
	status?: "ready" | "missing" | "error";
	error?: string;
}

export interface TimelineAudioMixOptions {
	tracks: TimelineAudioTrackInput[];
	mode: VoiceoverMixMode;
	/** Gain applied to the original track in mix mode (0..1). */
	originalGain?: number;
}

/** Validate persisted audio timing before an export opens an audio decoder. */
export function validateTimelineAudioTrackRanges(
	tracks: Pick<
		TimelineAudioTrackInput,
		"sourceStartSec" | "sourceEndSec" | "timelineStartSec" | "timelineEndSec" | "label"
	>[],
	durationSec: number,
): void {
	for (const track of tracks) {
		const label = track.label ? ` \"${track.label}\"` : "";
		if (
			!Number.isFinite(track.sourceStartSec) ||
			!Number.isFinite(track.sourceEndSec) ||
			track.sourceStartSec < 0 ||
			track.sourceEndSec < track.sourceStartSec
		) {
			throw new Error(`Audio duration sync error${label}: invalid source range`);
		}
		if (
			!Number.isFinite(track.timelineStartSec) ||
			!Number.isFinite(track.timelineEndSec) ||
			track.timelineStartSec < 0 ||
			track.timelineEndSec < track.timelineStartSec
		) {
			throw new Error(`Audio duration sync error${label}: invalid timeline range`);
		}
		if (track.timelineEndSec > durationSec + 0.05) {
			throw new Error(
				`Audio duration sync error${label}: track ends at ${track.timelineEndSec.toFixed(3)}s, but video ends at ${durationSec.toFixed(3)}s`,
			);
		}
	}
}

// Duck the original bed under the voiceover by default so the unity-gain sum
// of two loud sources doesn't hard-clip.
const DEFAULT_ORIGINAL_GAIN = 0.4;

const OUTPUT_SAMPLE_RATE = 48_000;
const OUTPUT_CHANNELS = 2;
const VOICEOVER_AUDIO_BITRATE = 192_000;

async function decodeToBuffer(
	context: OfflineAudioContext,
	data: ArrayBuffer,
): Promise<AudioBuffer> {
	// decodeAudioData detaches the buffer, so hand it a copy.
	return context.decodeAudioData(data.slice(0));
}

/** Renders the final audio track: original bed (optional) + offset voiceover. */
async function renderMixedAudio(
	videoData: ArrayBuffer | null,
	durationSec: number,
	options: VoiceoverMixOptions,
): Promise<AudioBuffer> {
	const frameCount = Math.max(1, Math.ceil(durationSec * OUTPUT_SAMPLE_RATE));
	const context = new OfflineAudioContext(OUTPUT_CHANNELS, frameCount, OUTPUT_SAMPLE_RATE);

	const voiceover = await decodeToBuffer(context, options.voiceoverData);
	const voiceoverNode = context.createBufferSource();
	voiceoverNode.buffer = voiceover;
	voiceoverNode.connect(context.destination);
	voiceoverNode.start(Math.max(0, options.offsetSec));

	if (options.mode === "mix" && videoData) {
		try {
			const original = await decodeToBuffer(context, videoData);
			const originalNode = context.createBufferSource();
			originalNode.buffer = original;
			const gainNode = context.createGain();
			gainNode.gain.value = options.originalGain ?? DEFAULT_ORIGINAL_GAIN;
			originalNode.connect(gainNode);
			gainNode.connect(context.destination);
			originalNode.start(0);
		} catch {
			// The exported video has no decodable audio track; the voiceover
			// becomes the only audio, same as "replace".
		}
	}

	return context.startRendering();
}

/**
 * Render all attached timeline tracks into one bounded audio stream.
 *
 * Track source/timeline ranges are checked against the decoded file and the
 * exported video duration before scheduling. Without these checks a stale WAV
 * or a hand-edited project would silently render only a partial narration and
 * leave the user with an apparently successful, out-of-sync export.
 */
async function renderTimelineAudio(
	videoData: ArrayBuffer | null,
	durationSec: number,
	options: TimelineAudioMixOptions,
): Promise<AudioBuffer> {
	validateTimelineAudioTrackRanges(options.tracks, durationSec);
	const frameCount = Math.max(1, Math.ceil(durationSec * OUTPUT_SAMPLE_RATE));
	const context = new OfflineAudioContext(OUTPUT_CHANNELS, frameCount, OUTPUT_SAMPLE_RATE);

	for (const track of options.tracks) {
		const label = track.label ? ` \"${track.label}\"` : "";
		if (track.muted || track.volume <= 0 || track.timelineEndSec <= track.timelineStartSec) {
			continue;
		}
		if (track.status === "missing" || track.status === "error") {
			throw new Error(
				`Attached audio track${label} is ${track.status}${track.error ? `: ${track.error}` : ""}`,
			);
		}

		let source: AudioBuffer;
		try {
			source = await decodeToBuffer(context, track.data);
		} catch (error) {
			throw new Error(
				`Audio duration sync error${label}: file could not be decoded${
					error instanceof Error ? ` (${error.message})` : ""
				}`,
			);
		}
		if (track.sourceEndSec > source.duration + 0.05) {
			throw new Error(
				`Audio duration sync error${label}: source ends at ${track.sourceEndSec.toFixed(3)}s, but file duration is ${source.duration.toFixed(3)}s`,
			);
		}

		const requestedDuration = Math.min(
			track.sourceEndSec - track.sourceStartSec,
			track.timelineEndSec - track.timelineStartSec,
			durationSec - track.timelineStartSec,
		);
		if (requestedDuration <= 0) continue;
		const sourceNode = context.createBufferSource();
		sourceNode.buffer = source;
		const gainNode = context.createGain();
		gainNode.gain.value = Math.min(2, Math.max(0, track.volume));
		sourceNode.connect(gainNode);
		gainNode.connect(context.destination);
		sourceNode.start(track.timelineStartSec, track.sourceStartSec, requestedDuration);
	}

	if (options.mode === "mix" && videoData) {
		try {
			const original = await decodeToBuffer(context, videoData);
			const originalNode = context.createBufferSource();
			originalNode.buffer = original;
			const gainNode = context.createGain();
			gainNode.gain.value = options.originalGain ?? DEFAULT_ORIGINAL_GAIN;
			originalNode.connect(gainNode);
			gainNode.connect(context.destination);
			originalNode.start(0);
		} catch {
			// A video without a decodable audio stream is still a valid replace-like
			// export; attached tracks are already scheduled above.
		}
	}

	return context.startRendering();
}

async function remuxWithAudio(
	videoBlob: Blob,
	render: (videoData: ArrayBuffer | null, durationSec: number) => Promise<AudioBuffer>,
	needsVideoData: boolean,
): Promise<Blob> {
	const input = new Input({ source: new BlobSource(videoBlob), formats: ALL_FORMATS });
	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) {
			throw new Error("Exported file has no video track to remux");
		}
		const codec = videoTrack.codec;
		if (!codec) {
			throw new Error("Exported file's video codec was not recognized");
		}
		const decoderConfig = await videoTrack.getDecoderConfig();
		if (!decoderConfig) {
			throw new Error("Exported file's video decoder config could not be read");
		}
		const durationSec = await input.computeDuration();
		const mixedAudio = await render(
			needsVideoData ? await videoBlob.arrayBuffer() : null,
			durationSec,
		);

		const target = new BufferTarget();
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: "in-memory" }),
			target,
		});
		try {
			const videoSource = new EncodedVideoPacketSource(codec);
			output.addVideoTrack(videoSource);
			const audioSource = new AudioBufferSource({
				codec: "aac",
				bitrate: VOICEOVER_AUDIO_BITRATE,
			});
			output.addAudioTrack(audioSource);
			await output.start();

			const sink = new EncodedPacketSink(videoTrack);
			let isFirstPacket = true;
			for await (const packet of sink.packets()) {
				await videoSource.add(packet, isFirstPacket ? { decoderConfig } : undefined);
				isFirstPacket = false;
			}
			await audioSource.add(mixedAudio);
			await output.finalize();
		} catch (error) {
			await output.cancel().catch(() => undefined);
			throw error;
		}
		const buffer = target.buffer;
		if (!buffer) {
			throw new Error("Audio remux produced no output");
		}
		return new Blob([buffer], { type: "video/mp4" });
	} finally {
		input.dispose();
	}
}

/**
 * Returns a new MP4 blob with the same video stream and the mixed audio track.
 * The video packets are copied without re-encoding.
 */
export async function mixVoiceoverIntoVideo(
	videoBlob: Blob,
	options: VoiceoverMixOptions,
): Promise<Blob> {
	return remuxWithAudio(
		videoBlob,
		(videoData, durationSec) => renderMixedAudio(videoData, durationSec, options),
		options.mode === "mix",
	);
}

/**
 * Mix or replace the audio stream using the tracks persisted on an Axcut
 * timeline. Video packets are copied untouched, matching the existing
 * `--audio` path; only the bounded AAC audio stream is rendered again.
 */
export async function mixAudioTracksIntoVideo(
	videoBlob: Blob,
	options: TimelineAudioMixOptions,
): Promise<Blob> {
	if (options.tracks.length === 0) {
		throw new Error("No attached audio tracks are available for export");
	}
	return remuxWithAudio(
		videoBlob,
		(videoData, durationSec) => renderTimelineAudio(videoData, durationSec, options),
		options.mode === "mix",
	);
}
