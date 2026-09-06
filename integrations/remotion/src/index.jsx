import React from "react";
import { Composition, registerRoot } from "remotion";
import { MegaComposition } from "./composition.jsx";

const defaultManifest = {
	schemaVersion: 1,
	mode: "animation",
	fps: 30,
	width: 1280,
	height: 720,
	allowRemoteAssets: false,
	durationInFrames: 180,
	scenes: [
		{
			id: "opening",
			durationInFrames: 180,
			background: "#0b1020",
			elements: [
				{
					type: "title",
					text: "MEGA RECORDER",
					subtitle: "Local motion, stable frames",
					x: 50,
					y: 42,
					align: "center",
				},
			],
			transition: { type: "none", durationInFrames: 0, direction: "from-right" },
		},
	],
};

function Root() {
	return (
		<Composition
			id="MegaRecorder"
			component={MegaComposition}
			defaultProps={{ manifest: defaultManifest }}
			fps={defaultManifest.fps}
			width={defaultManifest.width}
			height={defaultManifest.height}
			durationInFrames={defaultManifest.durationInFrames}
			calculateMetadata={({ props }) => {
				const manifest = props?.manifest ?? defaultManifest;
				return {
					fps: manifest.fps,
					width: manifest.width,
					height: manifest.height,
					durationInFrames: manifest.durationInFrames ?? defaultManifest.durationInFrames,
				};
			}}
		/>
	);
}

registerRoot(Root);
