/**
 * A cut-out puppet: the character drawn once in a rest pose, cut into parts,
 * and a bone for each moving limb. Every coordinate is in the rest drawing's
 * pixels, so the parts line up by construction and a pose only rotates them.
 *
 *   characters/<slug>/rig/rig.yaml   bones, parts and their images
 *   characters/<slug>/rig/*.png|svg  the parts (cut by SAM 3.1 or drawn)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { parse } from "yaml";
import { BONES, type Bone, type BodyFrame, type Vec } from "./pose.js";

export const PARENT: Record<Bone, Bone | null> = {
  torso: null,
  head: "torso",
  upperArmL: "torso",
  foreArmL: "upperArmL",
  upperArmR: "torso",
  foreArmR: "upperArmR",
  thighL: "torso",
  shinL: "thighL",
  thighR: "torso",
  shinR: "thighR",
};

export interface BoneSpec {
  /** The joint the bone turns around (for the torso: mid-hip). */
  pivot: Vec;
  /** The far end (for the torso: mid-shoulder; for the head: top of the head). */
  tip: Vec;
}

export interface PartSpec {
  name: string;
  bone: Bone;
  /** File next to rig.yaml. */
  image: string;
  /** Top-left of the image in the rest drawing. */
  at: Vec;
  /** Drawn size; defaults to the image's own size for SVG with width/height. */
  size: Vec;
  /** Paint order, low first. */
  z: number;
}

export interface Rig {
  name: string;
  dir: string;
  /** Rest drawing canvas. */
  size: Vec;
  bones: Record<Bone, BoneSpec>;
  parts: PartSpec[];
}

export class RigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RigError";
  }
}

export function loadRig(dir: string): Rig {
  const file = join(dir, "rig.yaml");
  if (!existsSync(file)) throw new RigError(`No rig at ${file}. Make one with: npm run dance -- rig <slug>`);
  return parseRig(readFileSync(file, "utf8"), dir);
}

export function parseRig(text: string, dir: string): Rig {
  const doc = parse(text) as Partial<Rig> & { parts?: Partial<PartSpec>[] };
  const vec = (v: unknown, where: string): Vec => {
    if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === "number")) throw new RigError(`${where} must be [x, y].`);
    return [v[0], v[1]];
  };
  const size = vec(doc.size, "size");
  const bones = {} as Record<Bone, BoneSpec>;
  for (const b of BONES) {
    const spec = doc.bones?.[b];
    if (!spec) throw new RigError(`bones.${b} is missing.`);
    bones[b] = { pivot: vec(spec.pivot, `bones.${b}.pivot`), tip: vec(spec.tip, `bones.${b}.tip`) };
  }
  const parts = (doc.parts ?? []).map((p, i): PartSpec => {
    if (!p.bone || !(BONES as readonly string[]).includes(p.bone)) throw new RigError(`parts[${i}].bone must be one of ${BONES.join(", ")}.`);
    if (!p.image) throw new RigError(`parts[${i}] needs an image.`);
    return { name: p.name ?? p.image, bone: p.bone, image: p.image, at: vec(p.at ?? [0, 0], `parts[${i}].at`), size: vec(p.size, `parts[${i}].size`), z: p.z ?? i };
  });
  if (!parts.length) throw new RigError("A rig needs at least one part.");
  return { name: doc.name ?? "puppet", dir, size, bones, parts };
}

/** Each part image as a data URL, read once. */
export function partImages(rig: Rig): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of rig.parts) {
    const path = join(rig.dir, p.image);
    if (!existsSync(path)) throw new RigError(`Part image ${path} is missing.`);
    const mime = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[extname(path).toLowerCase()];
    if (!mime) throw new RigError(`${p.image}: use PNG, JPEG, WebP or SVG.`);
    out.set(p.image, `data:${mime};base64,${readFileSync(path).toString("base64")}`);
  }
  return out;
}

export const rigDir = (charactersDir: string, slug: string) => join(charactersDir, slug, "rig");
export const rigRoot = (rig: Rig) => dirname(rig.dir);

// 2D affine matrices as [a, b, c, d, e, f], the SVG `matrix()` order.
export type Mat = [number, number, number, number, number, number];
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
export const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scale = (s: number): Mat => [s, 0, 0, s, 0, 0];
export const rotateAbout = ([x, y]: Vec, a: number): Mat => mul(translate(x, y), mul([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0], translate(-x, -y)));
export const apply = (m: Mat, [x, y]: Vec): Vec => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const restAngle = (b: BoneSpec) => Math.atan2(b.tip[1] - b.pivot[1], b.tip[0] - b.pivot[0]);

/** Wraps an angle into (-π, π]. */
export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export interface PoseOptions {
  /** Where the rest hips land on the stage, and the puppet's scale. */
  place: Mat;
  /** Body frame to follow; bones missing from `seen` keep their rest angle against the parent. */
  body: BodyFrame;
  seen?: Partial<Record<Bone, boolean>>;
  /** Mid-hip offset from the dancer's usual spot, already in stage pixels. */
  shift?: Vec;
  /** Limit for how far a bone may turn against its parent, radians. */
  limit?: Partial<Record<Bone, number>>;
}

/** World matrix of every bone for one pose. */
export function poseRig(rig: Rig, opts: PoseOptions): Record<Bone, Mat> {
  const abs = {} as Record<Bone, number>;
  const world = {} as Record<Bone, Mat>;
  for (const b of BONES) {
    const parent = PARENT[b];
    // The turn of this bone away from its rest direction, in absolute terms.
    let turn = opts.seen?.[b] === false ? (parent ? abs[parent] : 0) : wrapAngle(opts.body.angles[b] - restAngle(rig.bones[b]));
    if (parent) {
      const lim = opts.limit?.[b];
      let rel = wrapAngle(turn - abs[parent]);
      if (lim !== undefined) rel = Math.max(-lim, Math.min(lim, rel));
      turn = abs[parent] + rel;
      world[b] = mul(world[parent], rotateAbout(rig.bones[b].pivot, rel));
    } else {
      const [sx, sy] = opts.shift ?? [0, 0];
      world[b] = mul(translate(sx, sy), mul(opts.place, rotateAbout(rig.bones[b].pivot, turn)));
    }
    abs[b] = turn;
  }
  return world;
}

/** Matrix that puts the rest hips at stage point `at`, with the rest torso+legs `height` pixels tall. */
export function placement(rig: Rig, at: Vec, height: number): Mat {
  const s = height / rig.size[1];
  const [hx, hy] = rig.bones.torso.pivot;
  return mul(translate(at[0], at[1]), mul(scale(s), translate(-hx, -hy)));
}
