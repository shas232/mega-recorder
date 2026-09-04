import type { CSSProperties } from "react";
import { overlayBox } from "@/lib/ai-edition/overlays";
import type { AxcutOverlay } from "@/lib/ai-edition/schema";

interface OverlayLayerProps {
	overlays: AxcutOverlay[];
	currentTimeSec: number;
	frameWidth: number;
	frameHeight: number;
	screenRect: { x: number; y: number; width: number; height: number } | null;
}

/** Browser-only overlay pixels. Native export/desktop preview consume the same
 * authored entries through `overlayAsAnnotation` and the scene compositor. */
export function OverlayLayer({
	overlays,
	currentTimeSec,
	frameWidth,
	frameHeight,
	screenRect,
}: OverlayLayerProps) {
	if (frameWidth <= 0 || frameHeight <= 0) return null;
	const active = overlays
		.filter((overlay) => currentTimeSec >= overlay.startSec && currentTimeSec < overlay.endSec)
		.sort((a, b) => a.zIndex - b.zIndex);
	if (active.length === 0) return null;

	return (
		<div
			aria-label="On-video overlays"
			data-testid="video-overlay-layer"
			style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}
		>
			{active.map((overlay) => {
				const box = overlayBox(overlay);
				const reference =
					overlay.space === "frame"
						? { x: 0, y: 0, width: frameWidth, height: frameHeight }
						: screenRect;
				if (!reference) return null;
				const left = reference.x + (box.x / 100) * reference.width;
				const top = reference.y + (box.y / 100) * reference.height;
				const width = (box.width / 100) * reference.width;
				const height = (box.height / 100) * reference.height;
				const textAlign = overlay.style.textAlign;
				const style: CSSProperties = {
					position: "absolute",
					left: `${(left / frameWidth) * 100}%`,
					top: `${(top / frameHeight) * 100}%`,
					width: `${(width / frameWidth) * 100}%`,
					height: `${(height / frameHeight) * 100}%`,
					boxSizing: "border-box",
					display: "flex",
					alignItems: "center",
					justifyContent:
						textAlign === "center" ? "center" : textAlign === "right" ? "flex-end" : "flex-start",
					padding: `${overlay.style.padding}px`,
					borderRadius: `${overlay.style.borderRadius}px`,
					backgroundColor: overlay.style.backgroundColor,
					color: overlay.style.color,
					fontFamily: overlay.style.fontFamily,
					fontSize: `${overlay.style.fontSize}px`,
					fontWeight: overlay.style.fontWeight,
					fontStyle: overlay.style.fontStyle,
					lineHeight: 1.15,
					textAlign,
					opacity: overlay.style.opacity,
					overflow: "hidden",
					whiteSpace: "pre-wrap",
					wordBreak: "break-word",
				};
				return (
					<div
						key={overlay.id}
						data-testid="video-overlay"
						data-overlay-id={overlay.id}
						data-overlay-type={overlay.type}
						style={style}
					>
						{overlay.text}
					</div>
				);
			})}
		</div>
	);
}
