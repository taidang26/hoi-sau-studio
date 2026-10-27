/**
 * SVG output for dialogue. Default mode draws glyphs as paths, so the result
 * looks the same in every renderer and never depends on an installed font.
 */

import { type LoadedFont, loadFont, missingGlyphs } from "./font.js";
import { type Box, type BubbleShape, type Fit, type FitOptions, fitText } from "./layout.js";

export interface Bubble extends Box {
  shape?: BubbleShape;
  /**
   * Draw the bubble itself (fill, outline, tail). Off when the panel already
   * has an empty bubble drawn by the image model.
   */
  draw?: boolean;
  /** Point the tail aims at, usually the speaker's mouth. Only used with `draw`. */
  tail?: { x: number; y: number };
}

export interface SpeechOptions extends FitOptions {
  /** Path to a .ttf/.otf file. Defaults to Be Vietnam Pro SemiBold. */
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

function bubbleShape(b: Bubble, fill: string, stroke: string, sw: number): string {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const parts: string[] = [];
  let tail = "";
  if (b.tail) {
    // A wedge from two points on the bubble edge to the tail tip.
    const angle = Math.atan2(b.tail.y - cy, b.tail.x - cx);
    const spread = 0.22;
    const edge = (t: number) =>
      b.shape === "rect"
        ? `${n(cx + Math.cos(t) * b.width * 0.35)},${n(cy + Math.sin(t) * b.height * 0.35)}`
        : `${n(cx + Math.cos(t) * (b.width / 2 - sw))},${n(cy + Math.sin(t) * (b.height / 2 - sw))}`;
    tail = `M${edge(angle - spread)} L${n(b.tail.x)},${n(b.tail.y)} L${edge(angle + spread)} Z`;
    parts.push(`<path d="${tail}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`);
  }
  const body =
    b.shape === "rect"
      ? `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.width)}" height="${n(b.height)}" rx="${n(Math.min(b.width, b.height) * 0.18)}"`
      : `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(b.width / 2)}" ry="${n(b.height / 2)}"`;
  parts.push(`${body} fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);
  // Cover the seam where the tail meets the outline.
  if (tail) parts.push(`<path d="${tail}" fill="${fill}"/>`);
  return parts.join("");
}

export function fontFace(font: LoadedFont): string {
  return `@font-face{font-family:"${escapeXml(font.family)}";src:url(data:font/ttf;base64,${font.data.toString("base64")});}`;
}

/** Dialogue for one bubble as an SVG `<g>` fragment in panel coordinates. */
export function renderSpeech(text: string, bubble: Bubble, opts: SpeechOptions = {}): RenderedSpeech {
  const font = loadFont(opts.fontPath);
  const missing = missingGlyphs(font, text);
  if (missing.length) throw new MissingGlyphError(missing, font.path);

  const { color = "#111111", bubbleFill = "#ffffff", bubbleStroke = "#111111", strokeWidth = 4, mode = "paths" } = opts;
  const fit = fitText(text, bubble, font, { shape: bubble.shape, ...opts });
  const out: string[] = ["<g class=\"speech\">"];
  if (bubble.draw) out.push(bubbleShape(bubble, bubbleFill, bubbleStroke, strokeWidth));

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
