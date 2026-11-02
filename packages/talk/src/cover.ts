/**
 * TikTok cover for an illustrated clip: one of the clip's own pictures, the
 * clip's best line on a straight white badge (black border, black text, key
 * words in red) and under it a small "Hồi Sau" tag with the channel avatar.
 * No emoji, no tilt (Tài, 29/10).
 *
 * Everything sits in the part of the cover the TikTok grid shows and leaves
 * readable: the 3:4 centre crop (y 240–1680) less 80 px at the sides, the
 * bottom 12% of the crop (the ▷ view count) and the top-right corner (the
 * "Ghim"/multi-photo label). SAM 3.1 finds the faces; the badge goes below
 * them, else above them, else the next shot is tried.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import type { Sam } from "@hoi-sau/dance";
import type { StudioContext } from "@hoi-sau/studio";
import { COMIC_FONT_PATH, loadFont, measure, missingGlyphs, svgToPng, type LoadedFont } from "@hoi-sau/svg-text";
import { leadOr, maskOf, type Plan } from "./illustrate.js";
import { maskBox, type Box } from "./patch.js";
import { OUT } from "./timeline.js";

/** Where cover text may go on a 1080x1920 cover. */
export const COVER_SAFE = { x0: 80, x1: 1000, y0: 240, y1: 1507 };
/** The grid's "Ghim" / multi-photo label. */
export const COVER_PIN: Box = { x: 800, y: 240, w: 280, h: 180 };
/** Badge and tag sizes. */
export const COVER = { maxSize: 88, minSize: 60, gap: 12, padX: 56, padY: 42, tagGap: 34, tagH: 104, faceGap: 24, ink: "#141414", red: "#D61F1F" };

/** A line of the quote as plain and key-word runs: "được *tiền trọ*." */
export type Run = { text: string; key: boolean };

/** "“Đam mê không trả|được *tiền trọ*.”" → lines of runs ("|" breaks the line, *…* marks key words). */
export function parseQuote(quote: string): Run[][] {
  return quote.split("|").map((line) => {
    const runs: Run[] = [];
    line.trim().split("*").forEach((text, i) => text && runs.push({ text, key: i % 2 === 1 }));
    return runs;
  });
}

const plain = (lines: Run[][]) => lines.map((l) => l.map((r) => r.text).join("")).join("\n");

/** The badge text at the largest size whose widest line fits the safe width; the whole block (badge, gap, tag). */
export function fitQuote(lines: Run[][], font: LoadedFont): { size: number; lineH: number; badge: { w: number; h: number }; block: { w: number; h: number } } {
  const { maxSize, minSize, gap, padX, padY, tagGap, tagH } = COVER;
  const room = COVER_SAFE.x1 - COVER_SAFE.x0;
  let size = maxSize;
  const widest = (s: number) => Math.max(...lines.map((l) => measure(font, l.map((r) => r.text).join(""), s)));
  while (size > minSize && widest(size) + 2 * padX > room) size -= 2;
  const scale = size / font.font.unitsPerEm;
  const lineH = (font.font.ascender - font.font.descender) * scale;
  const badge = { w: widest(size) + 2 * padX, h: lineH * lines.length + gap * (lines.length - 1) + 2 * padY };
  return { size, lineH, badge, block: { w: badge.w, h: badge.h + tagGap + tagH } };
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Box, s = COVER_SAFE) => a.x >= s.x0 && a.x + a.w <= s.x1 && a.y >= s.y0 && a.y + a.h <= s.y1;

/**
 * Where the block (badge + tag) goes: centred, at the bottom of the safe zone
 * when that clears the faces, else just above the faces, else nowhere:
 * { problem } and the caller tries another shot.
 */
export function coverLayout(block: { w: number; h: number }, face: Box | undefined, safe = COVER_SAFE, pin = COVER_PIN): Box | { problem: string } {
  const x = (OUT.w - block.w) / 2;
  if (x < safe.x0) return { problem: `the badge is ${Math.round(block.w)} px wide, more than the ${safe.x1 - safe.x0} px the safe zone allows` };
  const at = (y: number): Box => ({ x, y, w: block.w, h: block.h });
  const ok = (b: Box) => inside(b, safe) && !overlaps(b, pin) && !(face && overlaps(b, face));
  for (const b of [at(safe.y1 - block.h), ...(face ? [at(face.y - COVER.faceGap - block.h)] : [])]) if (ok(b)) return b;
  return { problem: face ? "no room for the badge above or below the faces" : "the badge does not fit the safe zone" };
}

