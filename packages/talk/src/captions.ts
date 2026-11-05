/**
 * Burnt-in text, CapCut style: the spoken words a few at a time, white with
 * a black outline, the word being said in yellow; and a fixed title band at
 * the top. No motion on the text.
 */

import sharp from "sharp";
import { BOLD_FONT_PATH, escapeXml, loadFont, measure, svgToPng } from "@hoi-sau/svg-text";
import type { Chunk } from "./timeline.js";
import { OUT, SAFE, SAFE_CX } from "./timeline.js";

/** All bands sit inside the platforms' safe area (SAFE): nothing is covered by their buttons or caption block. */
export const TITLE_BAND = { y: SAFE.top, h: 180 };
/** Over the desk in the vlogger shot, just above the platforms' bottom block. */
export const CAPTION_BAND = { y: SAFE.bottom - 220, h: 220 };
/** On a backdrop the character stands in the middle, so the words go right under the title, above its head. */
export const CAPTION_ON_BACKDROP = { y: TITLE_BAND.y + TITLE_BAND.h, h: 200 };
const TEXT_W = SAFE.right - SAFE.left - 40;

export interface Overlay {
  data: Buffer;
  width: number;
  height: number;
  top: number;
}

const FONT = () => escapeXml(loadFont(BOLD_FONT_PATH).family);

async function rgba(svg: string, top: number): Promise<Overlay> {
  const { data, info } = await sharp(svgToPng(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, top };
}

export function captionSvg(chunk: Chunk, current: number): string {
  const font = loadFont(BOLD_FONT_PATH);
  const words = chunk.words.map((w) => w.text.replace(/[,;:.!?…]+$/, "")).filter(Boolean);
  let size = 66;
  const space = () => size * 0.28;
  const width = () => words.reduce((n, w) => n + measure(font, w, size), 0) + space() * (words.length - 1);
  while (width() > TEXT_W && size > 40) size -= 2;
  const total = width();
  let x = SAFE_CX - total / 2;
  const cy = 110;
  const spans = words.map((w, i) => {
    const t = `<text x="${x.toFixed(1)}" y="${(cy + size * 0.36).toFixed(1)}" font-family="${FONT()}" font-weight="700" font-size="${size}" fill="${i === current ? "#FFE14D" : "#FFFFFF"}" stroke="#111111" stroke-width="${(size * 0.14).toFixed(1)}" stroke-linejoin="round" paint-order="stroke">${escapeXml(w)}</text>`;
    x += measure(font, w, size) + space();
    return t;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT.w}" height="220">${spans.join("")}</svg>`;
}

export function wrapTitle(text: string, size: number, maxWidth: number): string[] {
  const font = loadFont(BOLD_FONT_PATH);
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && measure(font, next, size) > maxWidth) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Two lines of about equal width, so one word never hangs alone on the second line. */
function balanceTwo(text: string, size: number, font: ReturnType<typeof loadFont>): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  let best = [words.join(" ")], widest = Infinity;
  for (let i = 1; i < words.length; i++) {
    const pair = [words.slice(0, i).join(" "), words.slice(i).join(" ")];
    const w = Math.max(...pair.map((l) => measure(font, l, size)));
    if (w < widest) (widest = w), (best = pair);
  }
  return best;
}

export function titleSvg(title: string): string {
  const font = loadFont(BOLD_FONT_PATH);
  let size = 48;
  let lines = wrapTitle(title, size, TEXT_W - 40);
  while (lines.length > 2 && size > 34) lines = wrapTitle(title, (size -= 4), TEXT_W - 40);
  if (lines.length === 2) lines = balanceTwo(title, size, font);
  const lh = size * 1.25;
  const w = Math.max(...lines.map((l) => measure(font, l, size))) + 60;
  const h = lh * lines.length + 36;
  const top = (TITLE_BAND.h - h) / 2;
  const text = lines
    .map((l, i) => `<text x="${SAFE_CX}" y="${(top + 18 + lh * i + size * 0.95).toFixed(1)}" text-anchor="middle" font-family="${FONT()}" font-weight="700" font-size="${size}" fill="#111111">${escapeXml(l)}</text>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT.w}" height="${TITLE_BAND.h}"><rect x="${(SAFE_CX - w / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="22" fill="#FFFFFF" stroke="#111111" stroke-width="4"/>${text}</svg>`;
}

export class CaptionCache {
  private readonly map = new Map<string, Promise<Overlay>>();
  constructor(
    private readonly chunks: Chunk[],
    private readonly y = CAPTION_BAND.y,
  ) {}
  get(chunk: number, word: number): Promise<Overlay> {
    const key = `${chunk}:${word}`;
    let o = this.map.get(key);
    if (!o) this.map.set(key, (o = rgba(captionSvg(this.chunks[chunk], word), this.y)));
    return o;
  }
}

export const titleOverlay = (title: string) => rgba(titleSvg(title), TITLE_BAND.y);
