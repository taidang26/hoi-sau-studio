/**
 * Profile pictures and cover photos for every brand in channels.yaml.
 *
 * The series cover is an homage to a famous album-cover crosswalk shot, moved
 * indoors: the whole cast walks in single file across a zebra crossing
 * painted on the office aisle. Each character's own cover is the same shot
 * with that character crossing alone while the office watches. Avatars are a
 * head-and-shoulders portrait that reads inside a small circle; the series
 * avatar is its lead character alone, one big face (six faces were too small
 * to read in a 40 px circle).
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

/** The face of the series on its profile picture. */
export const SERIES_FACE = "cu-li";

const COUNT = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const ORDINAL = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const count = (n: number) => COUNT[n] ?? String(n);

const NO_TEXT = "No text, no letters, no numbers, no logos, no speech bubbles.";

/** Covers are cropped to 1640x624 and Facebook's phone view trims the sides, so the action sits in a central band. */
const COVER_FRAME =
  "Extreme wide shot with the camera far back, like the original album photo taken from the middle of the road: the characters are small in the picture, each about one third of the picture height, drawn full length with their feet and shoes clearly visible on the crossing. The bottom quarter of the picture is empty aisle floor in front of their feet and the top quarter is ceiling and windows, so nothing important touches the top or bottom edge. Keep the whole line inside the central 80% of the width.";

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
          "Side view, eye level, one-point perspective down the long office aisle, seen from far away. A white zebra crossing is painted across the aisle carpet.",
          `Exactly ${n} main characters walk across it in single file from left to right, evenly spaced, mid-stride, arms swinging. All ${n} are standing and walking in the line, none sitting at a desk or left in the background; each appears exactly once, never twice, and no other character is on the crossing. Walking left to right means the front of the line is on the RIGHT side of the picture: the leader is the rightmost character, nearest the right edge, and the last in line is the leftmost. From the leader at the far right to the last on the left: ${cast.map((s, i) => describe(ctx, s, i === 0 ? "leading the line at the far right, in front of everyone" : `${ORDINAL[i] ?? "next"} in line, ${i === cast.length - 1 ? "last, at the far left" : "further left"}`)).join(" ")}`,
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
  const face = brand.kind === "series" || !brand.character ? seriesFace(ctx) : brand.character;
  const scene =
    brand.kind === "series" || !brand.character
      ? `${describe(ctx, face, "alone, a big close-up of the face filling most of the circle, peeking in from the bottom edge with paws on it, wide curious eyes looking straight at the viewer, one strong funny expression")} Nobody else in the picture. Plain soft butter-yellow background.`
      : `${describe(ctx, face, "head and shoulders, facing the viewer, centred, a big friendly expression")} Plain soft background in a light tint of the character's own colours.`;
  return [scene, circle, style ? `Style: ${style}` : "", NO_TEXT].filter(Boolean).join(" ");
}

const seriesFace = (ctx: StudioContext) => (ctx.profiles.has(SERIES_FACE) ? SERIES_FACE : seriesCast(ctx)[0]);

function refsFor(ctx: StudioContext, brand: BrandInfo, picture: "avatar" | "cover"): string[] {
  const series = brand.kind === "series" || !brand.character;
  const slugs = series ? (picture === "avatar" ? [seriesFace(ctx)] : seriesCast(ctx)) : [brand.character!];
  // One model sheet per character keeps the request small; a solo brand also gets its pose sheet.
  const refs = slugs.flatMap((s) => (slugs.length > 1 ? characterRefs(ctx, s).slice(0, 1) : characterRefs(ctx, s)));
  const styleRef = styleReference(ctx.style, ctx.seriesDir ?? SERIES_DIR);
  return styleRef ? [styleRef, ...refs] : refs;
}

/**
 * Crops a drawing to the wide cover. Muse rarely keeps the cast in the band it
 * is asked for, so the crop is anchored on the cast's feet: the lowest rows
 * with strongly coloured pixels (the cast is saturated; the floor and its
 * zebra stripes are not), plus a strip of floor, with the band above them.
 */
export async function coverCrop(image: Buffer, size: { width: number; height: number } = COVER_SIZE): Promise<Buffer> {
  try {
    const meta = await sharp(image).metadata();
    const scaledH = Math.round((meta.height! * size.width) / meta.width!);
    if (scaledH <= size.height) return await fit(image, size);
    const W = 160;
    const H = Math.round((meta.height! * W) / meta.width!);
    const { data, info } = await sharp(image).resize(W, H, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const strong: number[] = [];
    for (let y = 0; y < H; y++) {
      let n = 0;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * info.channels;
        if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 60) n++;
      }
      strong.push(n);
    }
    // Two coloured rows in a row, so a stray pixel on the floor does not count.
    let feet = -1;
    for (let y = H - 1; y > 0 && feet < 0; y--) if (strong[y] >= W * 0.04 && strong[y - 1] >= W * 0.04) feet = y;
    const win = (H * size.height) / scaledH;
    const bottom = feet < 0 ? (H + win) / 2 : Math.min(H, feet + 1 + H * 0.04);
    const top = Math.max(0, Math.min(scaledH - size.height, Math.round(((bottom - win) * scaledH) / H)));
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

/** The cover with the page name and tagline lettered at the top right, over the ceiling and clear of the cast below and of Facebook's profile picture at the bottom left. */
export function titledCover(cover: Buffer, brand: BrandInfo): Buffer {
  const size = imageSize(cover);
  const w = size.width * 0.34;
  const h = size.height * 0.28;
  const lines = [
    {
      text: brand.name,
      bubble: { x: size.width * 0.62, y: size.height * 0.06, width: w, height: h * 0.62, shape: "rect" as const, draw: true },
      options: { fontPath: COMIC_FONT_PATH, maxFontSize: Math.round(size.height * 0.11), padding: 10 },
    },
    ...(brand.tagline
      ? [
          {
            text: brand.tagline,
            bubble: { x: size.width * 0.62, y: size.height * 0.06 + h * 0.62 + 8, width: w, height: h * 0.4, shape: "rect" as const, draw: true },
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
    if (opts.only !== "cover" && !opts.recrop) {
      log(`${b.id}: avatar`);
      const a = await generateSoftly(ctx.image, { prompt: avatarPrompt(ctx, b), size: "1024x1024", references: refsFor(ctx, b, "avatar") }, log);
      if (a.usage) usage.push(a.usage);
      writeFileSync(join(dir, "avatar.png"), await fit(a.image, AVATAR_SIZE, false));
    }
    if (opts.only !== "avatar") {
      const rawFile = join(dir, "cover-raw.png");
      if (!opts.recrop) {
        log(`${b.id}: cover`);
        const c = await generateSoftly(ctx.image, { prompt: coverPrompt(ctx, b), size: "1536x1024", references: refsFor(ctx, b, "cover") }, log);
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