/** Why a cover would be wrong: missing glyphs or emoji in the text, outside the safe zone, on the pin corner, over a face. "" when fine. */
export function coverProblem(text: string, font: LoadedFont, block: Box, face?: Box): string {
  const emoji = [...text].filter((ch) => /\p{Extended_Pictographic}/u.test(ch));
  if (emoji.length) return `the cover text has emoji (${emoji.join(" ")}); covers take text only`;
  const missing = missingGlyphs(font, text);
  if (missing.length) return `the font has no glyph for ${missing.join(" ")}`;
  if (!inside(block)) return `the badge (${Math.round(block.x)},${Math.round(block.y)} ${Math.round(block.w)}x${Math.round(block.h)}) leaves the safe zone x ${COVER_SAFE.x0}–${COVER_SAFE.x1}, y ${COVER_SAFE.y0}–${COVER_SAFE.y1}`;
  if (overlaps(block, COVER_PIN)) return "the badge is under the grid's pin corner";
  if (face && overlaps(block, face)) return "the badge covers a face";
  return "";
}

const n = (v: number) => Math.round(v * 10) / 10;

/** The cover as SVG over `picture` (a PNG/JPEG data URL), the block at `at`. */
export function coverSvg(picture: string, lines: Run[][], at: Box, font: LoadedFont, avatar: string): string {
  const { size, lineH, badge } = fitQuote(lines, font);
  const { ink, red, gap, padY, tagGap, tagH } = COVER;
  const bx = (OUT.w - badge.w) / 2, by = at.y;
  const asc = font.font.ascender * (size / font.font.unitsPerEm);
  const text: string[] = [];
  lines.forEach((runs, i) => {
    let x = (OUT.w - measure(font, runs.map((r) => r.text).join(""), size)) / 2;
    const base = by + padY + i * (lineH + gap) + asc;
    for (const r of runs) {
      text.push(`<path d="${font.font.getPath(r.text, x, base, size, { kerning: true }).toPathData(2)}" fill="${r.key ? red : ink}"/>`);
      x += measure(font, r.text, size);
    }
  });
  const tagFont = 48, av = 80, pad = 12, label = "Hồi Sau";
  const tw = pad + av + 20 + measure(font, label, tagFont) + 34;
  const tx = (OUT.w - tw) / 2, ty = by + badge.h + tagGap;
  const shadow = (x: number, y: number, w: number, h: number, r: number) =>
    `<rect x="${n(x + 10)}" y="${n(y + 14)}" width="${n(w)}" height="${n(h)}" rx="${r}" fill="#000" fill-opacity="0.45" filter="url(#soft)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${OUT.w}" height="${OUT.h}" viewBox="0 0 ${OUT.w} ${OUT.h}">` +
    `<defs><filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="8"/></filter>` +
    `<clipPath id="av"><circle cx="${n(tx + pad + av / 2)}" cy="${n(ty + pad + av / 2)}" r="${av / 2}"/></clipPath></defs>` +
    `<image href="${picture}" xlink:href="${picture}" x="0" y="0" width="${OUT.w}" height="${OUT.h}" preserveAspectRatio="xMidYMid slice"/>` +
    shadow(bx, by, badge.w, badge.h, 44) +
    `<rect x="${n(bx)}" y="${n(by)}" width="${n(badge.w)}" height="${n(badge.h)}" rx="44" fill="#fff" stroke="${ink}" stroke-width="6"/>` +
    text.join("") +
    shadow(tx, ty, tw, tagH, tagH / 2) +
    `<rect x="${n(tx)}" y="${n(ty)}" width="${n(tw)}" height="${tagH}" rx="${tagH / 2}" fill="#fff" stroke="${ink}" stroke-width="5"/>` +
    `<image href="${avatar}" xlink:href="${avatar}" x="${n(tx + pad)}" y="${n(ty + pad)}" width="${av}" height="${av}" clip-path="url(#av)"/>` +
    `<circle cx="${n(tx + pad + av / 2)}" cy="${n(ty + pad + av / 2)}" r="${av / 2}" fill="none" stroke="${ink}" stroke-width="4"/>` +
    `<path d="${font.font.getPath(label, tx + pad + av + 20, ty + tagH / 2 + tagFont * 0.36, tagFont, { kerning: true }).toPathData(2)}" fill="${ink}"/>` +
    `</svg>`;
}

