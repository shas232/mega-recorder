import { Audio, Video } from "@remotion/media";
import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import React, { useMemo } from "react";
import {
	AbsoluteFill,
	interpolate,
	Sequence,
	spring,
	staticFile,
	useCurrentFrame,
	useVideoConfig,
} from "remotion";

const directionMap = {
	"from-left": "from-left",
	"from-right": "from-right",
	"from-top": "from-top",
	"from-bottom": "from-bottom",
};

const clamp01 = (value) => Math.max(0, Math.min(1, value));

function mediaSource(src) {
	return typeof src === "string" && src.startsWith("assets/") ? staticFile(src) : src;
}

function deriveAudioTimeline(manifest) {
	if (Array.isArray(manifest.audioTimeline)) return manifest.audioTimeline;
	let cursor = 0;
	const timeline = [];
	for (const scene of manifest.scenes ?? []) {
		for (const clip of scene.audio ?? [])
			timeline.push({ ...clip, startFrame: cursor + clip.startFrame });
		cursor += scene.durationInFrames - (scene.transition?.durationInFrames ?? 0);
	}
	return timeline;
}

function TitleCard({ element }) {
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	const entrance = spring({
		frame,
		fps,
		config: { damping: 200 },
		durationInFrames: Math.max(1, Math.round(fps * 0.8)),
	});
	const opacity = clamp01(interpolate(entrance, [0, 1], [0, 1]));
	const translateY = interpolate(entrance, [0, 1], [28, 0]);
	const align = element.align ?? "left";
	const horizontalTransform =
		align === "center"
			? "translateX(-50%)"
			: align === "right"
				? "translateX(-100%)"
				: "translateX(0)";
	return (
		<div
			style={{
				position: "absolute",
				left: `${element.x ?? 12}%`,
				top: `${element.y ?? 16}%`,
				transform: `${horizontalTransform} translateY(${translateY}px)`,
				opacity,
				width: "76%",
				textAlign: align,
				fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
				color: element.color ?? "#f8fafc",
			}}
		>
			<div
				style={{
					fontSize: "clamp(44px, 7vw, 96px)",
					lineHeight: 1.02,
					fontWeight: 800,
					letterSpacing: "-0.05em",
				}}
			>
				{element.text}
			</div>
			{element.subtitle ? (
				<div
					style={{
						marginTop: 24,
						color: element.accent ?? "#a5b4fc",
						fontSize: 28,
						fontWeight: 500,
					}}
				>
					{element.subtitle}
				</div>
			) : null}
		</div>
	);
}

function DiagramCard({ element }) {
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	const reveal = clamp01(
		interpolate(frame, [0, Math.max(1, Math.round(fps * 0.8))], [0, 1], {
			extrapolateRight: "clamp",
		}),
	);
	const x = element.x ?? 8;
	const y = element.y ?? 24;
	const width = element.width ?? 84;
	const height = element.height ?? 60;
	const nodesById = new Map(element.nodes.map((node) => [node.id, node]));
	return (
		<div
			style={{
				position: "absolute",
				left: `${x}%`,
				top: `${y}%`,
				width: `${width}%`,
				height: `${height}%`,
				opacity: reveal,
			}}
		>
			{element.title ? (
				<div style={{ color: "#e2e8f0", fontSize: 28, fontWeight: 700, marginBottom: 24 }}>
					{element.title}
				</div>
			) : null}
			<svg
				viewBox="0 0 100 100"
				preserveAspectRatio="none"
				style={{
					position: "absolute",
					inset: 0,
					width: "100%",
					height: "100%",
					overflow: "visible",
				}}
			>
				{(element.edges ?? []).map((edge, index) => {
					const from = nodesById.get(edge.from);
					const to = nodesById.get(edge.to);
					if (!from || !to) return null;
					return (
						<line
							key={`${edge.from}-${edge.to}-${index}`}
							x1={from.x}
							y1={from.y}
							x2={to.x}
							y2={to.y}
							stroke="#64748b"
							strokeWidth="0.8"
							strokeDasharray="2 2"
						/>
					);
				})}
			</svg>
			{element.nodes.map((node, index) => {
				const nodeReveal = clamp01(
					interpolate(reveal, [index / Math.max(1, element.nodes.length), 1], [0, 1], {
						extrapolateLeft: "clamp",
						extrapolateRight: "clamp",
					}),
				);
				return (
					<div
						key={node.id}
						style={{
							position: "absolute",
							left: `${node.x}%`,
							top: `${node.y}%`,
							transform: `translate(-50%, -50%) scale(${0.88 + nodeReveal * 0.12})`,
							opacity: nodeReveal,
							minWidth: 150,
							padding: "18px 22px",
							borderRadius: 18,
							background: node.color ?? "#1e293b",
							color: "#f8fafc",
							boxShadow: "0 16px 34px rgba(0,0,0,0.25)",
							textAlign: "center",
							fontSize: 24,
							fontWeight: 700,
							whiteSpace: "nowrap",
						}}
					>
						{node.label}
					</div>
				);
			})}
		</div>
	);
}

