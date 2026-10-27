/**
 * SVG output for dialogue. Default mode draws glyphs as paths, so the result
 * looks the same in every renderer and never depends on an installed font.
 */

import { balloon, type BubbleKind, hashText } from "./balloon.js";
import { COMIC_FONT_PATH, DEFAULT_FONT_PATH, type LoadedFont, loadFont, measure, missingGlyphs, SHOUT_FONT_PATH } from "./font.js";
import { type Box, type BubbleShape, type Fit, type FitOptions, fitText, tokens } from "./layout.js";

export interface Bubble extends Box {
  /** "rect" is a caption box with no tail; every other bubble is drawn by `kind`. */
  shape?: BubbleShape;
  /** What the line is: said, thought, shouted or whispered. Defaults to speech. */
  kind?: BubbleKind;
  /**
   * Draw the bubble itself (fill, outline, tail). Off when the panel already
   * has an empty bubble drawn by the image model.
   */
  draw?: boolean;
  /** Point the tail aims at, usually the speaker's mouth. Only used with `draw`. */
  tail?: { x: number; y: number };
}

export interface SpeechOptions extends FitOptions {
  /** Path to a .ttf/.otf file. Defaults to Mali Bold, Bangers for shouts and Be Vietnam Pro for captions. */
  fontPath?: string;
  color?: string;
  bubbleFill?: string;
  bubbleStroke?: string;
  strokeWidth?: number;
  /** "paths" (default) outlines glyphs; "text" keeps live text and embeds the font. */
  mode?: "paths" | "text";
}

export interface RenderedSpeech {
  svg: string;
  fit: Fit;
}

export class MissingGlyphError extends Error {
  constructor(public readonly chars: string[], fontPath: string) {
    super(`Font ${fontPath} has no glyph for: ${chars.join(" ")}`);
  }
}

export const escapeXml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "apos" }[c]};`);

const n = (v: number) => Number(v.toFixed(2));

function caption(b: Bubble, fill: string, stroke: string, sw: number): string {
  return `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.width)}" height="${n(b.height)}" rx="${n(Math.min(b.width, b.height) * 0.12)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
}

/** The font a bubble uses when the caller does not pick one. */
export function bubbleFont(b: Pick<Bubble, "kind" | "shape">): string {
  if (b.shape === "rect") return DEFAULT_FONT_PATH;
  return b.kind === "shout" ? SHOUT_FONT_PATH : COMIC_FONT_PATH;
}

/** Shouts are lettered in capitals; everything else as written. */
export const letterText = (text: string, b: Pick<Bubble, "kind">) => (b.kind === "shout" ? text.toLocaleUpperCase("vi") : text);

/** Extra inner margin, as a share of the bubble, for outlines that bulge inwards. */
const INSET: Record<BubbleKind, number> = { speech: 0.02, whisper: 0.02, thought: 0.07, shout: 0.07 };

export function fontFace(font: LoadedFont): string {
  return `@font-face{font-family:"${escapeXml(font.family)}";src:url(data:font/ttf;base64,${font.data.toString("base64")});}`;
}

/** Dialogue for one bubble as an SVG `<g>` fragment in panel coordinates. */
export function renderSpeech(text: string, bubble: Bubble, opts: SpeechOptions = {}): RenderedSpeech {
  const font = loadFont(opts.fontPath ?? bubbleFont(bubble));
  text = letterText(text, bubble);
  const missing = missingGlyphs(font, text);
  if (missing.length) throw new MissingGlyphError(missing, font.path);

  const { color = "#1a1a1a", bubbleFill = "#ffffff", bubbleStroke = "#1a1a1a", strokeWidth = 4, mode = "paths" } = opts;
  const kind = bubble.kind ?? "speech";
  const inset = bubble.shape === "rect" ? 0 : INSET[kind] * Math.min(bubble.width, bubble.height);
  const fit = fitText(text, bubble, font, { shape: bubble.shape, ...opts, padding: (opts.padding ?? 12) + inset });
  const out: string[] = [`<g class="${bubble.shape === "rect" ? "caption" : kind}">`];
  if (bubble.draw) {
    out.push(
      bubble.shape === "rect"
        ? caption(bubble, bubbleFill, bubbleStroke, strokeWidth)
        : balloon(kind, bubble, bubble.tail, { fill: bubbleFill, stroke: bubbleStroke, strokeWidth, seed: hashText(text) }),
    );
  }

  if (mode === "paths") {
    const d = fit.lines
      .map((l) => font.font.getPath(l.text, l.cx - l.width / 2, l.baseline, fit.fontSize, { kerning: true }).toPathData(2))
      .join("");
    out.push(`<path d="${d}" fill="${color}"/>`);
  } else {
    out.push(
      `<text font-family="${escapeXml(font.family)}" font-size="${fit.fontSize}" fill="${color}" text-anchor="middle">`,
      ...fit.lines.map((l) => `<tspan x="${n(l.cx)}" y="${n(l.baseline)}">${escapeXml(l.text)}</tspan>`),
      "</text>",
    );
  }
  out.push("</g>");
  return { svg: out.join(""), fit };
}

/**
 * The smallest bubble that holds `text` at about `fontSize`, a little wider
 * than tall like a hand-lettered balloon, and no wider than `maxWidth`.
 */
export function snugBubble(
  text: string,
  kind: BubbleKind = "speech",
  opts: { fontSize: number; maxWidth: number; fontPath?: string; padding?: number },
): { width: number; height: number } {
  const b = { kind };
  const font = loadFont(opts.fontPath ?? bubbleFont(b));
  const t = letterText(text, b);
  const F = opts.fontSize;
  const pad = opts.padding ?? 12;
  const words = tokens(t).map((w) => measure(font, w, F));
  const space = measure(font, " ", F);
  const total = words.reduce((a, w) => a + w, 0) + space * Math.max(words.length - 1, 0);
  const widest = Math.max(0, ...words);
  const grow = 1 + INSET[kind] * 2.4;
  let best: { width: number; height: number; score: number } | null = null;
  for (let lines = 1; lines <= Math.max(words.length, 1); lines++) {
    const lineW = Math.max(widest, (total / lines) * 1.1);
    const width = (lineW * 1.36 + 2 * pad) * grow;
    const height = (lines * F * 1.3 * 1.36 + 2 * pad) * grow;
    if (width > opts.maxWidth && best) continue;
    const score = Math.abs(Math.log(width / height / 1.7));
    if (!best || score < best.score) best = { width: Math.min(width, opts.maxWidth), height, score };
  }
  let { width, height } = best ?? { width: opts.maxWidth, height: F * 3 };
  for (let i = 0; i < 12; i++) {
    const fit = fitText(t, { x: 0, y: 0, width, height }, font, { maxFontSize: F, padding: pad + INSET[kind] * Math.min(width, height) });
    if (fit.fits && fit.fontSize >= F - 1) break;
    width = Math.min(width * 1.06, opts.maxWidth);
    height *= 1.06;
  }
  return { width, height };
}