/** The safe-zone check picture: the cover with the 3:4 crop (green) and the zone, view-count band and pin corner (red). */
export function safeSvg(cover: string): string {
  const s = COVER_SAFE, p = COVER_PIN;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${OUT.w}" height="${OUT.h}">` +
    `<image href="${cover}" xlink:href="${cover}" width="${OUT.w}" height="${OUT.h}"/>` +
    `<g fill="none" stroke-width="6"><rect x="0" y="240" width="${OUT.w}" height="1440" stroke="#00c800" stroke-width="8"/>` +
    `<rect x="${s.x0}" y="${s.y0}" width="${s.x1 - s.x0}" height="${s.y1 - s.y0}" stroke="#e60000"/>` +
    `<rect x="0" y="${s.y1}" width="${OUT.w}" height="${1680 - s.y1}" stroke="#e60000"/>` +
    `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" stroke="#e60000"/></g></svg>`;
}

const dataUrl = (buf: Buffer, mime: string) => `data:${mime};base64,${buf.toString("base64")}`;

/** Faces in a picture (all characters), as one box; undefined when SAM finds none. */
export async function facesBox(sam: Sam, rgb: Uint8Array, species: string): Promise<Box | undefined> {
  const mask = await leadOr(await maskOf(sam, rgb, [`face of the cartoon ${species}`]), () => maskOf(sam, rgb, ["face of the cartoon character"]));
  return maskBox(mask, OUT.w, OUT.h);
}

/**
 * The cover of an illustrated clip: `<out>-bia.jpg` and the check `<out>-bia-safe.jpg`.
 * Tries `shot` first, then the plan's other shots, and stops at the first that leaves room.
 */
export async function makeCover(sam: Sam, ctx: StudioContext, plan: Plan, dir: string, quote: string, out: string, opts: { avatar: string; shot?: string; log?: (s: string) => void }): Promise<{ file: string; safe: string; shot: string }> {
  const font = loadFont(COMIC_FONT_PATH);
  const lines = parseQuote(quote);
  const problem = coverProblem(plain(lines), font, { x: COVER_SAFE.x0, y: COVER_SAFE.y0, w: 1, h: 1 });
  if (problem) throw new Error(problem);
  const species = (ctx.profiles.get(plan.slug)?.species ?? "character").split("(")[0].trim();
  const ids = plan.shots.map((s) => s.id);
  const order = opts.shot ? [opts.shot, ...ids.filter((i) => i !== opts.shot)] : ids;
  const avatar = dataUrl(await sharp(opts.avatar).resize(160, 160, { fit: "cover" }).png().toBuffer(), "image/png");
  for (const id of order) {
    const file = join(dir, `${id}.png`);
    if (!existsSync(file)) continue;
    const rgb = new Uint8Array(await sharp(file).resize(OUT.w, OUT.h, { fit: "cover" }).removeAlpha().raw().toBuffer());
    const face = await facesBox(sam, rgb, species);
    const at = coverLayout(fitQuote(lines, font).block, face);
    if ("problem" in at) { opts.log?.(`${id}: ${at.problem}`); continue; }
    const why = coverProblem(plain(lines), font, at, face);
    if (why) { opts.log?.(`${id}: ${why}`); continue; }
    const picture = dataUrl(await sharp(file).resize(OUT.w, OUT.h, { fit: "cover" }).png().toBuffer(), "image/png");
    const png = svgToPng(coverSvg(picture, lines, at, font, avatar));
    const coverFile = `${out}-bia.jpg`, safeFile = `${out}-bia-safe.jpg`;
    await sharp(png).jpeg({ quality: 92 }).toFile(coverFile);
    await sharp(svgToPng(safeSvg(dataUrl(png, "image/png")))).jpeg({ quality: 85 }).toFile(safeFile);
    opts.log?.(`${id}: cover ${coverFile} (badge at y ${Math.round(at.y)}–${Math.round(at.y + at.h)}${face ? `, faces y ${face.y}–${face.y + face.h}` : ""})`);
    return { file: coverFile, safe: safeFile, shot: id };
  }
  throw new Error("no shot leaves room for the cover badge; pass --shot or shorten the quote");
}
