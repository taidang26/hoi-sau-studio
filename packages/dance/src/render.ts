/**
 * Renders a dance: every actor is a rig following one person's track from
 * the pose file, frame for frame, so the moves stay on the music of the
 * source clip. Output is a silent 9:16 MP4; the trending sound is added in
 * the Instagram or Facebook app when posting (a licensed track cannot be
 * attached through the API).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { ffmpeg } from "@hoi-sau/motion";
import { BONES, type Bone, bodyFrame, cleanTrack, KP, type Pose, type PoseFile, type PoseTrack, rankTracks, torsoLength, type Vec } from "./pose.js";
import { type Mat, partImages, placement, poseRig, type Rig } from "./rig.js";

export interface Actor {
  rig: Rig;
  /** Which person to follow: an index into the tracks ranked by how much they move (0 = the dancer), or `{ id }`. */
  track?: number | { id: number };
  /** Stage point for the rest hips, and the puppet's height on stage. */
  at: Vec;
  height: number;
  /** Share of the dancer's travel across the frame the puppet keeps (0 = dances on the spot). */
  follow?: number;
  /** Mirror the dancer, so a move to their left becomes a move to the puppet's right. */
  mirror?: boolean;
  /** Paint order between actors, low first. */
  layer?: number;
}

export interface Scene {
  size: Vec;
  /** A colour, or a data URL / file path of an image that fills the frame. */
  background: string;
  actors: Actor[];
  /** Seconds to render from the start of the pose file; default all of it. */
  start?: number;
  duration?: number;
}

const LIMITS: Partial<Record<Bone, number>> = { head: 0.6, foreArmL: 2.9, foreArmR: 2.9, shinL: 2.6, shinR: 2.6 };

const SWAP: [number, number][] = [
  [KP.leftEye, KP.rightEye],
  [KP.leftEar, KP.rightEar],
  [KP.leftShoulder, KP.rightShoulder],
  [KP.leftElbow, KP.rightElbow],
  [KP.leftWrist, KP.rightWrist],
  [KP.leftHip, KP.rightHip],
  [KP.leftKnee, KP.rightKnee],
  [KP.leftAnkle, KP.rightAnkle],
];

export function mirrorPose(p: Pose, width: number): Pose {
  const out = p.map(([x, y, s]) => [width - x, y, s] as Pose[number]);
  for (const [a, b] of SWAP) [out[a], out[b]] = [out[b], out[a]];
  return out;
}

const ENDS: Record<Bone, [number, number][]> = {
  torso: [[KP.leftHip, KP.rightHip], [KP.leftShoulder, KP.rightShoulder]],
  head: [[KP.leftShoulder, KP.rightShoulder], [KP.leftEar, KP.rightEar]],
  upperArmL: [[KP.leftShoulder, KP.leftShoulder], [KP.leftElbow, KP.leftElbow]],
  foreArmL: [[KP.leftElbow, KP.leftElbow], [KP.leftWrist, KP.leftWrist]],
  upperArmR: [[KP.rightShoulder, KP.rightShoulder], [KP.rightElbow, KP.rightElbow]],
  foreArmR: [[KP.rightElbow, KP.rightElbow], [KP.rightWrist, KP.rightWrist]],
  thighL: [[KP.leftHip, KP.leftHip], [KP.leftKnee, KP.leftKnee]],
  shinL: [[KP.leftKnee, KP.leftKnee], [KP.leftAnkle, KP.leftAnkle]],
  thighR: [[KP.rightHip, KP.rightHip], [KP.rightKnee, KP.rightKnee]],
  shinR: [[KP.rightKnee, KP.rightKnee], [KP.rightAnkle, KP.rightAnkle]],
};

/** A bone is usable when the points at both its ends were ever seen. */
function seenBones(p: Pose): Record<Bone, boolean> {
  const seen = {} as Record<Bone, boolean>;
  for (const b of BONES) seen[b] = ENDS[b].flat().every((i) => p[i][2] > 0);
  // A head without ears still turns with the nose.
  if (!seen.head && p[KP.nose][2] > 0 && p[KP.leftShoulder][2] > 0) seen.head = true;
  return seen;
}

export function pickTrack(file: PoseFile, choice: Actor["track"] = 0): PoseTrack {
  if (typeof choice === "object") {
    const t = file.tracks.find((x) => x.id === choice.id);
    if (!t) throw new Error(`No track ${choice.id} in the pose file.`);
    return t;
  }
  const ranked = rankTracks(file);
  const t = ranked[choice];
  if (!t) throw new Error(`The pose file has ${ranked.length} usable people; track ${choice} does not exist.`);
  return t;
}

