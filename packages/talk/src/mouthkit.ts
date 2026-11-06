/**
 * Bộ mồm: each character's mouth shapes, drawn once on a big clean portrait and
 * then pasted onto any picture, so a lip-sync picture costs no new drawing.
 *
 * Two angles (front, and turned three-quarters), six shapes each (shut, open,
 * wide, o, smile, teeth). A shape is an RGBA patch of the mouth cut by SAM 3.1
 * with its offset from the shut mouth's top centre, so it lands where the
 * picture's own mouth was, scaled to its width. When a picture's face is too
 * small, or the pasted pair fails the checks, the caller draws the mouth again
 * the old way (Muse Image edit of the face).
 *
 *   characters/<slug>/mouthkit/kit.json            angles, base mouth, shape offsets
 *   characters/<slug>/mouthkit/<angle>-<shape>.png  the patches; <angle>.png the portrait
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import type { Sam } from "@hoi-sau/dance";
import { characterRefs, CHARACTERS_DIR, designChanged, generateSoftly, noteDesign, type StudioContext } from "@hoi-sau/studio";
import { dilate, leadFeatures, mouthIn } from "./illustrate.js";
import { align, grow, maskBox, unionBox, type Box, type Raster } from "./patch.js";

export const KIT_SIZE = 1024;
export const ANGLES = ["front", "side"] as const;
export type Angle = (typeof ANGLES)[number];

export const SHAPES: Array<{ name: string; say: string }> = [
  { name: "shut", say: "" },
  { name: "open", say: "open it mid-word as if talking, clearly showing the dark inside of the mouth, no taller than it is wide, staying well below the nose" },
  { name: "wide", say: "open it wide as if shouting a loud 'A', showing the dark inside and the tongue, still below the nose with a gap of skin" },
  { name: "o", say: "round the lips into a small 'O' as if saying 'ô', a small dark oval, the corners pulled in, not smiling" },
  { name: "smile", say: "a closed happy smile, the corners turned up, lips together" },
  { name: "teeth", say: "a talking 'E' with the upper teeth showing in a flat wide opening" },
  { name: "laugh", say: "a big open laugh, the corners up high, the dark inside and the tongue showing, still below the nose" },
  { name: "cry", say: "a wailing open mouth turned down at the corners like a crying cartoon, the dark inside showing, still below the nose" },
  { name: "pout", say: "a trembling pout about to cry (mếu): lips pushed together, the corners pulled down in a wobbly line" },
  { name: "angry", say: "gritted teeth in an angry snarl, the corners pulled down, both rows of teeth showing" },
  { name: "shout", say: "an angry shout, the mouth open wide and square, the corners down, the dark inside showing, still below the nose" },
];

/**
 * The open shapes to try for a picture, from its mood (the shot's English act and pose): a sad face talks with
 * a crying mouth, an angry one shouts, a happy one laughs. Each list ends on the plain talking shapes.
 */
export function openShapes(text: string): string[] {
  const t = text.toLowerCase(), plain = ["wide", "open", "teeth"];
  if (/\b(cr(y|ies|ying)|tears?|sob|wail|sad|despair|defeated|miserable|upset|gloomy)\b/.test(t)) return ["cry", ...plain];
  if (/\b(angry|anger|furious|rage|shout|yell|scold|mad|annoyed|glare)/.test(t)) return ["shout", "angry", ...plain];
  if (/\b(laugh|happy|grin|joy|celebrat|cheer|excited|delighted|smug|smil)/.test(t)) return ["laugh", ...plain];
  return plain;
}

export interface KitShape { name: string; file: string; ox: number; oy: number; w: number; h: number }
export interface KitAngle {
  angle: Angle;
  /** The shut mouth of the portrait: its width, centre x and top y in kit pixels. */
  base: { w: number; cx: number; top: number };
  /** Where the nose sits from the mouth's centre, in mouth widths (+ = to the right): picks the angle and the mirroring. */
  nose: number;
  shapes: KitShape[];
}
export interface MouthKit { slug: string; angles: KitAngle[] }

export const kitDir = (charactersDir: string, slug: string) => join(charactersDir, slug, "mouthkit");

