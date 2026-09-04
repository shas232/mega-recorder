import { randomUUID } from "node:crypto";

export const OVERLAY_TYPES = ["title", "label", "callout", "lower-third"];
export const OVERLAY_ANCHORS = [
	"top-left",
	"top-center",
	"top-right",
	"center-left",
	"center",
	"center-right",
	"bottom-left",
	"bottom-center",
	"bottom-right",
];

export const OVERLAY_PRESETS = Object.freeze({
	title: {
		position: { x: 50, y: 12 },
		anchor: "top-center",
		size: { width: 76, height: 14 },
		space: "frame",
		style: {
			color: "#ffffff",
			backgroundColor: "rgba(17, 24, 39, 0.9)",
			fontSize: 44,
			fontFamily: "Inter",
			fontWeight: "bold",
			fontStyle: "normal",
			textAlign: "center",
			borderRadius: 14,
			padding: 14,
			opacity: 1,
		},
	},
	label: {
		position: { x: 8, y: 8 },
		anchor: "top-left",
		size: { width: 42, height: 11 },
		space: "screen",
		style: {
			color: "#ffffff",
			backgroundColor: "rgba(37, 99, 235, 0.92)",
			fontSize: 28,
			fontFamily: "Inter",
			fontWeight: "bold",
			fontStyle: "normal",
			textAlign: "left",
			borderRadius: 10,
			padding: 10,
			opacity: 1,
		},
	},
	callout: {
		position: { x: 88, y: 55 },
		anchor: "center-right",
		size: { width: 42, height: 16 },
		space: "screen",
		style: {
			color: "#111827",
			backgroundColor: "rgba(251, 191, 36, 0.95)",
			fontSize: 27,
			fontFamily: "Inter",
			fontWeight: "bold",
			fontStyle: "normal",
			textAlign: "left",
			borderRadius: 12,
			padding: 12,
			opacity: 1,
		},
	},
	"lower-third": {
		position: { x: 6, y: 88 },
		anchor: "bottom-left",
		size: { width: 62, height: 16 },
		space: "frame",
		style: {
			color: "#ffffff",
			backgroundColor: "rgba(15, 23, 42, 0.92)",
			fontSize: 30,
			fontFamily: "Inter",
			fontWeight: "bold",
			fontStyle: "normal",
			textAlign: "left",
			borderRadius: 10,
			padding: 12,
			opacity: 1,
		},
	},
});

const finite = (value) => typeof value === "number" && Number.isFinite(value);

export function validateOverlay(input) {
	if (!input || typeof input !== "object") throw new Error("Overlay must be an object.");
	if (typeof input.id !== "string" || !input.id.trim()) throw new Error("Overlay id is required.");
	if (!finite(input.startSec) || input.startSec < 0)
		throw new Error("Overlay startSec must be nonnegative.");
	if (!finite(input.endSec) || input.endSec <= input.startSec)
		throw new Error("Overlay endSec must be greater than startSec.");
	if (typeof input.text !== "string" || !input.text.trim())
		throw new Error("Overlay text is required.");
	if (!OVERLAY_TYPES.includes(input.type)) throw new Error(`Unknown overlay type: ${input.type}`);
	if (!OVERLAY_ANCHORS.includes(input.anchor))
		throw new Error(`Unknown overlay anchor: ${input.anchor}`);
	if (!input.position || !finite(input.position.x) || !finite(input.position.y))
		throw new Error("Overlay position must contain finite x and y values.");
	if (
		input.position.x < 0 ||
		input.position.x > 100 ||
		input.position.y < 0 ||
		input.position.y > 100
	)
		throw new Error("Overlay position must be between 0 and 100.");
	if (!input.size || !finite(input.size.width) || !finite(input.size.height))
		throw new Error("Overlay size must contain finite width and height values.");
	if (
		input.size.width <= 0 ||
		input.size.width > 100 ||
		input.size.height <= 0 ||
		input.size.height > 100
	)
		throw new Error("Overlay size must be between 0 and 100.");
	if (input.space !== "screen" && input.space !== "frame")
		throw new Error("Overlay space is invalid.");
	return input;
}

export function createOverlay({
	id = `overlay_${randomUUID()}`,
	startSec,
	endSec,
	text,
	type = "label",
	position,
	anchor,
	size,
	space,
	style,
	zIndex,
}) {
	const preset = OVERLAY_PRESETS[type];
	if (!preset) throw new Error(`Unknown overlay type: ${type}`);
	return validateOverlay({
		id,
		startSec,
		endSec,
		text: text?.trim?.() ?? text,
		type,
		position: { ...preset.position, ...(position ?? {}) },
		anchor: anchor ?? preset.anchor,
		size: { ...preset.size, ...(size ?? {}) },
		space: space ?? preset.space,
		style: { ...preset.style, ...(style ?? {}) },
		zIndex: zIndex ?? 1000,
	});
}

/** Keep overlays on the edited timeline when a source span is ripple-deleted. */
export function remapOverlaysAfterDelete(overlays, startSec, endSec) {
	const lo = Math.min(startSec, endSec);
	const hi = Math.max(startSec, endSec);
	const removed = hi - lo;
	if (!(removed > 0)) return overlays.map((overlay) => ({ ...overlay }));
	return overlays.flatMap((overlay) => {
		validateOverlay(overlay);
		const start = overlay.startSec;
		const end = overlay.endSec;
		if (end <= lo) return [{ ...overlay }];
		if (start >= hi) return [{ ...overlay, startSec: start - removed, endSec: end - removed }];

		const next = [];
		// The first piece remains at the original id. If the cut splits a label,
		// the second piece gets a deterministic id so repeated saves are stable.
		if (start < lo) next.push({ ...overlay, endSec: Math.min(end, lo) });
		if (end > hi) {
			next.push({
				...overlay,
				id: start < lo ? `${overlay.id}_part2` : overlay.id,
				startSec: start < lo ? lo : lo,
				endSec: end - removed,
			});
		}
		return next.filter((piece) => piece.endSec > piece.startSec);
	});
}

export function addOverlayToDocument(document, overlay) {
	const next = createOverlay(overlay);
	return {
		...document,
		overlays: [...(Array.isArray(document.overlays) ? document.overlays : []), next],
	};
}

export function removeOverlayFromDocument(document, id) {
	if (typeof id !== "string" || !id.trim()) throw new Error("Overlay id is required.");
	const overlays = Array.isArray(document.overlays) ? document.overlays : [];
	return { ...document, overlays: overlays.filter((overlay) => overlay.id !== id) };
}
