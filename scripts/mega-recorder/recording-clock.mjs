import fs from "node:fs/promises";
import path from "node:path";

/**
 * The clock written by the headless recorder when capture has really begun.
 *
 * `Date.now()` is intentionally retained as the cross-process exchange clock:
 * an action command normally runs in a different Node process from Electron,
 * so its `performance.now()` has a different origin.  The monotonic sample is
 * still useful as an audit/reference value inside the recording process and
 * makes the readiness edge explicit; it is never mixed with a foreign process
 * monotonic clock when deriving an action timestamp.
 */
export const RECORDING_CLOCK_SCHEMA_VERSION = 1;
export const RECORDING_CLOCK_KIND = "mega-recorder-recording-clock";
export const RECORDING_CLOCK_STATUSES = ["recording", "stopped"];

function finite(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function nonNegative(value, label) {
	if (!finite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
	return value;
}

function monotonicNowMs() {
	return Number(process.hrtime.bigint()) / 1e6;
}

/**
 * Make a source-clock readiness reference at the moment the recorder has a
 * confirmed capture start. Callers may inject values in tests; production
 * callers should leave them unset.
 */
export function createRecordingClockReference({
	epochMs = Date.now(),
	monotonicMs = monotonicNowMs(),
	source = "recorder-capture-start",
	precisionMs = 1,
	clockId,
} = {}) {
	nonNegative(epochMs, "startedAtEpochMs");
	nonNegative(monotonicMs, "startedAtMonotonicMs");
	if (typeof source !== "string" || !source.trim()) throw new Error("clock source is required");
	if (!finite(precisionMs) || precisionMs <= 0)
		throw new Error("clock precisionMs must be positive");
	return {
		schemaVersion: RECORDING_CLOCK_SCHEMA_VERSION,
		kind: RECORDING_CLOCK_KIND,
		ready: true,
		status: "recording",
		clockId: typeof clockId === "string" && clockId.trim() ? clockId : undefined,
		startedAtEpochMs: Math.round(epochMs),
		startedAtMonotonicMs: monotonicMs,
		startedAtIso: new Date(epochMs).toISOString(),
		source: source.trim(),
		precisionMs: Math.max(1, Math.round(precisionMs)),
	};
}

/** Validate and canonicalize a persisted source-clock reference. */
export function normalizeRecordingClockReference(value) {
	if (!value || typeof value !== "object") throw new Error("Recording clock must be an object");
	if (value.schemaVersion !== undefined && value.schemaVersion !== RECORDING_CLOCK_SCHEMA_VERSION)
		throw new Error(`Unsupported recording clock schema version: ${value.schemaVersion}`);
	if (value.kind !== undefined && value.kind !== RECORDING_CLOCK_KIND)
		throw new Error(`Unsupported recording clock kind: ${value.kind}`);
	if (value.ready !== true) throw new Error("Recording clock is not ready");
	const status = value.status === undefined ? "recording" : value.status;
	if (!RECORDING_CLOCK_STATUSES.includes(status))
		throw new Error(
			`Recording clock status must be one of: ${RECORDING_CLOCK_STATUSES.join(", ")}`,
		);
	const startedAtEpochMs = nonNegative(Number(value.startedAtEpochMs), "startedAtEpochMs");
	const startedAtMonotonicMs =
		value.startedAtMonotonicMs === undefined
			? undefined
			: nonNegative(Number(value.startedAtMonotonicMs), "startedAtMonotonicMs");
	const source =
		typeof value.source === "string" && value.source.trim()
			? value.source.trim()
			: "recorder-capture-start";
	const precisionMs =
		value.precisionMs === undefined
			? 1
			: Math.max(1, Math.round(nonNegative(Number(value.precisionMs), "precisionMs")));
	const endedAtEpochMs =
		value.endedAtEpochMs === undefined
			? undefined
			: nonNegative(Number(value.endedAtEpochMs), "endedAtEpochMs");
	const durationMs =
		value.durationMs === undefined
			? undefined
			: nonNegative(Number(value.durationMs), "durationMs");
	if (endedAtEpochMs !== undefined && endedAtEpochMs < startedAtEpochMs)
		throw new Error("endedAtEpochMs must be after startedAtEpochMs");
	return {
		schemaVersion: RECORDING_CLOCK_SCHEMA_VERSION,
		kind: RECORDING_CLOCK_KIND,
		ready: true,
		status,
		...(typeof value.clockId === "string" && value.clockId.trim()
			? { clockId: value.clockId.trim() }
			: {}),
		startedAtEpochMs: Math.round(startedAtEpochMs),
		...(startedAtMonotonicMs !== undefined ? { startedAtMonotonicMs } : {}),
		startedAtIso: new Date(startedAtEpochMs).toISOString(),
		source,
		precisionMs,
		...(endedAtEpochMs !== undefined ? { endedAtEpochMs: Math.round(endedAtEpochMs) } : {}),
		...(durationMs !== undefined ? { durationMs: Math.round(durationMs) } : {}),
	};
}

/**
 * Derive an action's source-media time from a persisted clock. This uses the
 * shared epoch exchange deliberately. It represents when the action command
 * was observed, not an exact click, unless the caller supplies telemetry.
 */
export function timestampFromRecordingClock(clock, { epochMs = Date.now() } = {}) {
	const normalized = normalizeRecordingClockReference(clock);
	nonNegative(epochMs, "observedAtEpochMs");
	return Math.max(0, (epochMs - normalized.startedAtEpochMs) / 1000);
}

export async function readRecordingClock(filePath) {
	return normalizeRecordingClockReference(JSON.parse(await fs.readFile(filePath, "utf8")));
}

/** Atomic write so an action process never reads a partially-written reference. */
export async function writeRecordingClock(filePath, clock) {
	const normalized = normalizeRecordingClockReference(clock);
	const absolute = path.resolve(filePath);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	const temporary = `${absolute}.${process.pid}.tmp`;
	try {
		await fs.writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await fs.rename(temporary, absolute);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
	return normalized;
}
