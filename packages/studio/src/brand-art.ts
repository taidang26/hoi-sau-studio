/**
 * Profile pictures and cover photos for every brand in channels.yaml.
 *
 * The series cover is an homage to a famous album-cover crosswalk shot, moved
 * indoors: the four coworkers walk in single file across a zebra crossing
 * painted on the office aisle. Each character's own cover is the same shot
 * with that character crossing alone while the office watches. Avatars are a
 * head-and-shoulders portrait that reads inside a small circle; the series
 * avatar is the four heads peeking over a desk.
 *
 *   npm run studio -- brand-art [brand…] [--mock]
 *
 * Writes output/brand-art/<brand>/avatar.png (square, up to 1600 px), cover.png
 * (1640x624, Facebook) and cover-title.png (the cover with the page name
 * lettered in the comic font).
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

/** The walking order across the crossing, front first. */
const WALK_ORDER = ["te-te", "ca-noc", "cu-li", "sao-la"];

const NO_TEXT = "No text, no letters, no numbers, no logos, no speech bubbles.";

/** Covers are cropped to 1640x624 and Facebook's phone view trims the sides, so the action sits in a central band. */
const COVER_FRAME =
  "Keep every character and the crossing inside the middle band of the picture (between 30% and 70% of the height) and inside the central 80% of the width; above and below that band only simple ceiling and floor that can be cropped.";

function describe(ctx: StudioContext, slug: string, pose: string): string {
  const p = ctx.profiles.get(slug)!;
  return `${p.name} (${p.species}) ${pose}; keep exactly: ${p.look.signature.join("; ")}. ${iconLine(p)}`.trim();
}

export function coverPrompt(ctx: StudioContext, brand: BrandInfo): string {
  const cast = WALK_ORDER.filter((s) => ctx.profiles.has(s));
  const office = ctx.office ? officePanelText(ctx.office, []) : "";
  const style = ctx.style ? styleText(ctx.style) : "";
  const scene =
    brand.kind === "series" || !brand.character
      ? [
          "Wide cover illustration, a playful homage to a famous album-cover shot of four people crossing a zebra crossing, moved inside an office.",
          "Side view, eye level, one-point perspective down the long office aisle. A white zebra crossing is painted across the aisle carpet.",
          `Exactly four main characters walk across it in single file from left to right, evenly spaced, mid-stride, arms swinging. Each of the four appears exactly once, never twice, and no other character is on the crossing. From front to back: ${cast.map((s, i) => describe(ctx, s, `${["first", "second", "third", "fourth"][i] ?? "next"} in line`)).join(" ")}`,
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
      ? `The four coworkers peek over the edge of one office desk side by side, heads and paws only, big curious eyes, in this order left to right: ${WALK_ORDER.filter((s) => ctx.profiles.has(s))
          .map((s) => describe(ctx, s, "peeking"))
          .join(" ")} Plain soft butter-yellow background.`
      : `${describe(ctx, brand.character, "head and shoulders, facing the viewer, centred, a big friendly expression")} Plain soft background in a light tint of the character's own colours.`;
  return [scene, circle, style ? `Style: ${style}` : "", NO_TEXT].filter(Boolean).join(" ");
}

function refsFor(ctx: StudioContext, brand: BrandInfo): string[] {
  const slugs = brand.kind === "series" || !brand.character ? WALK_ORDER.filter((s) => ctx.profiles.has(s)) : [brand.character];
  // One model sheet per character keeps the request small; a solo brand also gets its pose sheet.
  const refs = slugs.flatMap((s) => (slugs.length > 1 ? characterRefs(ctx, s).slice(0, 1) : characterRefs(ctx, s)));
  const styleRef = styleReference(ctx.style, ctx.seriesDir ?? SERIES_DIR);
  return styleRef ? [styleRef, ...refs] : refs;
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

export async function makeBrandArt(ctx: StudioContext, brands: BrandInfo[], outDir: string, log: (s: string) => void = () => {}): Promise<{ art: BrandArt[]; usage: Usage[] }> {
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
    log(`${b.id}: avatar`);
    const a = await generateSoftly(ctx.image, { prompt: avatarPrompt(ctx, b), size: "1024x1024", references }, log);
    log(`${b.id}: cover`);
    const c = await generateSoftly(ctx.image, { prompt: coverPrompt(ctx, b), size: "1536x1024", references }, log);
    usage.push(...[a.usage, c.usage].filter((u): u is Usage => Boolean(u)));
    const avatar = await fit(a.image, AVATAR_SIZE, false);
    const cover = await fit(c.image, COVER_SIZE);
    writeFileSync(join(dir, "avatar.png"), avatar);
    writeFileSync(join(dir, "cover.png"), cover);
    writeFileSync(join(dir, "cover-title.png"), titledCover(cover, b));
    writeFileSync(join(dir, "prompts.json"), JSON.stringify({ avatar: avatarPrompt(ctx, b), cover: coverPrompt(ctx, b) }, null, 2));
    art.push({ brand: b.id, avatar: join(dir, "avatar.png"), cover: join(dir, "cover.png"), coverTitle: join(dir, "cover-title.png") });
  }
  return { art, usage };
}

export const brandArtExists = (outDir: string, id: string) => existsSync(join(outDir, id, "cover.png"));
