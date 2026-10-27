/**
 * Fitting Vietnamese dialogue into a bubble.
 *
 * Vietnamese writes every syllable as its own space-separated token, so lines
 * only ever break at spaces and a syllable is never split. Words that must stay
 * together ("đồng nghiệp", "deadline 5h") can be glued with a no-break space
 * (U+00A0) or with "~" in the script, which renders as a normal space.
 */

import { type LoadedFont, measure, metrics } from "./font.js";

export type BubbleShape = "ellipse" | "rect";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FitOptions {
  shape?: BubbleShape;
  /** Inner margin in px between the bubble edge and the text. */
  padding?: number;
  maxFontSize?: number;
  minFontSize?: number;
  /** Line height as a multiple of font size. Tall enough for stacked marks like "Ể". */
  lineHeight?: number;
}

export interface Line {
  text: string;
  width: number;
  /** Baseline y in panel coordinates. */
  baseline: number;
  /** Horizontal centre in panel coordinates. */
  cx: number;
}

export interface Fit {
  fontSize: number;
  lines: Line[];
  /** False when even the minimum font size overflows; lines are still returned. */
  fits: boolean;
}

const GLUE = /~/g;

/** NFC, collapse whitespace, turn "~" glue into no-break spaces. */
export function prepare(text: string): string {
  return text.normalize("NFC").replace(GLUE, " ").replace(/[ \t\r\n]+/g, " ").trim();
}

/**
 * Split on breakable spaces only. No-break spaces stay inside a token, and a
 * number stays with the word after it ("5 giờ", "3 ngày").
 */
export function tokens(text: string): string[] {
  const raw = prepare(text).split(" ").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (/^[\d.,:%]+$/.test(raw[i]) && i + 1 < raw.length) out.push(`${raw[i]}\u00a0${raw[++i]}`);
    else out.push(raw[i]);
  }
  return out;
}

/** Usable width of each of `n` lines, centred vertically in the box. Null if n lines cannot stand. */
function lineWidths(box: Box, shape: BubbleShape, padding: number, n: number, lineGap: number): number[] | null {
  const innerH = box.height - 2 * padding;
  const blockH = n * lineGap;
  if (blockH > innerH) return null;
  if (shape === "rect") return Array(n).fill(box.width - 2 * padding);

  // Ellipse: a line band is usable where both its top and bottom edge are inside.
  const a = box.width / 2 - padding;
  const b = box.height / 2 - padding;
  const widths: number[] = [];
  for (let i = 0; i < n; i++) {
    const top = -blockH / 2 + i * lineGap;
    const bottom = top + lineGap;
    const dy = Math.max(Math.abs(top), Math.abs(bottom));
    if (dy >= b) return null;
    widths.push(2 * a * Math.sqrt(1 - (dy / b) ** 2));
  }
  return widths;
}

/**
 * Break `words` into exactly `widths.length` lines that all fit, choosing the
 * split with the least uneven fill (sum of squared slack). That keeps a bubble
 * from ending on one lonely syllable. Null when no split fits.
 */
function breakLines(words: string[], widths: number[], width: (s: string) => number): string[] | null {
  const n = widths.length;
  const W = words.length;
  if (W < n) return null;
  const join = (i: number, j: number) => words.slice(i, j).join(" ");
  // cost[k][j]: best cost for words[0..j) in k lines.
  const cost: number[][] = Array.from({ length: n + 1 }, () => Array(W + 1).fill(Infinity));
  const from: number[][] = Array.from({ length: n + 1 }, () => Array(W + 1).fill(-1));
  cost[0][0] = 0;
  for (let k = 1; k <= n; k++) {
    for (let j = k; j <= W - (n - k); j++) {
      for (let i = k - 1; i < j; i++) {
        if (cost[k - 1][i] === Infinity) continue;
        const w = width(join(i, j));
        if (w > widths[k - 1]) continue;
        const c = cost[k - 1][i] + (1 - w / widths[k - 1]) ** 2;
        if (c < cost[k][j]) {
          cost[k][j] = c;
          from[k][j] = i;
        }
      }
    }
  }
  if (cost[n][W] === Infinity) return null;
  const lines: string[] = [];
  for (let k = n, j = W; k > 0; k--) {
    const i = from[k][j];
    lines.unshift(join(i, j));
    j = i;
  }
  return lines;
}

function place(lines: string[], box: Box, font: LoadedFont, size: number, lineGap: number, width: (s: string) => number): Line[] {
  const { ascender, descender } = metrics(font, size);
  const blockH = lines.length * lineGap;
  const cx = box.x + box.width / 2;
  const top = box.y + box.height / 2 - blockH / 2;
  // Centre the glyph box (ascender..descender) inside each line band.
  const inBand = (lineGap - (ascender - descender)) / 2 + ascender;
  return lines.map((text, i) => ({ text, width: width(text), baseline: top + i * lineGap + inBand, cx }));
}

export function fitText(text: string, box: Box, font: LoadedFont, opts: FitOptions = {}): Fit {
  const { shape = "ellipse", padding = 12, maxFontSize = 44, minFontSize = 16, lineHeight = 1.3 } = opts;
  const words = tokens(text);
  if (words.length === 0) return { fontSize: maxFontSize, lines: [], fits: true };

  // Biggest font wins, but a line holding a single syllable costs a few px,
  // so a slightly smaller size without stranded words is preferred.
  const STRANDED_PENALTY = 4;
  let best: { score: number; fit: Fit } | null = null;
  for (let size = maxFontSize; size >= minFontSize; size -= 1) {
    if (best && size <= best.score) break;
    const gap = size * lineHeight;
    const memo = new Map<string, number>();
    const width = (s: string) => memo.get(s) ?? memo.set(s, measure(font, s, size)).get(s)!;
    const words1 = words.map(width);
    const total = words1.reduce((a, b) => a + b, 0);
    for (let n = 1; n <= words.length; n++) {
      const widths = lineWidths(box, shape, padding, n, gap);
      if (!widths) break;
      // Cheap bound before the exact split: the words alone must fit in the total width.
      if (widths.reduce((a, b) => a + b, 0) < total || Math.max(...words1) > Math.max(...widths)) continue;
      const lines = breakLines(words, widths, width);
      if (!lines) continue;
      const stranded = lines.length > 1 ? lines.filter((l) => !l.includes(" ") && !l.includes(" ")).length : 0;
      const score = size - stranded * STRANDED_PENALTY;
      if (!best || score > best.score) best = { score, fit: { fontSize: size, lines: place(lines, box, font, size, gap, width), fits: true } };
      break;
    }
  }
  if (best) return best.fit;

  // Overflow: one word per line at the minimum size, flagged so review can catch it.
  const width = (s: string) => measure(font, s, minFontSize);
  return { fontSize: minFontSize, lines: place(words, box, font, minFontSize, minFontSize * lineHeight, width), fits: false };
}
