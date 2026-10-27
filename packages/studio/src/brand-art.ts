/**
 * Profile pictures and cover photos for every brand in channels.yaml.
 *
 * The series cover is an homage to a famous album-cover crosswalk shot, moved
 * indoors: the whole cast walks in single file across a zebra crossing
 * painted on the office aisle. Each character's own cover is the same shot
 * with that character crossing alone while the office watches. Avatars are a
 * head-and-shoulders portrait that reads inside a small circle; the series
 * avatar is all their heads peeking over a desk.
 *
 *   npm run studio -- brand-art [brand…] [--only avatar|cover] [--recrop] [--mock]
 *
 * Writes output/brand-art/<brand>/avatar.png (square, up to 1600 px), cover.png
 * (1640x624, Facebook), cover-title.png (the cover with the page name
 * lettered in the comic font), cover-raw.png (Muse's uncropped drawing, for
 * --recrop) and social/<network>/ with each network's upload sizes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { parse } from "yaml";
import { COMIC_FONT_PATH, composePanel, imageSize, svgToPng } from "@hoi-sau/svg-text";
import { characterRefs, type StudioContext } from "./episode.js";
import { generateSoftly, type Usage } from "./muse-image.js";
import { officePanelText } from "./office.js";
import { iconLine } from "./prompts.js";
import { styleReference, styleText } from "./style.js";
import { SERIES_DIR } from "./bible.js";

export const CHANNELS_FILE = fileURLToPath(new URL("../../../channels.yaml", import.meta.url));

export const COVER_SIZE = { width: 1640, height: 624 };
/** Largest avatar written; Muse draws about 1600 px square, which is kept without upscaling. */
export const AVATAR_SIZE = { width: 1600, height: 1600 };

/**
 * Upload sizes per network, written to <brand>/social/<network>/. Facebook
 * shows the profile picture at 196 px and wants at least 720 for sharp
 * screens; Instagram keeps 320 but takes 1080 and looks crisper for it;
 * Threads shows the Instagram picture unless a different one is uploaded
 * and has no cover. X wants a 400 px avatar and a 3:1 header, cropped again
 * from the drawing because it is narrower than the Facebook cover.
 */
export const SOCIAL_SIZES = {
  facebook: { avatar: { width: 720, height: 720 }, cover: COVER_SIZE },
  instagram: { avatar: { width: 1080, height: 1080 } },
  threads: { avatar: { width: 1080, height: 1080 } },
  x: { avatar: { width: 400, height: 400 }, cover: { width: 1500, height: 500 } },
} as const;

export interface BrandInfo {
  id: string;
  name: string;
  kind: "series" | "character";
  character?: string;
  tagline?: string;
}

export function loadBrandList(file = CHANNELS_FILE): BrandInfo[] {
  const doc = parse(readFileSync(file, "utf8")) as { brands?: BrandInfo[] };
  return (doc?.brands ?? []).map(({ id, name, kind, character, tagline }) => ({ id, name: name ?? id, kind, character, tagline }));
}

/** The director leads the line, then the first four; characters added later follow in name order. */
const WALK_ORDER = ["cay-muc", "te-te", "ca-noc", "cu-li", "sao-la"];

/** Everyone in the series, so a new character is on the next cover without touching this file. */
export function seriesCast(ctx: StudioContext): string[] {
  const rest = [...ctx.profiles.keys()].filter((s) => !WALK_ORDER.includes(s)).sort();
  return [...WALK_ORDER.filter((s) => ctx.profiles.has(s)), ...rest];
}

const COUNT = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const ORDINAL = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const count = (n: number) => COUNT[n] ?? String(n);

const NO_TEXT = "No text, no letters, no numbers, no logos, no speech bubbles.";

/** Covers are cropped to 1640x624 and Facebook's phone view trims the sides, so the action sits in a central band. */
const COVER_FRAME =
  "Full-length figures: every character is drawn whole from the top of the head to the feet, with the feet on the crossing and a strip of empty floor below them. Keep the characters small enough that all of them, head to feet, fit inside the middle band of the picture (between 30% and 75% of the height) and the central 80% of the width; above and below that band only simple ceiling and floor that can be cropped.";

function describe(ctx: StudioContext, slug: string, pose: string): string {
  const p = ctx.profiles.get(slug)!;
  return `${p.name} (${p.species}) ${pose}; keep exactly: ${p.look.signature.join("; ")}. ${iconLine(p)}`.trim();
}