interface Prepared {
  actor: Actor;
  poses: Pose[];
  place: Mat;
  home: Vec;
  /** Stage pixels per source pixel of the dancer's body. */
  k: number;
  images: Map<string, string>;
}

function prepare(file: PoseFile, actor: Actor): Prepared {
  let track = pickTrack(file, actor.track);
  if (actor.mirror) track = { ...track, frames: track.frames.map((p) => (p ? mirrorPose(p, file.width) : null)) };
  const poses = cleanTrack(track);
  const hips = poses.map((p) => [(p[KP.leftHip][0] + p[KP.rightHip][0]) / 2, (p[KP.leftHip][1] + p[KP.rightHip][1]) / 2] as Vec);
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const home: Vec = [median(hips.map((h) => h[0])), median(hips.map((h) => h[1]))];
  const place = placement(actor.rig, actor.at, actor.height);
  const rigTorso = Math.hypot(actor.rig.bones.torso.tip[0] - actor.rig.bones.torso.pivot[0], actor.rig.bones.torso.tip[1] - actor.rig.bones.torso.pivot[1]);
  const k = ((rigTorso * actor.height) / actor.rig.size[1]) / (torsoLength(track) || 1);
  return { actor, poses, place, home, k, images: partImages(actor.rig) };
}

const fmt = (m: Mat) => m.map((n) => +n.toFixed(4)).join(" ");

function actorSvg(p: Prepared, frame: number): string {
  const pose = p.poses[Math.min(frame, p.poses.length - 1)];
  const body = bodyFrame(pose);
  const follow = p.actor.follow ?? 0.5;
  const shift: Vec = [(body.hips[0] - p.home[0]) * p.k * follow, (body.hips[1] - p.home[1]) * p.k];
  const world = poseRig(p.actor.rig, { place: p.place, body, seen: seenBones(pose), shift, limit: LIMITS });
  return [...p.actor.rig.parts]
    .sort((a, b) => a.z - b.z)
    .map((part) => `<g transform="matrix(${fmt(world[part.bone])})"><image href="${p.images.get(part.image)}" x="${part.at[0]}" y="${part.at[1]}" width="${part.size[0]}" height="${part.size[1]}"/></g>`)
    .join("");
}

export function frameSvg(scene: Scene, prepared: Prepared[], frame: number): string {
  const [w, h] = scene.size;
  const bg = /^(#|rgb|hsl)/.test(scene.background)
    ? `<rect width="${w}" height="${h}" fill="${scene.background}"/>`
    : `<image href="${scene.background}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>`;
  const actors = [...prepared].sort((a, b) => (a.actor.layer ?? 0) - (b.actor.layer ?? 0)).map((p) => actorSvg(p, frame));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg}${actors.join("")}</svg>`;
}

export interface RenderResult {
  video: string;
  frames: number;
  seconds: number;
}

export async function renderDance(file: PoseFile, scene: Scene, out: string, opts: { compare?: string; log?: (s: string) => void } = {}): Promise<RenderResult> {
  const prepared = scene.actors.map((a) => prepare(file, a));
  const first = Math.round((scene.start ?? 0) * file.fps);
  const count = Math.min(file.frameCount - first, scene.duration ? Math.round(scene.duration * file.fps) : Infinity);
  if (count <= 0) throw new Error("Nothing to render: start is past the end of the clip.");
  const work = mkdtempSync(join(tmpdir(), "dance-"));
  try {
    for (let i = 0; i < count; i++) {
      const png = new Resvg(frameSvg(scene, prepared, first + i), { fitTo: { mode: "original" } }).render().asPng();
      writeFileSync(join(work, `${String(i).padStart(5, "0")}.png`), png);
      if (opts.log && i % 60 === 0) opts.log(`frame ${i + 1}/${count}`);
    }
    mkdirSync(join(out, ".."), { recursive: true });
    const input = ["-framerate", String(file.fps), "-i", join(work, "%05d.png")];
    const encode = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart"];
    if (opts.compare) {
      // Side by side with the source, for checking the moves; never for posting.
      const [w, h] = scene.size;
      await ffmpeg([
        ...input,
        "-ss", String(scene.start ?? 0), "-t", String(count / file.fps), "-i", opts.compare,
        "-filter_complex", `[1:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=${file.fps}[src];[src][0:v]hstack=inputs=2,scale=${w}:-2[v]`,
        "-map", "[v]", "-an", ...encode, out,
      ]);
    } else {
      await ffmpeg([...input, "-an", ...encode, out]);
    }
    return { video: out, frames: count, seconds: count / file.fps };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export const loadPoses = (path: string): PoseFile => JSON.parse(readFileSync(path, "utf8")) as PoseFile;
