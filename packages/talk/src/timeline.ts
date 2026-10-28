/**
 * What is on screen in every frame: which gesture, mouth open or shut, eyes
 * open or mid-blink, which caption chunk and word, and where the camera is.
 * The camera stays still: the whole picture is always in view and gestures
 * simply change between lines.
 */

import type { TalkLine } from "./script.js";
import type { Voice } from "./voice.js";

export const FPS = 30;
export const OUT = { w: 1080, h: 1920 };
/**
 * What TikTok, Reels and Shorts leave uncovered on a 1080x1920 video: their
 * top bar, the caption/name/music block at the bottom and the like/comment/
 * share column on the right sit on everything outside. Title, captions and
 * the character's face and body stay inside; only the backdrop runs out.
 */
export const SAFE = { left: 60, top: 250, right: 940, bottom: 1480 };
export const SAFE_CX = (SAFE.left + SAFE.right) / 2;
/** Where the whole talk picture (2:3) sits in the 9:16 frame: full width, a band above and below. */
export const PICTURE = { x: 0, y: 130, w: 1080, h: 1620 };

export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface Chunk {
  words: Word[];
  start: number;
  end: number;
}

export interface Frame {
  gesture: string;
  mouth: boolean;
  blink: boolean;
  chunk?: number;
  word?: number;
}

/** Each syllable of a line gets a share of the line's time; a comma or full stop adds a pause after it. */
export function wordTimes(text: string, start: number, end: number): Word[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const weight = tokens.map((t) => 1 + (/[,;:]$/.test(t) ? 0.5 : /[.!?…]$/.test(t) ? 0.9 : 0));
  const total = weight.reduce((a, b) => a + b, 0) || 1;
  let at = start;
  return tokens.map((text, i) => {
    const d = ((end - start) * weight[i]) / total;
    const w = { text, start: at, end: at + d };
    at += d;
    return w;
  });
}

/** Caption chunks of up to `max` syllables, broken after punctuation, never across lines. */
export function chunkWords(words: Word[], max = 4, maxChars = 18): Chunk[] {
  const out: Chunk[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) out.push({ words: cur, start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  };
  for (const w of words) {
    const len = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    if (cur.length >= max || (cur.length && len > maxChars)) flush();
    cur.push(w);
    if (/[,;:.!?…]$/.test(w.text)) flush();
  }
  flush();
  return out;
}

/** Deterministic 0..1 from an integer, so a render is the same every time. */
const rand = (n: number) => {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

export function blinkTrack(frames: number, seed = 1): boolean[] {
  const out = new Array<boolean>(frames).fill(false);
  let f = Math.round(FPS * (1 + rand(seed) * 1.5));
  for (let k = 0; f < frames; k++) {
    for (let i = 0; i < 3 && f + i < frames; i++) out[f + i] = true;
    f += Math.round(FPS * (2.2 + rand(seed + k + 1) * 2.6));
  }
  return out;
}

export interface TimelineInput {
  lines: TalkLine[];
  voice: Voice;
  mouth: boolean[];
  /** Gestures that have a mouth / blink picture. */
  canMouth: (g: string) => boolean;
  canBlink: (g: string) => boolean;
  frames: number;
  /** Real word times per line (from a transcript); estimated from the line's span when missing. */
  words?: Word[][];
}

export function buildTimeline(t: TimelineInput): { frames: Frame[]; chunks: Chunk[] } {
  const { lines, voice } = t;
  const chunks = lines.flatMap((l, i) => chunkWords(t.words?.[i] ?? wordTimes(l.text, voice.spans[i].start, voice.spans[i].end)));
  const blinks = blinkTrack(t.frames);
  // A line runs from its first word to the start of the next line.
  const lineAt = (s: number) => {
    let k = 0;
    for (let i = 0; i < lines.length; i++) if (s >= voice.spans[i].start - 0.12) k = i;
    return k;
  };
  const frames: Frame[] = [];
  let chunkIdx = 0;
  for (let f = 0; f < t.frames; f++) {
    const s = f / FPS;
    const g = lines[lineAt(s)].gesture;
    while (chunkIdx < chunks.length - 1 && s >= chunks[chunkIdx + 1].start) chunkIdx++;
    const c = chunks[chunkIdx];
    const showing = c && s >= c.start - 0.05 && s < c.end + 0.35;
    const word = showing ? c.words.findIndex((w) => s < w.end) : undefined;
    frames.push({
      gesture: g,
      mouth: !!t.mouth[f] && t.canMouth(g),
      blink: blinks[f] && t.canBlink(g),
      chunk: showing ? chunkIdx : undefined,
      word: showing ? (word === -1 ? c.words.length - 1 : word) : undefined,
    });
  }
  return { frames, chunks };
}
