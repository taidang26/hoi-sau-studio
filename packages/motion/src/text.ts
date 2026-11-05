/**
 * Text burnt into the video: series header, title card, end card.
 * Dialogue is not here: it is already lettered on the panels by svg-text.
 *
 * Each line is a separate drawtext reading from a UTF-8 text file, so
 * Vietnamese never goes through filtergraph escaping and every line can be
 * centred on its own.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Wraps on spaces (Vietnamese breaks between syllables) to about `maxChars`. */
export function wrap(text: string, maxChars: number): string[] {
  const words = text.normalize("NFC").trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ([...cur].length + 1 + [...w].length <= maxChars) cur += ` ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Characters per line for a bold sans at `fontSize` across `width` pixels. */
export const charsPerLine = (width: number, fontSize: number) => Math.max(8, Math.floor(width / (fontSize * 0.58)));

export interface TextBlock {
  text: string;
  fontSize: number;
  color?: string;
  /** Top of the first line, in pixels. */
  y: number;
  /** Wrap width; defaults to the frame width minus margins. */
  width?: number;
  /** Centre of the lines in pixels; defaults to the middle of the frame. */
  cx?: number;
  lineGap?: number;
  /** Dark outline so text reads on any background. */
  border?: number;
  /** Seconds; omit for the whole clip. */
  from?: number;
  to?: number;
}

let seq = 0;

/**
 * drawtext filters for a block. Text files are written to `workDir` and named
 * relative to it, so ffmpeg must run with `workDir` as its cwd. `font` is a
 * file name in `workDir` (see `stageFont`).
 */
export function drawTextFilters(block: TextBlock, frameWidth: number, workDir: string, font?: string): string[] {
  const width = block.width ?? frameWidth - 120;
  const lines = wrap(block.text, charsPerLine(width, block.fontSize));
  const gap = block.lineGap ?? Math.round(block.fontSize * 0.3);
  return lines.map((line, i) => {
    const name = `text-${process.pid}-${++seq}.txt`;
    writeFileSync(join(workDir, name), line, "utf8");
    const opts = [
      font ? `fontfile=${font}` : "font=Sans",
      `textfile=${name}`,
      `fontsize=${block.fontSize}`,
      `fontcolor=${block.color ?? "white"}`,
      block.cx === undefined ? `x=(w-text_w)/2` : `x=${Math.round(block.cx)}-text_w/2`,
      `y=${Math.round(block.y + i * (block.fontSize + gap))}`,
      `borderw=${block.border ?? Math.max(2, Math.round(block.fontSize / 12))}`,
      `bordercolor=black@0.85`,
    ];
    if (block.from !== undefined || block.to !== undefined) {
      opts.push(`enable='between(t,${block.from ?? 0},${block.to ?? 1e6})'`);
    }
    return `drawtext=${opts.join(":")}`;
  });
}

/**
 * How long a panel stays on screen: time to read its dialogue (about 14
 * Vietnamese characters a second) plus a beat to look at the art.
 */
export function readingSeconds(dialogue: string[], opts: { min?: number; max?: number } = {}): number {
  const chars = dialogue.reduce((n, t) => n + [...t.normalize("NFC")].length, 0);
  const secs = 1.8 + chars / 14;
  return Math.round(Math.min(opts.max ?? 7, Math.max(opts.min ?? 2.6, secs)) * 10) / 10;
}
