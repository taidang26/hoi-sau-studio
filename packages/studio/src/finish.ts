/**
 * The finishing pass on a drawn panel, like a camera with shallow focus:
 * the panel's main characters (and what they hold) stay sharp, everything
 * else softens more the further it is from them, then a light film grain and
 * a soft vignette. Background coworkers and props fall out of focus, so the
 * eye goes where the story is.
 *
 * SAM 3.1 finds each main character from a short look phrase built from its
 * profile ("animal in mustard yellow hoodie"); small inked shapes that touch
 * a character (a card in its fist, sweat drops) count as part of it.
 */

import sharp from "sharp";
import { generateSoftly, type MuseImage } from "./muse-image.js";
import type { Profile } from "./profile.js";

/** One object found in the picture, as a 0/1 mask over the whole image. */
export interface Segment {
  score?: number;
  width: number;
  height: number;
  mask: Uint8Array;
}

/** SAM 3.1 or anything shaped like it (Sam in @hoi-sau/dance). */
export interface Segmenter {
  segment(phrase: string, imageUrl: string, width: number, height: number): Promise<Segment[]>;
}

export interface FinishOptions {
  /** The panel's main characters, from its staging. */
  characters: Profile[];
  /** Things a character may be holding; kept sharp only where they touch one. */
  props?: string[];
  /** Grain strength, 0..1 of full range (0.03 is light). */
  grain?: number;
  /** Corner darkening, 0..1. */
  vignette?: number;
  log?: (s: string) => void;
}

export const DEFAULT_PROPS = ["cup", "laptop", "papers", "phone"];

const GARMENT = /\b((?:[a-z]+[- ]){1,3})(hoodie|suit|shirt|jacket|dress|sweater|blazer|vest|apron|cardigan|uniform|t-shirt|polo|coat|overalls)\b/i;
const COLOUR = /red|orange|yellow|mustard|gold|green|mint|teal|blue|navy|purple|lilac|violet|pink|white|black|grey|gray|brown|beige|cream|tan/i;
/** Plainer words SAM knows better ("lilac shirt" finds nothing, "purple shirt" does). */
const PLAIN_COLOUR: Record<string, string> = { lilac: "purple", violet: "purple", mustard: "yellow", gold: "yellow", mint: "green", teal: "green", navy: "blue", beige: "brown", cream: "white", tan: "brown", gray: "grey" };

/**
 * Short phrases SAM 3.1 finds a character by, best first. Long descriptions
 * and species names often find nothing; "animal in <colour> <garment>" does.
 * Hyphens are spaced out ("navy-blue" finds nothing, "navy blue" does).
 */
export function segmentPhrases(p: Profile): string[] {
  const out: string[] = [];
  const text = [p.look.description, ...(p.look.signature ?? [])].join(". ");
  const m = GARMENT.exec(text);
  if (m) {
    const colour = m[1].split(/[ ]+/).filter((w) => COLOUR.test(w)).join(" ");
    if (colour) {
      const exact = `animal in ${colour} ${m[2]}`.replace(/-/g, " ").toLowerCase();
      out.push(exact);
      // "mustard yellow" becomes "yellow yellow"; the repeat is dropped.
      const plain = exact.replace(/\b[a-z]+\b/g, (w) => PLAIN_COLOUR[w] ?? w).replace(/\b(\w+) \1\b/g, "$1");
      out.push(plain);
    }
  }
  const species = p.species.replace(/\(.*?\)/g, "").trim();
  if (species) out.push(species.replace(/-/g, " "));
  out.push("cartoon animal");
  return [...new Set(out)];
}

/** Things a character carries according to its icon ("the white cat in his arm"). */
export function heldPhrases(p: Profile): string[] {
  const icon = p.look.icon ?? "";
  return icon
    .split(/\band\b|,/)
    .map((s) => s.replace(/^\s*the\s+/i, "").trim())
    .filter((s) => /\b(in (?:his|her|their) arms?|holding|carr(?:y|ies)|on (?:his|her|their) shoulder)\b/i.test(s));
}

