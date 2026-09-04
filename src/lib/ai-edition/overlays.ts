import type {
	AxcutAnnotationRegion,
	AxcutOverlay,
	AxcutOverlayAnchor,
	AxcutOverlayType,
} from "./schema";

/** Defaults intentionally favour short, readable guidance over caption-like copy. */
export const OVERLAY_PRESETS: Record<
	AxcutOverlayType,
	Pick<AxcutOverlay, "position" | "anchor" | "size" | "space" | "style">
> = {
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
};

const ANCHOR_X: Record<AxcutOverlayAnchor, number> = {
	"top-left": 0,
	"top-center": 0.5,
	"top-right": 1,
	"center-left": 0,
	center: 0.5,
	"center-right": 1,
	"bottom-left": 0,
	"bottom-center": 0.5,
	"bottom-right": 1,
};
const ANCHOR_Y: Record<AxcutOverlayAnchor, number> = {
	"top-left": 0,
	"top-center": 0,
	"top-right": 0,
	"center-left": 0.5,
	center: 0.5,
	"center-right": 0.5,
	"bottom-left": 1,
	"bottom-center": 1,
	"bottom-right": 1,
};

/** Returns the top-left box for an overlay whose position denotes its anchor point. */
export function overlayBox(overlay: Pick<AxcutOverlay, "position" | "anchor" | "size">) {
	const width = Math.min(overlay.size.width, 100);
	const height = Math.min(overlay.size.height, 100);
	return {
		x: Math.min(Math.max(overlay.position.x - width * ANCHOR_X[overlay.anchor], 0), 100 - width),
		y: Math.min(Math.max(overlay.position.y - height * ANCHOR_Y[overlay.anchor], 0), 100 - height),
		width,
		height,
	};
}

/**
 * Adapt the product overlay to the existing annotation/native compositor contract.
 * This is a derived value only; the authored overlay remains in `document.overlays`.
 */
export function overlayAsAnnotation(overlay: AxcutOverlay): AxcutAnnotationRegion {
	const box = overlayBox(overlay);
	return {
		id: overlay.id,
		startMs: Math.round(overlay.startSec * 1000),
		endMs: Math.round(overlay.endSec * 1000),
		type: "text",
		content: overlay.text,
		textContent: overlay.text,
		position: { x: box.x, y: box.y },
		size: { width: box.width, height: box.height },
		style: {
			color: overlay.style.color,
			backgroundColor: overlay.style.backgroundColor,
			fontSize: overlay.style.fontSize,
			fontFamily: overlay.style.fontFamily,
			fontWeight: overlay.style.fontWeight,
			fontStyle: overlay.style.fontStyle,
			textDecoration: "none",
			textAlign: overlay.style.textAlign,
			textAnimation: "none",
		},
		zIndex: overlay.zIndex,
		...(overlay.space === "frame" ? { space: "frame" as const } : {}),
	};
}

export function overlayStyleForType(type: AxcutOverlayType) {
	return OVERLAY_PRESETS[type].style;
}
