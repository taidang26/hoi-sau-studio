/**
 * Cuts a rest drawing of a character into a puppet with SAM 3.1.
 *
 * SAM finds the whole character, its head, arms and legs by name. Each arm
 * and leg is split at its middle into two parts (upper arm and forearm, thigh
 * and shin) along its long axis; the torso is what is left. Joints come from
 * the same geometry, so no one places a pivot by hand. The drawing should be
 * front-on with gaps between the arms and the body and between the legs:
 * `rest` asks Muse Image for exactly that.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { stringify } from "yaml";
import type { Bone, Vec } from "./pose.js";
import type { Sam, Segment } from "./sam.js";

export type SamLike = Pick<Sam, "segment">;

export class CutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CutError";
  }
}

type Mask = Uint8Array;

export interface Img {
  width: number;
  height: number;
  /** RGBA */
  data: Buffer;
}

export async function readImage(file: string | Buffer): Promise<Img> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

const union = (masks: Mask[], n: number): Mask => {
  const out = new Uint8Array(n);
  for (const m of masks) for (let i = 0; i < n; i++) if (m[i]) out[i] = 1;
  return out;
};

/** Connected regions of a mask (4-neighbour), largest first. */
export function components(mask: Mask, width: number, height: number): Mask[] {
  const label = new Int32Array(mask.length);
  const regions: { mask: Mask; area: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    const m = new Uint8Array(mask.length);
    let area = 0;
    label[start] = regions.length + 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      m[i] = 1;
      area++;
      const x = i % width;
      const y = (i - x) / width;
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1]) {
        if (j >= 0 && mask[j] && !label[j]) {
          label[j] = regions.length + 1;
          stack.push(j);
        }
      }
    }
    regions.push({ mask: m, area });
  }
  return regions.sort((a, b) => b.area - a.area).map((r) => r.mask);
}

function pixels(mask: Mask, width: number): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) out.push([i % width, Math.floor(i / width)]);
  return out;
}

const centroid = (pts: Vec[]): Vec => {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
};

/** The long axis of a limb: its two ends, the one nearer `body` first, and each pixel's position along it (0 at the near end). */
export function limbAxis(mask: Mask, width: number, body: Vec): { near: Vec; far: Vec; along: (p: Vec) => number } {
  const pts = pixels(mask, width);
  if (pts.length < 20) throw new CutError("A limb is too small to rig.");
  const c = centroid(pts);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of pts) {
    sxx += (x - c[0]) ** 2;
    syy += (y - c[1]) ** 2;
    sxy += (x - c[0]) * (y - c[1]);
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const d: Vec = [Math.cos(theta), Math.sin(theta)];
  const proj = pts.map(([x, y]) => (x - c[0]) * d[0] + (y - c[1]) * d[1]).sort((a, b) => a - b);
  // Ends at the 2nd and 98th percentile, so a stray pixel does not move a joint.
  const lo = proj[Math.floor(proj.length * 0.02)];
  const hi = proj[Math.floor(proj.length * 0.98)];
  const a: Vec = [c[0] + d[0] * lo, c[1] + d[1] * lo];
  const b: Vec = [c[0] + d[0] * hi, c[1] + d[1] * hi];
  const nearIsA = Math.hypot(a[0] - body[0], a[1] - body[1]) <= Math.hypot(b[0] - body[0], b[1] - body[1]);
  const [near, far] = nearIsA ? [a, b] : [b, a];
  const len = Math.hypot(far[0] - near[0], far[1] - near[1]) || 1;
  const u: Vec = [(far[0] - near[0]) / len, (far[1] - near[1]) / len];
  return { near, far, along: ([x, y]) => ((x - near[0]) * u[0] + (y - near[1]) * u[1]) / len };
}

/** Grows a mask by `r` pixels, never outside `within`. Hides hairline seams between parts. */
export function dilate(mask: Mask, width: number, height: number, r: number, within: Mask): Mask {
  let cur = mask;
  for (let k = 0; k < r; k++) {
    const next = new Uint8Array(cur);
    for (let i = 0; i < cur.length; i++) {
      if (cur[i]) continue;
      const x = i % width;
      if ((x > 0 && cur[i - 1]) || (x < width - 1 && cur[i + 1]) || (i >= width && cur[i - width]) || (i + width < cur.length && cur[i + width])) next[i] = within[i];
    }
    cur = next;
  }
  void height;
  return cur;
}

const ink = (mask: Mask) => mask.reduce((n, v) => n + v, 0);