export function coverPrompt(ctx: StudioContext, brand: BrandInfo): string {
  const cast = seriesCast(ctx);
  const n = count(cast.length);
  const office = ctx.office ? officePanelText(ctx.office, []) : "";
  const style = ctx.style ? styleText(ctx.style) : "";
  const scene =
    brand.kind === "series" || !brand.character
      ? [
          "Wide cover illustration, a playful homage to a famous album-cover shot of people crossing a zebra crossing in single file, moved inside an office.",
          "Side view, eye level, one-point perspective down the long office aisle. A white zebra crossing is painted across the aisle carpet.",
          `Exactly ${n} main characters walk across it in single file from left to right, evenly spaced, mid-stride, arms swinging. Each of the ${n} appears exactly once, never twice, and no other character is on the crossing. From front to back: ${cast.map((s, i) => describe(ctx, s, `${ORDINAL[i] ?? "next"} in line`)).join(" ")}`,
          "Desks with background coworkers on both sides of the aisle, some glancing up at the parade.",
        ]
      : [
          "Wide cover illustration, a playful homage to a famous album-cover crosswalk shot, moved inside an office.",
          "Side view, eye level, one-point perspective down the long office aisle. A white zebra crossing is painted across the aisle carpet.",
          `${describe(ctx, brand.character, "walks across it alone from left to right, mid-stride, proud and a little self-conscious, in the centre of the picture")}`,
          "Background coworkers at the desks on both sides lean out to watch and cheer.",
        ];
  return [...scene, office, COVER_FRAME, style ? `Style: ${style}` : "", "Bright, cheerful daylight from the windows.", NO_TEXT].filter(Boolean).join(" ");
}

export function avatarPrompt(ctx: StudioContext, brand: BrandInfo): string {
  const style = ctx.style ? styleText(ctx.style) : "";
  const circle = "It is a social media profile picture shown as a small circle: everything important sits in the central circle, big and simple, readable at thumbnail size.";
  const scene =
    brand.kind === "series" || !brand.character
      ? `The ${count(seriesCast(ctx).length)} coworkers peek over the edge of one office desk side by side, heads and paws only, big curious eyes, packed close together so every face stays big, in this order left to right: ${seriesCast(ctx)
          .map((s) => describe(ctx, s, "peeking"))
          .join(" ")} Plain soft butter-yellow background.`
      : `${describe(ctx, brand.character, "head and shoulders, facing the viewer, centred, a big friendly expression")} Plain soft background in a light tint of the character's own colours.`;
  return [scene, circle, style ? `Style: ${style}` : "", NO_TEXT].filter(Boolean).join(" ");
}

function refsFor(ctx: StudioContext, brand: BrandInfo): string[] {
  const slugs = brand.kind === "series" || !brand.character ? seriesCast(ctx) : [brand.character];
  // One model sheet per character keeps the request small; a solo brand also gets its pose sheet.
  const refs = slugs.flatMap((s) => (slugs.length > 1 ? characterRefs(ctx, s).slice(0, 1) : characterRefs(ctx, s)));
  const styleRef = styleReference(ctx.style, ctx.seriesDir ?? SERIES_DIR);
  return styleRef ? [styleRef, ...refs] : refs;
}

/**
 * Crops a drawing to the wide cover. Muse rarely keeps the cast in the band it
 * is asked for, so instead of the centre the crop keeps the most colourful
 * band: the characters are saturated, the office behind them is muted.
 */
export async function coverCrop(image: Buffer, size = COVER_SIZE): Promise<Buffer> {
  try {
    const meta = await sharp(image).metadata();
    const scaledH = Math.round((meta.height! * size.width) / meta.width!);
    if (scaledH <= size.height) return await fit(image, size);
    const W = 160;
    const H = Math.round((meta.height! * W) / meta.width!);
    const { data, info } = await sharp(image).resize(W, H, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const rows: number[] = [];
    for (let y = 0; y < H; y++) {
      let sum = 0;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * info.channels;
        sum += Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
      }
      rows.push(sum);
    }
    const win = Math.round((H * size.height) / scaledH);
    let best = 0;
    let bestScore = -1;
    let score = rows.slice(0, win).reduce((a, b) => a + b, 0);
    for (let top = 0; top + win <= H; top++) {
      if (top > 0) score += rows[top + win - 1] - rows[top - 1];
      // Ties go to the lower band: the cast stands on the floor.
      if (score >= bestScore) [best, bestScore] = [top, score];
    }
    const top = Math.min(scaledH - size.height, Math.round((best * scaledH) / H));
    return await sharp(image).resize(size.width, scaledH).extract({ left: 0, top, width: size.width, height: size.height }).png().toBuffer();
  } catch {
    return fit(image, size);
  }
}

async function fit(image: Buffer, size: { width: number; height: number }, enlarge = true): Promise<Buffer> {
  try {
    return await sharp(image).resize(size.width, size.height, { fit: "cover", position: "centre", withoutEnlargement: !enlarge }).png().toBuffer();
  } catch {
    return image;
  }
}

