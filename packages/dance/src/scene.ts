/**
 * The default stage: the source clip's composition kept. Each character takes
 * the place and size of the person it follows, so "one dances at the back,
 * one stands still in front" survives the swap.
 */

import { coverage, KP, motionEnergy, type PoseFile, type PoseTrack, torsoLength, type Vec } from "./pose.js";
import type { Actor, Scene } from "./render.js";
import type { Rig } from "./rig.js";

export const STAGE: Vec = [1080, 1920];

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

function homeOf(track: PoseTrack): Vec {
  const hips = track.frames
    .filter((p) => !!p && p[KP.leftHip][2] > 0.3 && p[KP.rightHip][2] > 0.3)
    .map((p) => [(p![KP.leftHip][0] + p![KP.rightHip][0]) / 2, (p![KP.leftHip][1] + p![KP.rightHip][1]) / 2] as Vec);
  return [median(hips.map((h) => h[0])), median(hips.map((h) => h[1]))];
}

/**
 * Who the cast follows: first the person who moves most, then the biggest
 * (nearest) people left, skipping anyone standing where a chosen person
 * stands (a second track of the same body) and passers-by seen briefly.
 */
export function pickCast(file: PoseFile, count: number, ids?: number[]): PoseTrack[] {
  if (ids?.length) {
    return ids.map((id) => {
      const t = file.tracks.find((x) => x.id === id);
      if (!t) throw new Error(`No track ${id} in the pose file (have ${file.tracks.map((x) => x.id).join(", ")}).`);
      return t;
    });
  }
  const candidates = file.tracks.filter((t) => coverage(t) >= 0.4);
  if (candidates.length < count) throw new Error(`The clip has ${candidates.length} people seen long enough to follow, not ${count}.`);
  const chosen: PoseTrack[] = [[...candidates].sort((a, b) => motionEnergy(b) - motionEnergy(a))[0]];
  const bySize = [...candidates].sort((a, b) => torsoLength(b) - torsoLength(a));
  for (const t of bySize) {
    if (chosen.length >= count) break;
    if (chosen.includes(t)) continue;
    const h = homeOf(t);
    const clash = chosen.some((c) => {
      const ch = homeOf(c);
      return Math.hypot(h[0] - ch[0], h[1] - ch[1]) < 0.5 * Math.min(torsoLength(t), torsoLength(c));
    });
    if (!clash) chosen.push(t);
  }
  if (chosen.length < count) throw new Error(`Only ${chosen.length} separate people to follow; pass track ids with --tracks.`);
  return chosen;
}

/** Last frame up to which every chosen person is still seen, so an end card or cutaway is dropped. */
export function lastSteadyFrame(tracks: PoseTrack[]): number {
  const reversed = tracks.map((t) => ({ ...t, frames: [...t.frames].reverse() }));
  const n = Math.min(...tracks.map((t) => t.frames.length));
  return n - 1 - firstSteadyFrame(reversed);
}

/** First frame from which every chosen person is seen, so the dance does not start on a cutaway. */
export function firstSteadyFrame(tracks: PoseTrack[]): number {
  const n = Math.min(...tracks.map((t) => t.frames.length));
  const seen = (f: number) => tracks.every((t) => coverage({ id: t.id, frames: [t.frames[f]] }) === 1);
  // Twenty frames in a row, then a few more: right after a cut the detector is still unsure.
  for (let f = 0; f < n; f++) {
    let run = 0;
    for (let g = f; g < Math.min(n, f + 20); g++) if (seen(g)) run++;
    if (run >= Math.min(20, n - f)) return Math.min(n - 1, f + Math.min(6, Math.floor((n - f) / 4)));
  }
  return 0;
}

export interface CompositionOptions {
  background?: string;
  size?: Vec;
  mirror?: boolean;
  /** Track ids to follow, in cast order. */
  tracks?: number[];
  /**
   * lineup (default): every character the same height, side by side, in the
   * left-to-right order of the people they follow. keep: the clip's own
   * places and sizes, scaled up to fill the frame. exact: the clip as is.
   */
  layout?: "lineup" | "keep" | "exact";
}