/** The recolour that matched the reference comics best (soft shading, one muted tone behind, light from the scene). */
export const RECOLOUR_PROMPT =
  "Recolour this exact comic panel, keeping every line, shape, character, pose and composition: soft airbrushed shading on the characters' round forms (gently darker towards the edges, soft highlight on top), warm blush on the cheeks, a limited palette, the background simplified to one muted flat tone that contrasts with the characters (or softly out of focus), gentle light coming from the light sources in the scene. No new objects, no text.";

const KEEP_FRAMING = "Exactly the same framing and crop as the reference: do not zoom in or crop; every character stays the same size, in the same place, fully in frame.";

/** Where the dark ink lines are: 1 per ink pixel, on a 320x400 grid. */
interface InkMap {
  w: number;
  h: number;
  ink: Uint8Array;
}

async function inkMap(png: Buffer): Promise<InkMap> {
  const w = 320, h = 400;
  const grey = await sharp(png).greyscale().resize(w, h, { fit: "fill" }).extractChannel(0).raw().toBuffer();
  return { w, h, ink: Uint8Array.from(grey, (v) => (v < 70 ? 1 : 0)) };
}

/** The ink inside a box of the map, pooled to 40x50 cells, zero-mean. */
function pooled(m: InkMap, x0: number, y0: number, bw: number, bh: number): number[] {
  const cols = 40, rows = 50, out = new Array<number>(cols * rows).fill(0);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const xa = Math.floor(x0 + (c * bw) / cols), xb = Math.max(xa + 1, Math.floor(x0 + ((c + 1) * bw) / cols));
      const ya = Math.floor(y0 + (r * bh) / rows), yb = Math.max(ya + 1, Math.floor(y0 + ((r + 1) * bh) / rows));
      let n = 0, sum = 0;
      for (let y = Math.max(0, ya); y < Math.min(m.h, yb); y++) for (let x = Math.max(0, xa); x < Math.min(m.w, xb); x++) (sum += m.ink[y * m.w + x]), n++;
      out[r * cols + c] = n ? sum / n : 0;
    }
  const mean = out.reduce((a, v) => a + v, 0) / out.length;
  return out.map((v) => v - mean);
}

const correlation = (a: number[], b: number[]) => {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) (ab += a[i] * b[i]), (aa += a[i] * a[i]), (bb += b[i] * b[i]);
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
};

/**
 * How far an edit zoomed into the original: the crop of `src` (centred, a
 * little up or down) whose line art best matches all of `out`. 1 is the
 * same framing; 1.2 means a sixth of each side was cut away.
 */
export async function framingZoom(src: Buffer, out: Buffer): Promise<number> {
  const a = await inkMap(src);
  const target = pooled(await inkMap(out), 0, 0, 320, 400);
  let best = { z: 1, score: -2 };
  for (let z = 1; z <= 1.31; z += 0.025)
    for (const dy of [-0.06, -0.03, 0, 0.03, 0.06]) {
      const bw = a.w / z, bh = a.h / z;
      const y0 = Math.max(0, Math.min(a.h - bh, (a.h - bh) / 2 + dy * a.h));
      const score = correlation(pooled(a, (a.w - bw) / 2, y0, bw, bh), target);
      if (score > best.score + 1e-9) best = { z: Math.round(z * 1000) / 1000, score };
    }
  return best.z;
}

/** The share of each side added as a plain margin before an edit, so a zoom eats the margin, not the picture. */
export const RECOLOUR_PAD = 0.08;

/** The panel inside a plain margin of its own average edge colour, same pixel size as the panel. */
export async function padPanel(png: Buffer, pad = RECOLOUR_PAD): Promise<Buffer> {
  const { width: w = 0, height: h = 0 } = await sharp(png).metadata();
  const { dominant } = await sharp(png).stats();
  const iw = Math.round(w / (1 + 2 * pad)), ih = Math.round(h / (1 + 2 * pad));
  const inner = await sharp(png).resize(iw, ih).png().toBuffer();
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: dominant.r, g: dominant.g, b: dominant.b } } })
    .composite([{ input: inner, left: Math.round((w - iw) / 2), top: Math.round((h - ih) / 2) }])
    .png()
    .toBuffer();
}