export interface CutPart {
  name: string;
  bone: Bone;
  mask: Mask;
  z: number;
}

export interface CutResult {
  bones: Record<Bone, { pivot: Vec; tip: Vec }>;
  parts: CutPart[];
}

/** Picks the `count` biggest separate regions SAM found for `phrase`. */
async function find(sam: SamLike, phrase: string, url: string, img: Img, count: number, within: Mask): Promise<Mask[]> {
  const segs: Segment[] = await sam.segment(phrase, url, img.width, img.height);
  const n = img.width * img.height;
  const all = union(segs.map((s) => s.mask), n);
  for (let i = 0; i < n; i++) all[i] &= within[i];
  const regions = components(all, img.width, img.height).filter((m) => ink(m) > n * 0.001);
  if (regions.length < count) throw new CutError(`SAM found ${regions.length} "${phrase}" region(s); the rig needs ${count}. Redraw the rest pose with clear gaps between limbs.`);
  return regions.slice(0, count);
}

const mean = (a: Vec, b: Vec): Vec => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** Segments a rest drawing into a rig. `opts.phrases` overrides the SAM prompts. */
export async function cutRig(sam: SamLike, image: Buffer, opts: { phrases?: Partial<Record<"body" | "head" | "arm" | "leg", string>> } = {}): Promise<{ img: Img; cut: CutResult }> {
  const img = await readImage(image);
  const { width, height } = img;
  const n = width * height;
  const url = `data:image/png;base64,${(await sharp(image).png().toBuffer()).toString("base64")}`;
  const ph = { body: "cartoon character", head: "head", arm: "arm", leg: "leg", ...opts.phrases };

  const everything = new Uint8Array(n).fill(1);
  const [body] = await find(sam, ph.body, url, img, 1, everything);
  const [head] = await find(sam, ph.head, url, img, 1, body);
  const notHead = body.map((v, i) => v & (head[i] ^ 1)) as Mask;
  const arms = await find(sam, ph.arm, url, img, 2, notHead);
  const notArms = notHead.map((v, i) => v & (arms[0][i] ^ 1) & (arms[1][i] ^ 1)) as Mask;
  const legs = await find(sam, ph.leg, url, img, 2, notArms);
  const rest = notArms.map((v, i) => v & (legs[0][i] ^ 1) & (legs[1][i] ^ 1)) as Mask;
  const [torso] = components(rest, width, height);
  if (!torso) throw new CutError("Nothing is left for the torso after taking the head, arms and legs.");

  const torsoC = centroid(pixels(torso, width));
  // The character faces us: its left side is on the image's right.
  const byX = (ms: Mask[]) => ms.map((m) => ({ m, c: centroid(pixels(m, width)) })).sort((a, b) => b.c[0] - a.c[0]);
  const [armL, armR] = byX(arms);
  const [legL, legR] = byX(legs);

  const bones = {} as CutResult["bones"];
  const parts: CutPart[] = [];
  const split = (limb: Mask, upper: Bone, lower: Bone, names: [string, string], z: number) => {
    const ax = limbAxis(limb, width, torsoC);
    const joint = mean(ax.near, ax.far);
    bones[upper] = { pivot: ax.near, tip: joint };
    bones[lower] = { pivot: joint, tip: ax.far };
    const up = new Uint8Array(n);
    const lo = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!limb[i]) continue;
      const t = ax.along([i % width, Math.floor(i / width)]);
      if (t <= 0.53) up[i] = 1;
      if (t >= 0.45) lo[i] = 1; // overlaps the upper part a little; drawn above it
    }
    // A disc of the drawing around the shoulder or hip goes with the upper part, drawn
    // behind the torso: when the limb swings out, it fills the gap at the joint.
    const len = Math.hypot(ax.far[0] - ax.near[0], ax.far[1] - ax.near[1]);
    const r = len * 0.22;
    for (let y = Math.max(0, Math.floor(ax.near[1] - r)); y <= Math.min(height - 1, Math.ceil(ax.near[1] + r)); y++)
      for (let x = Math.max(0, Math.floor(ax.near[0] - r)); x <= Math.min(width - 1, Math.ceil(ax.near[0] + r)); x++)
        if (Math.hypot(x - ax.near[0], y - ax.near[1]) <= r && body[y * width + x]) up[y * width + x] = 1;
    parts.push({ name: names[0], bone: upper, mask: up, z }, { name: names[1], bone: lower, mask: lo, z: z + 2 });
  };
  split(legR.m, "thighR", "shinR", ["thigh-r", "shin-r"], -1);
  split(legL.m, "thighL", "shinL", ["thigh-l", "shin-l"], -1);
  split(armR.m, "upperArmR", "foreArmR", ["upper-arm-r", "fore-arm-r"], 1);
  split(armL.m, "upperArmL", "foreArmL", ["upper-arm-l", "fore-arm-l"], 1);

  const hips = mean(bones.thighL.pivot, bones.thighR.pivot);
  const shoulders = mean(bones.upperArmL.pivot, bones.upperArmR.pivot);
  if (shoulders[1] >= hips[1]) throw new CutError("The shoulders came out below the hips; check the arm and leg masks.");
  bones.torso = { pivot: hips, tip: shoulders };
  const headPts = pixels(head, width);
  const top = headPts.reduce((m, p) => Math.min(m, p[1]), Infinity);
  const cx = centroid(headPts)[0];
  // The neck is where the head touches the torso, not the head's lowest pixel:
  // hanging ears, horns or hair would pull it down onto the chest.
  const torsoNear = dilate(torso, width, height, 4, everything);
  const touching = headPts.filter(([x, y]) => torsoNear[y * width + x]);
  const neck: Vec = touching.length >= 10 ? centroid(touching) : [cx, headPts.reduce((m, p) => Math.max(m, p[1]), -Infinity)];
  bones.head = { pivot: neck, tip: [cx, top] };

  // The torso keeps whatever SAM left between the parts, so nothing goes missing.
  const stray = rest.map((v, i) => v & (torso[i] ^ 1)) as Mask;
  parts.push({ name: "torso", bone: "torso", mask: union([torso, stray], n), z: 2 }, { name: "head", bone: "head", mask: head, z: 5 });
  for (const p of parts) p.mask = dilate(p.mask, width, height, 2, body);
  return { img, cut: { bones, parts } };
}