/**
 * The default stage: the source clip's composition kept. Each character takes
 * the place and size of the person it follows, so "one dances at the back,
 * one stands still in front" survives the swap; then the whole group is
 * scaled to fill the 9:16 frame, since trend clips are often small or
 * letterboxed.
 */
export function keepComposition(file: PoseFile, rigs: Rig[], opts: CompositionOptions = {}): Scene {
  const size = opts.size ?? STAGE;
  const s = Math.max(size[0] / file.width, size[1] / file.height);
  const ox = (size[0] - file.width * s) / 2;
  const oy = (size[1] - file.height * s) / 2;
  const tracks = pickCast(file, rigs.length, opts.tracks);
  const actors: Actor[] = rigs.map((rig, i) => {
    const track = tracks[i];
    let [hx, hy] = homeOf(track);
    if (opts.mirror) hx = file.width - hx;
    const at: Vec = [ox + hx * s, oy + hy * s];
    const rigTorso = Math.hypot(rig.bones.torso.tip[0] - rig.bones.torso.pivot[0], rig.bones.torso.tip[1] - rig.bones.torso.pivot[1]);
    const height = (torsoLength(track) * s * rig.size[1]) / rigTorso;
    return { rig, track: { id: track.id }, at, height, follow: 1, mirror: opts.mirror };
  });
  const layout = opts.layout ?? "lineup";
  if (layout === "lineup") lineUp(actors, size);
  else if (layout === "keep") fitGroup(actors, size);
  // Bigger on screen means nearer the camera: paint it last.
  actors.forEach((a) => (a.layer = a.height));
  const first = firstSteadyFrame(tracks);
  const last = Math.max(first, lastSteadyFrame(tracks));
  return { size, background: opts.background ?? "#FFF4DE", actors, start: first / file.fps, duration: (last - first + 1) / file.fps };
}

/** Scales and moves the actors together so the group fills the frame, feet near the bottom. */
export function fitGroup(actors: Actor[], size: Vec): void {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const a of actors) {
    const k = a.height / a.rig.size[1];
    const [px, py] = a.rig.bones.torso.pivot;
    // The rest drawing's box around the hips, widened for arms swinging out.
    x0 = Math.min(x0, a.at[0] - px * k - a.height * 0.15);
    x1 = Math.max(x1, a.at[0] + (a.rig.size[0] - px) * k + a.height * 0.15);
    y0 = Math.min(y0, a.at[1] - py * k - a.height * 0.1);
    y1 = Math.max(y1, a.at[1] + (a.rig.size[1] - py) * k);
  }
  const scale = Math.min((size[0] * 0.92) / (x1 - x0), (size[1] * 0.86) / (y1 - y0));
  const cx = (x0 + x1) / 2;
  for (const a of actors) {
    a.at = [size[0] / 2 + (a.at[0] - cx) * scale, size[1] * 0.95 - (y1 - a.at[1]) * scale];
    a.height *= scale;
  }
}

/** Same height, side by side, keeping who stands left of whom; each dances around its own spot. */
export function lineUp(actors: Actor[], size: Vec): void {
  const order = [...actors].sort((a, b) => a.at[0] - b.at[0]);
  const slot = size[0] / order.length;
  order.forEach((a, i) => {
    const [px, py] = a.rig.bones.torso.pivot;
    void px;
    // Rest drawing about 70% of the frame tall for one character, less as more share the stage.
    // Narrow enough that swinging arms stay inside the slot; the empty top is room for a caption.
    const height = Math.min(size[1] * 0.55, (slot * 0.8 * a.rig.size[1]) / a.rig.size[0]);
    const k = height / a.rig.size[1];
    a.at = [slot * (i + 0.5), size[1] * 0.93 - (a.rig.size[1] - py) * k];
    a.height = height;
    a.follow = 0.35;
  });
}