export function loadKit(charactersDir: string, slug: string): MouthKit | undefined {
  const f = join(kitDir(charactersDir, slug), "kit.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as MouthKit) : undefined;
}

/** Below this width (px in the 1080x1920 picture) a pasted mouth is too small to read; the old way draws it. */
export const KIT_MIN_MOUTH = 14;

/**
 * Which kit angle fits a picture, from where its nose sits over its mouth (in mouth widths):
 * near the middle is front, off to a side is the side angle, mirrored when it faces the other way.
 */
export function pickAngle(kit: MouthKit, nose: number | undefined): { angle: KitAngle; mirror: boolean } | undefined {
  const front = kit.angles.find((a) => a.angle === "front"), side = kit.angles.find((a) => a.angle === "side");
  if (nose === undefined || Math.abs(nose) < 0.2 || !side) return front ? { angle: front, mirror: false } : side ? { angle: side, mirror: false } : undefined;
  return { angle: side, mirror: Math.sign(nose) !== Math.sign(side.nose || 1) };
}

/** Nose offset from the mouth's centre in mouth widths, or undefined without a nose. */
export function noseOffset(mouth: Box, nose: Box | undefined): number | undefined {
  return nose ? (nose.x + nose.w / 2 - (mouth.x + mouth.w / 2)) / Math.max(1, mouth.w) : undefined;
}

/**
 * `base` with the mouth (grown `grow` px) filled with the median colour of a ring of skin around it,
 * leaving `keep` (nose, eyes) as drawn: the clean face a kit mouth is pasted on.
 */
export function eraseMouth(base: Raster, mouth: Uint8Array, growPx = 3, keep?: Uint8Array): Raster {
  const { width: w, height: h } = base;
  const hole = dilate(mouth, w, h, growPx), outer = dilate(mouth, w, h, growPx + 5);
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  for (let i = 0; i < hole.length; i++)
    if (outer[i] && !hole[i] && !keep?.[i]) { rs.push(base.data[i * 3]); gs.push(base.data[i * 3 + 1]); bs.push(base.data[i * 3 + 2]); }
  const med = (v: number[]) => (v.sort((a, b) => a - b)[v.length >> 1] ?? 0);
  const fill = [med(rs), med(gs), med(bs)];
  const out = Buffer.from(base.data);
  for (let i = 0; i < hole.length; i++) if (hole[i] && !keep?.[i]) for (let c = 0; c < 3; c++) out[i * 3 + c] = fill[c];
  return { data: out, width: w, height: h };
}

/** The median colour of a ring of skin around `mouth` (`grow`+1 to `grow`+6 px out), skipping `keep`. */
export function ringColour(img: Raster, mouth: Uint8Array, growPx = 3, keep?: Uint8Array): [number, number, number] {
  const { width: w, height: h } = img;
  const hole = dilate(mouth, w, h, growPx), outer = dilate(mouth, w, h, growPx + 6);
  const ch: number[][] = [[], [], []];
  for (let i = 0; i < hole.length; i++) if (outer[i] && !hole[i] && !keep?.[i]) for (let c = 0; c < 3; c++) ch[c].push(img.data[i * 3 + c]);
  return ch.map((v) => v.sort((a, b) => a - b)[v.length >> 1] ?? 0) as [number, number, number];
}

export const colourGap = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** How far the skin round a picture's mouth may be from the kit portrait's before the kit is not used: another character's face (Bino's dark fur) is far off. */
export const KIT_SKIN_GAP = 70;

/** The skin colour round the kit portrait's shut mouth, for one angle. */
export async function kitSkin(charactersDir: string, kit: MouthKit, angle: KitAngle): Promise<[number, number, number] | undefined> {
  const file = join(kitDir(charactersDir, kit.slug), `${angle.angle}.png`);
  if (!existsSync(file)) return undefined;
  const img = await rawOf(readFileSync(file), KIT_SIZE), n = KIT_SIZE, m = new Uint8Array(n * n);
  const x0 = Math.round(angle.base.cx - angle.base.w / 2), h = Math.max(4, Math.round(angle.base.w / 4));
  for (let y = angle.base.top; y < Math.min(n, angle.base.top + h); y++) for (let x = Math.max(0, x0); x < Math.min(n, x0 + angle.base.w); x++) m[y * n + x] = 1;
  return ringColour(img, m, 3);
}

