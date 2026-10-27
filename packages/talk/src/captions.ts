/**
 * Burnt-in text, CapCut style: the spoken words a few at a time, big, white
 * with a thick black outline, the word being said in yellow, popping in as
 * each chunk starts; and a fixed title band at the top.
 */

import sharp from "sharp";
import { BOLD_FONT_PATH, escapeXml, loadFont, measure, svgToPng } from "@hoi-sau/svg-text";
import type { Chunk } from "./timeline.js";
import { OUT } from "./timeline.js";

export const CAPTION_BAND = { y: 1180, h: 360 };
export const TITLE_BAND = { y: 90, h: 260 };

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

/** The pop-in: chunks start a little small and settle over four frames. */
export const popScale = (age: number) => [0.82, 0.92, 1.03, 1][Math.min(3, Math.max(0, age))];

export function captionSvg(chunk: Chunk, current: number, scale = 1): string {
  const font = loadFont(BOLD_FONT_PATH);
  const words = chunk.words.map((w) => w.text.replace(/[,;:.!?…]+$/, "")).filter(Boolean);
  let size = 104;
  const space = () => size * 0.28;
  const width = () => words.reduce((n, w) => n + measure(font, w, size), 0) + space() * (words.length - 1);
  while (width() > OUT.w - 120 && size > 56) size -= 4;
  const total = width();
  let x = (OUT.w - total) / 2;
  const cy = CAPTION_BAND.h / 2;
  const spans = words.map((w, i) => {
    const t = `<text x="${x.toFixed(1)}" y="${(cy + size * 0.36).toFixed(1)}" font-family="${FONT()}" font-weight="700" font-size="${size}" fill="${i === current ? "#FFE14D" : "#FFFFFF"}" stroke="#111111" stroke-width="${(size * 0.16).toFixed(1)}" stroke-linejoin="round" paint-order="stroke">${escapeXml(w)}</text>`;
    x += measure(font, w, size) + space();
    return t;
  });
  // Level text; only the pop-in scale, around the band's centre.
  const tf = `translate(${OUT.w / 2} ${cy}) scale(${scale}) translate(${-OUT.w / 2} ${-cy})`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT.w}" height="${CAPTION_BAND.h}"><g transform="${tf}">${spans.join("")}</g></svg>`;
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

export function titleSvg(title: string): string {
  const font = loadFont(BOLD_FONT_PATH);
  let size = 64;
  let lines = wrapTitle(title, size, OUT.w - 200);
  while (lines.length > 2 && size > 40) lines = wrapTitle(title, (size -= 4), OUT.w - 200);
  const lh = size * 1.25;
  const w = Math.max(...lines.map((l) => measure(font, l, size))) + 80;
  const h = lh * lines.length + 50;
  const top = (TITLE_BAND.h - h) / 2;
  const text = lines
    .map((l, i) => `<text x="${OUT.w / 2}" y="${(top + 25 + lh * i + size * 0.95).toFixed(1)}" text-anchor="middle" font-family="${FONT()}" font-weight="700" font-size="${size}" fill="#111111">${escapeXml(l)}</text>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT.w}" height="${TITLE_BAND.h}"><rect x="${((OUT.w - w) / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="28" fill="#FFFFFF" stroke="#111111" stroke-width="6"/>${text}</svg>`;
}

export class CaptionCache {
  private readonly map = new Map<string, Promise<Overlay>>();
  constructor(private readonly chunks: Chunk[]) {}
  get(chunk: number, word: number, age: number): Promise<Overlay> {
    const step = Math.min(3, age);
    const key = `${chunk}:${word}:${step}`;
    let o = this.map.get(key);
    if (!o) this.map.set(key, (o = rgba(captionSvg(this.chunks[chunk], word, popScale(step)), CAPTION_BAND.y)));
    return o;
  }
}

export const titleOverlay = (title: string) => rgba(titleSvg(title), TITLE_BAND.y);
