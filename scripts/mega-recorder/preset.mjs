/**
 * MEGA RECORDER presets are deliberately plain data.  The values under
 * `upstream.editor` are the v2 .openscreen editor keys consumed by the existing
 * renderer/export pipeline; the descriptive fields make the product contract
 * inspectable without loading Electron.
 */

const BLUE_STUDIO = Object.freeze({
	contractVersion: 1,
	id: "blue-studio",
	name: "Blue Studio",
	description: "A restrained blue studio frame for polished product demos.",
	canvas: Object.freeze({
		width: 1920,
		height: 1080,
		fps: 60,
		aspectRatio: "16:9",
	}),
	background: Object.freeze({
		// `showBlur` is the upstream compositor's background blur toggle.  The
		// gradient remains a valid wallpaper value in both preview and export.
		wallpaper: "radial-gradient(ellipse at 50% 35%, #2563eb 0%, #172554 58%, #0b1020 100%)",
		blurred: true,
	}),
	foregroundCard: Object.freeze({
		// The native compositor derives this geometry from `padding`: scale is
		// 1 - 0.4 * (padding / 100), giving an ~1613x907 card at 1920x1080.
		padding: 40,
		geometry: "centered",
		width: 1613,
		height: 907,
		shadowIntensity: 0.35,
		borderRadius: 32,
	}),
	cursor: Object.freeze({
		visible: true,
		theme: "default",
		size: 3,
		smoothing: 0.67,
		motionBlur: 0.2,
		clickBounce: 2.5,
		clipToBounds: false,
	}),
	zoom: Object.freeze({
		enabled: true,
		defaultDepth: 3,
		maxDepth: 4,
		focus: "cursor",
	}),
	upstream: Object.freeze({
		format: "openscreen-v2",
		export: Object.freeze({
			// MP4 exports in the upstream CLI use this fixed 60fps path.
			fps: 60,
			quality: "good",
		}),
		editor: Object.freeze({
			wallpaper: "radial-gradient(ellipse at 50% 35%, #2563eb 0%, #172554 58%, #0b1020 100%)",
			showBlur: true,
			shadowIntensity: 0.35,
			motionBlurAmount: 0.2,
			borderRadius: 32,
			padding: 40,
			aspectRatio: "16:9",
			exportFormat: "mp4",
			exportQuality: "good",
			autoZoomEnabled: true,
			autoFocusAll: true,
			cursorTheme: "default",
			// These extension keys are preserved by normalizeProjectEditor and
			// arrive in Axcut's legacyEditor envelope for the native compositor.
			cursorShow: true,
			cursorSize: 3,
			cursorSmoothing: 0.67,
			cursorMotionBlur: 0.2,
			cursorClickBounce: 2.5,
			cursorClipToBounds: false,
		}),
	}),
});

export const PRESETS = Object.freeze({
	[BLUE_STUDIO.id]: BLUE_STUDIO,
});

export function getPreset(id = "blue-studio") {
	return Object.hasOwn(PRESETS, id) ? PRESETS[id] : null;
}

export function listPresets() {
	return Object.values(PRESETS);
}

/** Apply only the upstream editor mapping, preserving unrelated project keys. */
export function applyPresetToProject(project, preset) {
	if (!project || typeof project !== "object") {
		throw new TypeError("Project must be a JSON object");
	}
	return {
		...project,
		version: typeof project.version === "number" ? project.version : 2,
		editor: {
			...(project.editor && typeof project.editor === "object" ? project.editor : {}),
			...preset.upstream.editor,
		},
	};
}