function Scene({ scene }) {
	return (
		<AbsoluteFill style={{ background: scene.background ?? "#0b1020", overflow: "hidden" }}>
			<AbsoluteFill
				style={{
					background:
						"radial-gradient(circle at 18% 10%, rgba(99,102,241,0.18), transparent 44%), radial-gradient(circle at 90% 80%, rgba(14,165,233,0.12), transparent 38%)",
				}}
			/>
			{scene.elements.map((element, index) => {
				if (element.type === "title") return <TitleCard key={`title-${index}`} element={element} />;
				if (element.type === "diagram")
					return <DiagramCard key={`diagram-${index}`} element={element} />;
				if (element.type === "video") {
					return (
						<Video
							key={`video-${index}`}
							src={mediaSource(element.src)}
							trimBefore={element.startFrom ?? 0}
							trimAfter={element.endAt}
							muted={element.muted}
							volume={element.volume}
							objectFit={element.fit ?? "contain"}
							style={{
								position: "absolute",
								inset: 0,
								width: "100%",
								height: "100%",
								opacity: element.opacity ?? 1,
							}}
						/>
					);
				}
				return null;
			})}
		</AbsoluteFill>
	);
}

export function MegaComposition({ manifest }) {
	const timeline = useMemo(() => deriveAudioTimeline(manifest), [manifest]);
	const sceneChildren = [];
	for (let index = 0; index < manifest.scenes.length; index += 1) {
		const scene = manifest.scenes[index];
		sceneChildren.push(
			<TransitionSeries.Sequence
				key={`scene-${scene.id}`}
				durationInFrames={scene.durationInFrames}
				name={scene.id}
			>
				<Scene scene={scene} />
			</TransitionSeries.Sequence>,
		);
		const transition = scene.transition;
		if (
			index < manifest.scenes.length - 1 &&
			transition &&
			transition.type !== "none" &&
			transition.durationInFrames > 0
		) {
			sceneChildren.push(
				<TransitionSeries.Transition
					key={`transition-${scene.id}`}
					timing={linearTiming({ durationInFrames: transition.durationInFrames })}
					presentation={
						transition.type === "fade"
							? fade()
							: slide({ direction: directionMap[transition.direction] ?? "from-right" })
					}
				/>,
			);
		}
	}
	return (
		<AbsoluteFill>
			<TransitionSeries>{sceneChildren}</TransitionSeries>
			{timeline.map((clip, index) => (
				<Sequence
					key={`audio-${clip.src}-${index}`}
					from={clip.startFrame}
					durationInFrames={clip.durationInFrames}
					name={`audio-${clip.sceneId ?? index}`}
				>
					<Audio
						src={mediaSource(clip.src)}
						trimBefore={clip.trimBefore ?? 0}
						volume={clip.volume ?? 1}
					/>
				</Sequence>
			))}
		</AbsoluteFill>
	);
}