/** Alpha-blends an RGBA patch onto `base` with its top-left at (x, y), never over `keep`. */
export function blendPatch(base: Raster, rgba: Buffer, pw: number, ph: number, x: number, y: number, keep?: Uint8Array): Raster {
  const { width: w, height: h } = base;
  const out = Buffer.from(base.data);
  for (let j = 0; j < ph; j++)
    for (let i = 0; i < pw; i++) {
      const tx = x + i, ty = y + j;
      if (tx < 0 || ty < 0 || tx >= w || ty >= h || keep?.[ty * w + tx]) continue;
      const p = (j * pw + i) * 4, a = rgba[p + 3] / 255;
      if (!a) continue;
      const k = (ty * w + tx) * 3;
      for (let c = 0; c < 3; c++) out[k + c] = Math.round(out[k + c] * (1 - a) + rgba[p + c] * a);
    }
  return { data: out, width: w, height: h };
}

/** Where a kit shape goes for a picture mouth `box`: the scale and top-left, mirrored about the mouth's centre when asked. */
export function placeShape(angle: KitAngle, shape: KitShape, box: Box, mirror: boolean): { s: number; x: number; y: number; w: number; h: number } {
  const s = box.w / angle.base.w;
  const ox = mirror ? -(shape.ox + shape.w) : shape.ox;
  const w = Math.max(1, Math.round(shape.w * s)), h = Math.max(1, Math.round(shape.h * s));
  return { s, x: Math.round(box.x + box.w / 2 + ox * s), y: Math.round(box.y + shape.oy * s), w, h };
}

/**
 * How far down (px) to move an open shape that lands too close to the nose.
 * The kit's "open" is often a thin slit, so the plain list in openShapes leads with "wide" (first try on Tũn).
 */
export const kitDrops = (mouthH: number) => [0, Math.max(2, Math.round(mouthH * 0.5)), Math.max(4, Math.round(mouthH))];

/** The picture with its mouth erased and the kit's `shape` pasted in its place. */
export async function pasteKit(charactersDir: string, kit: MouthKit, base: Raster, mouth: { mask: Uint8Array; box: Box }, shapeName: string, pick: { angle: KitAngle; mirror: boolean }, keep?: Uint8Array, drop = 0): Promise<Raster | undefined> {
  const shape = pick.angle.shapes.find((x) => x.name === shapeName);
  if (!shape) return undefined;
  const at = placeShape(pick.angle, shape, mouth.box, pick.mirror);
  let img = sharp(join(kitDir(charactersDir, kit.slug), shape.file)).ensureAlpha().resize(at.w, at.h, { fit: "fill" });
  if (pick.mirror) img = img.flop();
  const rgba = await img.raw().toBuffer();
  return blendPatch(eraseMouth(base, mouth.mask, 3, keep), rgba, at.w, at.h, at.x, at.y + drop, keep);
}

