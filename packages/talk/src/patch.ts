/**
 * Mouth and blink frames are Muse Image edits of a gesture picture. An edit
 * redraws the whole picture, so only the changed feature is taken from it:
 * the edit is lined up with the original around that feature and pasted in
 * through a soft-edged oval, leaving every other pixel of the gesture as is.
 */

import sharp from "sharp";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Raster {
  data: Buffer;
  width: number;
  height: number;
}

export async function readRgb(png: Buffer): Promise<Raster> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export const writePng = (r: Raster) => sharp(r.data, { raw: { width: r.width, height: r.height, channels: 3 } }).png().toBuffer();

/** Bounding box of a 0/1 mask the size of the image; undefined when empty. */
export function maskBox(mask: Uint8Array, width: number, height: number): Box | undefined {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (mask[y * width + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? undefined : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export const unionBox = (boxes: Box[]): Box | undefined => {
  if (!boxes.length) return undefined;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
};

/** `b` grown by `k` around its centre (at least `min` pixels a side), kept inside the image. */
export function grow(b: Box, k: number, width: number, height: number, min = 0): Box {
  const w = Math.max(min, b.w * k);
  const h = Math.max(min, b.h * k);
  const x = Math.max(0, Math.round(b.x + b.w / 2 - w / 2));
  const y = Math.max(0, Math.round(b.y + b.h / 2 - h / 2));
  return { x, y, w: Math.min(width - x, Math.round(w)), h: Math.min(height - y, Math.round(h)) };
}

const lum = (d: Buffer, i: number) => d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;

/**
 * Where the two pictures differ most, for when no detector is at hand: the
 * box around pixels that changed a lot, after lining the pictures up.
 */
export function changedBox(a: Raster, b: Raster, threshold = 60): Box | undefined {
  const mask = new Uint8Array(a.width * a.height);
  for (let i = 0, p = 0; p < mask.length; p++, i += 3) if (Math.abs(lum(a.data, i) - lum(b.data, i)) > threshold) mask[p] = 1;
  return maskBox(mask, a.width, a.height);
}

/** Mean luminance difference over `ring` minus `hole`, with `b` shifted by (dx, dy). */
function ringCost(a: Raster, b: Raster, ring: Box, hole: Box, dx: number, dy: number): number {
  let sum = 0, n = 0;
  for (let y = ring.y; y < ring.y + ring.h; y += 3) {
    const sy = y - dy;
    if (sy < 0 || sy >= b.height) continue;
    for (let x = ring.x; x < ring.x + ring.w; x += 3) {
      if (x >= hole.x && x < hole.x + hole.w && y >= hole.y && y < hole.y + hole.h) continue;
      const sx = x - dx;
      if (sx < 0 || sx >= b.width) continue;
      sum += Math.abs(lum(a.data, (y * a.width + x) * 3) - lum(b.data, (sy * b.width + sx) * 3));
      n++;
    }
  }
  return n ? sum / n : Infinity;
}

/** The shift of `b` that best lines it up with `a` around `hole`. */
export function align(a: Raster, b: Raster, hole: Box, reach = 16): { dx: number; dy: number; cost: number } {
  const ring = grow(hole, 2.2, a.width, a.height);
  // Every shift: flat-coloured drawings give a coarse search no slope to follow.
  let best = { dx: 0, dy: 0, cost: ringCost(a, b, ring, hole, 0, 0) };
  for (let dy = -reach; dy <= reach; dy++)
    for (let dx = -reach; dx <= reach; dx++) {
      const cost = ringCost(a, b, ring, hole, dx, dy);
      if (cost < best.cost) best = { dx, dy, cost };
    }
  return best;
}

/** `base` with the oval `box` of `from` (shifted by dx, dy) pasted in, its edge feathered. */
export function pasteOval(base: Raster, from: Raster, box: Box, dx = 0, dy = 0): Raster {
  const out = Buffer.from(base.data);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const rx = box.w / 2;
  const ry = box.h / 2;
  for (let y = box.y; y < box.y + box.h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= from.height) continue;
    for (let x = box.x; x < box.x + box.w; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= from.width) continue;
      const r = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
      // Solid inside 60% of the radius, fading to nothing at the edge.
      const a = r >= 1 ? 0 : r <= 0.6 ? 1 : 0.5 + 0.5 * Math.cos(((r - 0.6) / 0.4) * Math.PI);
      if (!a) continue;
      const i = (y * base.width + x) * 3;
      const j = (sy * from.width + sx) * 3;
      for (let c = 0; c < 3; c++) out[i + c] = Math.round(base.data[i + c] * (1 - a) + from.data[j + c] * a);
    }
  }
  return { data: out, width: base.width, height: base.height };
}

/** Lines `edit` up with `base` around `feature` and pastes that feature in. */
export function patchFeature(base: Raster, edit: Raster, feature: Box, k = 1.7): { image: Raster; box: Box; shift: { dx: number; dy: number } } {
  const box = grow(feature, k, base.width, base.height, 48);
  const shift = align(base, edit, box);
  return { image: pasteOval(base, edit, box, shift.dx, shift.dy), box, shift: { dx: shift.dx, dy: shift.dy } };
}

/**
 * Closes holes in a character cut-out (0/255 mask, changed in place): a region
 * the background cannot reach from the picture's edge is filled when its colour
 * is far from the background's, so a jacket SAM missed comes back while the
 * wall seen between an arm and the body stays out. Returns the pixels filled.
 */
export function fillHoles(mask: Uint8Array, img: Raster, minDistance = 40): number {
  const { width: w, height: h, data } = img;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!mask[i] && !seen[i]) {
      seen[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) push(x), push((h - 1) * w + x);
  for (let y = 0; y < h; y++) push(y * w), push(y * w + w - 1);
  const bg = [0, 0, 0];
  let nbg = 0;
  while (stack.length) {
    const i = stack.pop()!;
    for (let c = 0; c < 3; c++) bg[c] += data[i * 3 + c];
    nbg++;
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  if (nbg) for (let c = 0; c < 3; c++) bg[c] /= nbg;
  let filled = 0;
  for (let start = 0; start < w * h; start++) {
    if (mask[start] || seen[start]) continue;
    // One hole: collect it, then keep or fill it by its average colour.
    const hole: number[] = [];
    seen[start] = 1;
    stack.push(start);
    const sum = [0, 0, 0];
    while (stack.length) {
      const i = stack.pop()!;
      hole.push(i);
      for (let c = 0; c < 3; c++) sum[c] += data[i * 3 + c];
      const x = i % w;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (i >= w) push(i - w);
      if (i < w * (h - 1)) push(i + w);
    }
    const d = Math.hypot(...sum.map((s, c) => s / hole.length - bg[c]));
    if (d >= minDistance) {
      for (const i of hole) mask[i] = 255;
      filled += hole.length;
    }
  }
  return filled;
}