/**
 * Finds the original panel inside an edit of its padded copy (wherever the
 * edit moved or scaled it) and cuts it back out at the panel's size.
 */
export async function alignBack(src: Buffer, edited: Buffer): Promise<Buffer> {
  const { width: w = 0, height: h = 0 } = await sharp(src).metadata();
  const { width: ew = 0, height: eh = 0 } = await sharp(edited).metadata();
  const want = pooled(await inkMap(src), 0, 0, 320, 400);
  const m = await inkMap(edited);
  let best = { s: 1, x: 0, y: 0, score: -2 };
  // s is the box's share of the edit; the padded panel starts at 1/(1+2*pad) and grows if the edit zoomed in.
  for (let s = 0.7; s <= 1.0001; s += 0.01)
    for (let dx = -0.04; dx <= 0.0401; dx += 0.01)
      for (let dy = -0.04; dy <= 0.0401; dy += 0.01) {
        const bw = m.w * s, bh = m.h * s;
        const x0 = (m.w - bw) / 2 + dx * m.w, y0 = (m.h - bh) / 2 + dy * m.h;
        if (x0 < -0.5 || y0 < -0.5 || x0 + bw > m.w + 0.5 || y0 + bh > m.h + 0.5) continue;
        const score = correlation(pooled(m, x0, y0, bw, bh), want);
        if (score > best.score) best = { s, x: x0 / m.w, y: y0 / m.h, score };
      }
  const left = Math.max(0, Math.round(best.x * ew)), top = Math.max(0, Math.round(best.y * eh));
  const width = Math.min(ew - left, Math.round(best.s * ew)), height = Math.min(eh - top, Math.round(best.s * eh));
  return sharp(edited).extract({ left, top, width, height }).resize(w, h, { fit: "fill" }).png().toBuffer();
}

/**
 * Muse Image recolours a drawn panel. The panel goes in with a plain margin,
 * so if the edit zooms in it only loses margin; the panel is then found in
 * the result and cut back out. If it still came back zoomed (characters cut
 * off), it is tried once more, then the panel is kept as drawn.
 */
export async function recolourPanel(image: Pick<MuseImage, "generate">, png: Buffer, size: string, log?: (s: string) => void): Promise<{ image: Buffer; recoloured: boolean; zoom: number }> {
  const padded = await padPanel(png);
  let zoom = 1;
  for (let attempt = 0; attempt < 2; attempt++) {
    const edited = (await generateSoftly(image, { prompt: `${RECOLOUR_PROMPT} ${KEEP_FRAMING} Keep the plain margin around the picture.`, size, references: [dataUrl(padded)] }, log)).image;
    const out = await alignBack(png, edited);
    zoom = await framingZoom(png, out);
    if (zoom < 1.05) return { image: out, recoloured: true, zoom };
    log?.(`recolour came back zoomed about ${zoom}x; ${attempt ? "keeping the panel as drawn" : "trying again"}`);
  }
  return { image: png, recoloured: false, zoom };
}

