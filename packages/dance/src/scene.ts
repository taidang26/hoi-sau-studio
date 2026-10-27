/**
 * The default stage: the source clip's composition kept. Each character takes
 * the place and size of the person it follows, so "one dances at the back,
 * one stands still in front" survives the swap.
 */

import { KP, type PoseFile, rankTracks, torsoLength, type Vec } from "./pose.js";
import type { Actor, Scene } from "./render.js";
import type { Rig } from "./rig.js";

export const STAGE: Vec = [1080, 1920];

export function keepComposition(file: PoseFile, rigs: Rig[], opts: { background?: string; size?: Vec; mirror?: boolean } = {}): Scene {
  const size = opts.size ?? STAGE;
  const s = Math.max(size[0] / file.width, size[1] / file.height);
  const ox = (size[0] - file.width * s) / 2;
  const oy = (size[1] - file.height * s) / 2;
  const ranked = rankTracks(file);
  if (ranked.length < rigs.length) throw new Error(`The clip has ${ranked.length} people the puppets can follow, not ${rigs.length}.`);
  const actors: Actor[] = rigs.map((rig, i) => {
    const track = ranked[i];
    const hips = track.frames
      .filter((p) => !!p)
      .map((p) => [(p![KP.leftHip][0] + p![KP.rightHip][0]) / 2, (p![KP.leftHip][1] + p![KP.rightHip][1]) / 2] as Vec);
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    let hx = med(hips.map((h) => h[0]));
    if (opts.mirror) hx = file.width - hx;
    const at: Vec = [ox + hx * s, oy + med(hips.map((h) => h[1])) * s];
    const rigTorso = Math.hypot(rig.bones.torso.tip[0] - rig.bones.torso.pivot[0], rig.bones.torso.tip[1] - rig.bones.torso.pivot[1]);
    const height = (torsoLength(track) * s * rig.size[1]) / rigTorso;
    return { rig, track: { id: track.id }, at, height, follow: 1, mirror: opts.mirror };
  });
  // Bigger on screen means nearer the camera: paint it last.
  actors.forEach((a) => (a.layer = a.height));
  return { size, background: opts.background ?? "#FFF4DE", actors };
}