const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`;
const rawOf = async (png: Buffer, n: number): Promise<Raster> => ({ data: await sharp(png).resize(n, n, { fit: "cover" }).removeAlpha().raw().toBuffer(), width: n, height: n });

/** A mouth (0/1 mask, grown and feathered) cut out of `img` as an RGBA patch, with its box. */
async function cutPatch(img: Raster, mask: Uint8Array): Promise<{ png: Buffer; box: Box } | undefined> {
  const { width: w, height: h } = img;
  const hard = dilate(mask, w, h, 3);
  const box = maskBox(hard, w, h);
  if (!box) return undefined;
  const b = grow(box, 1, w, h, 0), rgba = Buffer.alloc(b.w * b.h * 4), r = 2;
  for (let y = 0; y < b.h; y++)
    for (let x = 0; x < b.w; x++) {
      const X = b.x + x, Y = b.y + y;
      let inside = 0, all = 0;
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { const xx = X + i, yy = Y + j; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; all++; inside += hard[yy * w + xx]; }
      const p = (y * b.w + x) * 4, k = (Y * w + X) * 3;
      rgba[p] = img.data[k]; rgba[p + 1] = img.data[k + 1]; rgba[p + 2] = img.data[k + 2]; rgba[p + 3] = Math.round((inside / all) * 255);
    }
  return { png: await sharp(rgba, { raw: { width: b.w, height: b.h, channels: 4 } }).png().toBuffer(), box: b };
}

/**
 * Draws the kit of one character: a big portrait per angle (mouth shut), then one Muse Image edit per
 * shape, each mouth found by SAM and cut out. `only` redraws those angles. About 12 images (~0.12 USD).
 */
export async function makeMouthKit(ctx: StudioContext, sam: Sam, slug: string, opts: { only?: Angle[]; log?: (s: string) => void } = {}): Promise<MouthKit> {
  const p = ctx.profiles.get(slug);
  if (!p) throw new Error(`No character "${slug}".`);
  const cdir = ctx.charactersDir ?? CHARACTERS_DIR, dir = kitDir(cdir, slug), n = KIT_SIZE;
  mkdirSync(dir, { recursive: true });
  const species = p.species.split("(")[0].trim();
  const kit: MouthKit = loadKit(cdir, slug) ?? { slug, angles: [] };
  const seg = (url: string) => (ph: string) => sam.segment(ph, url, n, n);
  const leadOf = async (url: string) => {
    const m = new Uint8Array(n * n);
    for (const ph of [`cartoon ${species}`, "cartoon character"]) {
      for (const f of (await sam.segment(ph, url, n, n)).filter((x) => (x.score ?? 1) >= 0.3)) for (let i = 0; i < m.length; i++) if (f.mask[i]) m[i] = 1;
      if (m.some((v) => v)) break;
    }
    return m;
  };
  // A changed design draws the whole kit again from new portraits.
  if (designChanged(dir, slug, cdir)) {
    opts.log?.(`${slug}: the design changed since the mouths were drawn; drawing the kit again`);
    opts = { ...opts, only: [...ANGLES] };
  }
  for (const angle of ANGLES) {
    const had = kit.angles.find((a) => a.angle === angle);
    if (!opts.only && had && SHAPES.every((x) => had.shapes.some((y) => y.name === x.name))) continue;
    if (opts.only && !opts.only.includes(angle)) continue;
    const view = angle === "front" ? "facing straight at the viewer" : "turned three-quarters to the viewer's right, the face still clearly visible";
    // A kit made before new shapes were added keeps its portrait and only draws the missing shapes.
    const keepOld = !opts.only && had && existsSync(join(dir, `${angle}.png`));
    if (!keepOld) opts.log?.(`${slug} ${angle}: portrait`);
    const portrait = keepOld ? { image: readFileSync(join(dir, `${angle}.png`)) } : await generateSoftly(ctx.image, {
      prompt: `A big head-and-shoulders portrait of ${p.name} (${species}), ${view}, calm face, the mouth closed in a simple line, the face large in the middle of the picture, plain light grey background, nothing else. Exactly the same character design, colours and line style as the references. No text.`,
      size: `${n}x${n}`,
      references: characterRefs(ctx, slug),
    }, opts.log);
    if (!keepOld) writeFileSync(join(dir, `${angle}.png`), portrait.image);
    const baseImg = await rawOf(portrait.image, n), baseUrl = dataUrl(portrait.image), lead = await leadOf(baseUrl);
    const shut = await mouthIn(seg(baseUrl), [`mouth of the cartoon ${species}`, "mouth"], lead, n, n);
    if (!shut) { opts.log?.(`${slug} ${angle}: no mouth found on the portrait; skipped`); continue; }
    const noseMask = leadFeatures(await sam.segment(`nose of the cartoon ${species}`, baseUrl, n, n), lead, n, n);
    const base = keepOld ? had!.base : { w: shut.box.w, cx: shut.box.x + shut.box.w / 2, top: shut.box.y };
    const entry: KitAngle = keepOld ? { ...had!, shapes: [...had!.shapes] } : { angle, base, nose: noseOffset(shut.box, maskBox(noseMask, n, n)) ?? 0, shapes: [] };
    for (const shape of SHAPES) {
      if (entry.shapes.some((x) => x.name === shape.name)) continue;
      let img = baseImg, mask = shut.mask;
      if (shape.say) {
        opts.log?.(`${slug} ${angle}: mouth ${shape.name}`);
        const res = await generateSoftly(ctx.image, {
          prompt: `Change only ${p.name}'s mouth: ${shape.say}. The mouth stays centred in the same place. Do not move the head, nose, eyes or anything else. Same background, colours and line style. No text.`,
          size: `${n}x${n}`,
          references: [baseUrl],
        }, opts.log).catch((e: Error) => { opts.log?.(`${slug} ${angle} ${shape.name}: not drawn (${e.message.slice(0, 120)})`); return undefined; });
        if (!res) continue;
        const edit = await rawOf(res.image, n), url = dataUrl(await sharp(edit.data, { raw: { width: n, height: n, channels: 3 } }).png().toBuffer());
        const found = await mouthIn(seg(url), [`mouth of the cartoon ${species}`, "mouth"], await leadOf(url), n, n);
        if (!found) { opts.log?.(`${slug} ${angle} ${shape.name}: no mouth found`); continue; }
        // The edit can drift a few pixels: measure the shape from where the face landed.
        const shift = align(baseImg, edit, grow(unionBox([shut.box, found.box])!, 1.6, n, n, 48));
        const moved = new Uint8Array(n * n);
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const sx = x - shift.dx, sy = y - shift.dy; if (sx >= 0 && sy >= 0 && sx < n && sy < n && found.mask[sy * n + sx]) moved[y * n + x] = 1; }
        const data = Buffer.alloc(n * n * 3);
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const sx = Math.min(n - 1, Math.max(0, x - shift.dx)), sy = Math.min(n - 1, Math.max(0, y - shift.dy)); edit.data.copy(data, (y * n + x) * 3, (sy * n + sx) * 3, (sy * n + sx) * 3 + 3); }
        img = { data, width: n, height: n };
        mask = moved;
      }
      const cut = await cutPatch(img, mask);
      if (!cut) continue;
      const file = `${angle}-${shape.name}.png`;
      writeFileSync(join(dir, file), cut.png);
      entry.shapes.push({ name: shape.name, file, ox: cut.box.x - base.cx, oy: cut.box.y - base.top, w: cut.box.w, h: cut.box.h });
    }
    kit.angles = [...kit.angles.filter((a) => a.angle !== angle), entry];
    writeFileSync(join(dir, "kit.json"), `${JSON.stringify(kit, null, 1)}\n`);
    opts.log?.(`${slug} ${angle}: ${entry.shapes.map((s) => s.name).join(", ")}`);
  }
  noteDesign(dir, slug, cdir);
  await kitSheet(cdir, slug);
  return kit;
}