const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`;

/** A 0/255 single-channel buffer blurred by `sigma`, still single-channel (sharp turns raw grey into RGB unless told). */
async function blurGrey(buf: Uint8Array, w: number, h: number, sigma: number): Promise<Buffer> {
  return sharp(Buffer.from(buf), { raw: { width: w, height: h, channels: 1 } }).blur(sigma).extractChannel(0).raw().toBuffer();
}

function pixelsOf(mask: Uint8Array): number {
  let n = 0;
  for (const v of mask) n += v ? 1 : 0;
  return n;
}

/**
 * Small inked shapes outside `focus` that touch it (within `near`), with their
 * insides filled: the card a fist holds, sweat drops by a head. Long lines
 * (desk edges) are left out by `maxSide`. Sets them in `focus`; returns how many.
 */
export function addTouchingInk(focus: Uint8Array, luma: Uint8Array, near: Uint8Array, w: number, h: number, maxSide = 160): number {
  const N = w * h;
  const ink = (i: number) => luma[i] < 80 && !focus[i];
  const seen = new Uint8Array(N);
  const add: number[] = [];
  let kept = 0;
  for (let start = 0; start < N; start++) {
    if (seen[start] || !ink(start)) continue;
    const stack = [start];
    const pix: number[] = [];
    seen[start] = 1;
    let touches = false;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    while (stack.length) {
      const i = stack.pop()!;
      pix.push(i);
      const x = i % w, y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (near[i] > 30) touches = true;
      if (x > 0 && !seen[i - 1] && ink(i - 1)) (seen[i - 1] = 1), stack.push(i - 1);
      if (x < w - 1 && !seen[i + 1] && ink(i + 1)) (seen[i + 1] = 1), stack.push(i + 1);
      if (y > 0 && !seen[i - w] && ink(i - w)) (seen[i - w] = 1), stack.push(i - w);
      if (y < h - 1 && !seen[i + w] && ink(i + w)) (seen[i + w] = 1), stack.push(i + w);
    }
    if (!touches || x1 - x0 > maxSide || y1 - y0 > maxSide || pix.length < 30) continue;
    // The inside is whatever in the box cannot be reached from the box edge without crossing this ink.
    const bw = x1 - x0 + 3, bh = y1 - y0 + 3;
    const wall = new Uint8Array(bw * bh);
    const outside = new Uint8Array(bw * bh);
    for (const i of pix) wall[(((i / w) | 0) - y0 + 1) * bw + ((i % w) - x0 + 1)] = 1;
    const q = [0];
    outside[0] = 1;
    while (q.length) {
      const k = q.pop()!;
      const kx = k % bw, ky = (k / bw) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = kx + dx, ny = ky + dy;
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const n2 = ny * bw + nx;
        if (!outside[n2] && !wall[n2]) (outside[n2] = 1), q.push(n2);
      }
    }
    for (let ky = 1; ky < bh - 1; ky++) for (let kx = 1; kx < bw - 1; kx++) if (!outside[ky * bw + kx]) add.push((ky - 1 + y0) * w + (kx - 1 + x0));
    kept++;
  }
  for (const i of add) focus[i] = 1;
  return kept;
}

/**
 * The finished picture from the panel and its focus mask (1 = sharp). Next
 * to the characters stays nearly sharp, then blur grows from sigma 3 to 8
 * with distance; grain and vignette go over everything.
 */
export async function applyFocus(png: Buffer, focus: Uint8Array, opts: { grain?: number; vignette?: number; seed?: number } = {}): Promise<Buffer> {
  const { width: w, height: h } = await sharp(png).metadata();
  if (!w || !h) throw new Error("finish: unreadable panel");
  const N = w * h;
  const solidSrc = Uint8Array.from(focus, (v) => (v ? 255 : 0));
  const closed = await blurGrey(solidSrc, w, h, 4);
  const solid = Uint8Array.from(closed, (v) => (v > 60 ? 255 : 0));
  const edge = await blurGrey(solid, w, h, 2.5);
  const ring = await blurGrey(solid, w, h, 45);
  const far = await blurGrey(solid, w, h, 120);
  let farMax = 1;
  for (const v of far) if (v > farMax) farMax = v;
  const rgb = await sharp(png).removeAlpha().raw().toBuffer();
  const b1 = await sharp(png).removeAlpha().blur(0.8).raw().toBuffer();
  const b3 = await sharp(png).removeAlpha().blur(3).raw().toBuffer();
  const b8 = await sharp(png).removeAlpha().blur(8).modulate({ saturation: 0.92 }).raw().toBuffer();
  const out = Buffer.alloc(N * 3);
  for (let i = 0; i < N; i++) {
    const a = edge[i] / 255;
    const near = Math.min(1, (ring[i] / 255) * 3.2);
    const d = 1 - Math.min(1, (far[i] / farMax) * 1.6);
    for (let c = 0; c < 3; c++) {
      const k = i * 3 + c;
      const back = b1[k] * near + (b3[k] * (1 - d) + b8[k] * d) * (1 - near);
      out[k] = Math.round(rgb[k] * a + back * (1 - a));
    }
  }
  // Seeded noise, so a rerun gives the same picture.
  let s = opts.seed ?? 7;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const amp = (opts.grain ?? 0.03) * 255 * 2.5;
  const noise = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) {
    const v = Math.max(0, Math.min(255, 128 + (rand() - 0.5) * 2 * amp));
    noise[i * 4] = noise[i * 4 + 1] = noise[i * 4 + 2] = v;
    noise[i * 4 + 3] = 255;
  }
  const vig = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><radialGradient id="v" cx="50%" cy="55%" r="75%"><stop offset="0.7" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#1e140c" stop-opacity="${opts.vignette ?? 0.2}"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#v)"/></svg>`;
  const base = await sharp(out, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  const grained = await sharp(base).composite([{ input: await sharp(noise, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(), blend: "soft-light" }]).png().toBuffer();
  return sharp(grained).composite([{ input: Buffer.from(vig) }]).png().toBuffer();
}

/** The whole pass: find the main characters, keep them and what they hold sharp, soften the rest. */
export async function finishPanel(png: Buffer, sam: Segmenter, opts: FinishOptions): Promise<{ image: Buffer; focusShare: number }> {
  const { width: w, height: h } = await sharp(png).metadata();
  if (!w || !h) throw new Error("finish: unreadable panel");
  const N = w * h;
  const url = dataUrl(png);
  const log = opts.log ?? (() => {});
  const focus = new Uint8Array(N);
  const take = (m: Uint8Array) => {
    for (let i = 0; i < N; i++) if (m[i]) focus[i] = 1;
  };
  for (const p of opts.characters) {
    let found = false;
    for (const phrase of segmentPhrases(p)) {
      // A match that is mostly a character already found (SAM calling the boss a "ferret badger") is not this one.
      const segs = (await sam.segment(phrase, url, w, h)).filter((sg) => {
        let n = 0, taken = 0;
        for (let i = 0; i < N; i++) if (sg.mask[i]) (n++, focus[i] && taken++);
        return n > 0 && taken / n < 0.5;
      });
      if (!segs.length) continue;
      // The main figure is the biggest match; small far-away look-alikes are background.
      const best = segs.reduce((a, b) => (pixelsOf(b.mask) > pixelsOf(a.mask) ? b : a));
      take(best.mask);
      log(`finish: ${p.name} found as "${phrase}" (${((pixelsOf(best.mask) / N) * 100).toFixed(1)}%)`);
      found = true;
      break;
    }
    if (!found) log(`finish: ${p.name} not found; left soft`);
    for (const phrase of heldPhrases(p)) {
      const segs = await sam.segment(phrase, url, w, h);
      if (segs.length) take(segs.reduce((a, b) => (pixelsOf(b.mask) > pixelsOf(a.mask) ? b : a)).mask);
    }
  }
  if (!pixelsOf(focus)) {
    log("finish: no main character found; panel left as drawn");
    return { image: png, focusShare: 0 };
  }
  // Props count only where they touch a character (within about 25 px).
  const near = await blurGrey(Uint8Array.from(focus, (v) => (v ? 255 : 0)), w, h, 12);
  for (const phrase of opts.props ?? DEFAULT_PROPS) {
    for (const s of await sam.segment(phrase, url, w, h)) {
      let n = 0, touch = 0;
      for (let i = 0; i < N; i++) if (s.mask[i]) (n++, near[i] > 20 && touch++);
      if (n && touch / n > 0.1) take(s.mask);
    }
  }
  const luma = await sharp(png).removeAlpha().greyscale().extractChannel(0).raw().toBuffer();
  const near4 = await blurGrey(Uint8Array.from(focus, (v) => (v ? 255 : 0)), w, h, 4);
  addTouchingInk(focus, luma, near4, w, h);
  return { image: await applyFocus(png, focus, opts), focusShare: pixelsOf(focus) / N };
}