function nearEdge(mask: Mask, width: number, height: number, x: number, y: number, r: number): boolean {
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height || !mask[yy * width + xx]) return true;
    }
  return false;
}

/** Writes each part as a cropped transparent PNG, rig.yaml, and a check image with the joints marked. */
export async function writeCutRig(dir: string, name: string, img: Img, cut: CutResult): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const { width, height } = img;
  const parts = [];
  for (const p of cut.parts) {
    let [x0, y0, x1, y1] = [width, height, 0, 0];
    for (let i = 0; i < p.mask.length; i++) {
      if (!p.mask[i]) continue;
      const x = i % width;
      const y = (i - x) / width;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = (y0 + y) * width + (x0 + x);
        const d = (y * w + x) * 4;
        if (!p.mask[s]) continue;
        img.data.copy(rgba, d, s * 4, s * 4 + 4);
        if (nearEdge(p.mask, width, height, x0 + x, y0 + y, 3)) {
          // Paper-white pixels at a part's edge are background the mask caught: clear them, fade the near-white ones.
          const lo = Math.min(rgba[d], rgba[d + 1], rgba[d + 2]);
          if (lo > 225) rgba[d + 3] = Math.round(Math.max(0, Math.min(1, (250 - lo) / 25)) * rgba[d + 3]);
        }
      }
    await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toFile(join(dir, `${p.name}.png`));
    parts.push({ name: p.name, bone: p.bone, image: `${p.name}.png`, at: [x0, y0], size: [w, h], z: p.z });
  }
  const round = (v: Vec) => v.map((n) => Math.round(n));
  const bones = Object.fromEntries(Object.entries(cut.bones).map(([b, s]) => [b, { pivot: round(s.pivot), tip: round(s.tip) }]));
  writeFileSync(join(dir, "rig.yaml"), `# ${name}, cut from rest.png by SAM 3.1 (npm run dance -- cut). Joints can be nudged by hand.\n${stringify({ name, size: [width, height], bones, parts })}`);
  const dots = Object.values(cut.bones)
    .flatMap((s) => [s.pivot, s.tip])
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="9" fill="#ff2d55" stroke="#fff" stroke-width="3"/>`)
    .join("");
  const lines = Object.values(cut.bones)
    .map((s) => `<line x1="${s.pivot[0]}" y1="${s.pivot[1]}" x2="${s.tip[0]}" y2="${s.tip[1]}" stroke="#ff2d55" stroke-width="5"/>`)
    .join("");
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${lines}${dots}</svg>`);
  await sharp(img.data, { raw: { width, height, channels: 4 } }).composite([{ input: overlay }]).png().toFile(join(dir, "check.png"));
}