/** The cover with the page name and tagline lettered at the bottom right, clear of Facebook's profile picture on the left. */
export function titledCover(cover: Buffer, brand: BrandInfo): Buffer {
  const size = imageSize(cover);
  const w = size.width * 0.34;
  const h = size.height * 0.28;
  const lines = [
    {
      text: brand.name,
      bubble: { x: size.width * 0.62, y: size.height * 0.6, width: w, height: h * 0.62, shape: "rect" as const, draw: true },
      options: { fontPath: COMIC_FONT_PATH, maxFontSize: Math.round(size.height * 0.11), padding: 10 },
    },
    ...(brand.tagline
      ? [
          {
            text: brand.tagline,
            bubble: { x: size.width * 0.62, y: size.height * 0.6 + h * 0.62 + 8, width: w, height: h * 0.4, shape: "rect" as const, draw: true },
            options: { fontPath: COMIC_FONT_PATH, maxFontSize: Math.round(size.height * 0.045), padding: 6, strokeWidth: 3 },
          },
        ]
      : []),
  ];
  const { svg } = composePanel({ data: cover, ...size }, lines, { bubbleFill: "#fffdf6", strokeWidth: 4 });
  return svgToPng(svg);
}

export interface BrandArt {
  brand: string;
  avatar: string;
  cover: string;
  coverTitle: string;
}

export interface BrandArtOptions {
  /** Draw only one of the two pictures; the other is left as it is. */
  only?: "avatar" | "cover";
  /** Never ask Muse: crop the cover again from the last drawing (cover-raw.png) and rewrite the network sizes. */
  recrop?: boolean;
}

export async function makeBrandArt(
  ctx: StudioContext,
  brands: BrandInfo[],
  outDir: string,
  log: (s: string) => void = () => {},
  opts: BrandArtOptions = {},
): Promise<{ art: BrandArt[]; usage: Usage[] }> {
  const usage: Usage[] = [];
  const art: BrandArt[] = [];
  for (const b of brands) {
    if (b.kind === "character" && (!b.character || !ctx.profiles.has(b.character))) {
      log(`${b.id}: no character profile, skipped`);
      continue;
    }
    const dir = join(outDir, b.id);
    mkdirSync(dir, { recursive: true });
    const references = refsFor(ctx, b);
    if (opts.only !== "cover" && !opts.recrop) {
      log(`${b.id}: avatar`);
      const a = await generateSoftly(ctx.image, { prompt: avatarPrompt(ctx, b), size: "1024x1024", references }, log);
      if (a.usage) usage.push(a.usage);
      writeFileSync(join(dir, "avatar.png"), await fit(a.image, AVATAR_SIZE, false));
    }
    if (opts.only !== "avatar") {
      const rawFile = join(dir, "cover-raw.png");
      if (!opts.recrop) {
        log(`${b.id}: cover`);
        const c = await generateSoftly(ctx.image, { prompt: coverPrompt(ctx, b), size: "1536x1024", references }, log);
        if (c.usage) usage.push(c.usage);
        // The uncropped drawing, so a crop can be redone without drawing again.
        writeFileSync(rawFile, c.image);
      }
      // A cover drawn before the raw drawing was kept is only resized for the networks.
      if (existsSync(rawFile)) {
        const cover = await coverCrop(readFileSync(rawFile));
        writeFileSync(join(dir, "cover.png"), cover);
        writeFileSync(join(dir, "cover-title.png"), titledCover(cover, b));
      }
    }
    await writeSocial(dir, b);
    writeFileSync(join(dir, "prompts.json"), JSON.stringify({ avatar: avatarPrompt(ctx, b), cover: coverPrompt(ctx, b) }, null, 2));
    art.push({ brand: b.id, avatar: join(dir, "avatar.png"), cover: join(dir, "cover.png"), coverTitle: join(dir, "cover-title.png") });
  }
  return { art, usage };
}

/** Copies of the avatar and cover at each network's own upload size. */
async function writeSocial(dir: string, brand: BrandInfo): Promise<void> {
  for (const [network, sizes] of Object.entries(SOCIAL_SIZES)) {
    const out = join(dir, "social", network);
    mkdirSync(out, { recursive: true });
    const avatar = join(dir, "avatar.png");
    if (existsSync(avatar)) writeFileSync(join(out, "avatar.png"), await fit(readFileSync(avatar), sizes.avatar));
    if (!("cover" in sizes)) continue;
    const raw = join(dir, "cover-raw.png");
    const source = existsSync(raw) ? raw : join(dir, "cover.png");
    if (!existsSync(source)) continue;
    const cover = await coverCrop(readFileSync(source), sizes.cover);
    writeFileSync(join(out, "cover.png"), cover);
    writeFileSync(join(out, "cover-title.png"), titledCover(cover, brand));
  }
}

export const brandArtExists = (outDir: string, id: string) => existsSync(join(outDir, id, "cover.png"));