/** Every shape of the kit on one sheet (portrait with the shape pasted on), for the owner to look over. */
export async function kitSheet(charactersDir: string, slug: string): Promise<string | undefined> {
  const kit = loadKit(charactersDir, slug), dir = kitDir(charactersDir, slug), t = 256;
  if (!kit?.angles.length) return undefined;
  const tiles: Array<{ input: Buffer; left: number; top: number }> = [];
  for (const [row, a] of kit.angles.entries()) {
    const portrait = join(dir, `${a.angle}.png`);
    if (!existsSync(portrait)) continue;
    const base = await rawOf(readFileSync(portrait), KIT_SIZE);
    const box: Box = { x: Math.round(a.base.cx - a.base.w / 2), y: a.base.top, w: a.base.w, h: 1 };
    for (const [col, sh] of a.shapes.entries()) {
      const rgba = await sharp(join(dir, sh.file)).ensureAlpha().raw().toBuffer();
      const at = placeShape(a, sh, box, false);
      // The shut mouth is drawn where it already is; the other shapes cover it (the sheet does not erase).
      const r = blendPatch(base, rgba, sh.w, sh.h, at.x, at.y);
      const crop = grow({ x: box.x, y: box.y, w: box.w, h: Math.max(1, a.base.w) }, 4, KIT_SIZE, KIT_SIZE, 200);
      tiles.push({ input: await sharp(r.data, { raw: { width: KIT_SIZE, height: KIT_SIZE, channels: 3 } }).extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h }).resize(t, t).png().toBuffer(), left: col * t, top: row * t });
    }
  }
  if (!tiles.length) return undefined;
  const out = join(dir, "sheet.jpg");
  await sharp({ create: { width: SHAPES.length * t, height: kit.angles.length * t, channels: 3, background: "#ffffff" } }).composite(tiles).jpeg({ quality: 85 }).toFile(out);
  return out;
}
