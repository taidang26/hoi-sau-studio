/**
 * What is on screen in every frame: which gesture, mouth open or shut, eyes
 * open or mid-blink, which caption chunk and word, and where the camera is.
 * Gestures change with a jump cut between lines, the way talking videos are
 * edited, with the camera switching between a wide and a close framing.
 */

import { gesture } from "./gestures.js";
import type { TalkLine } from "./script.js";
import type { Voice } from "./voice.js";

export const FPS = 30;
export const OUT = { w: 1080, h: 1920 };
/** Talk pictures (1024x1536) are scaled to this height-filling canvas before the camera crops it. */
export const CANVAS = { w: 1280, h: 1920 };

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

export interface Camera {
  /** 1 shows the full canvas height; 1.2 is a 20% closer crop. */
  zoom: number;
  /** Centre of the crop on the canvas. */
  cx: number;
  cy: number;
}

export interface Frame {
  gesture: string;
  mouth: boolean;
  blink: boolean;
  chunk?: number;
  word?: number;
  /** Frames since the chunk appeared, for its pop-in. */
  age: number;
  camera: Camera;
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

const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export interface TimelineInput {
  lines: TalkLine[];
  voice: Voice;
  mouth: boolean[];
  /** Gestures that have a mouth / blink picture. */
  canMouth: (g: string) => boolean;
  canBlink: (g: string) => boolean;
  /** Face centre on the canvas per gesture, for close framings. */
  face: (g: string) => { x: number; y: number } | undefined;
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
  const framing: number[] = [];
  let close = false;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && lines[i].gesture !== lines[i - 1].gesture) close = !close;
    framing.push(gesture(lines[i].gesture).punch ? 1.15 : close ? 1.12 : 1);
  }
  const frames: Frame[] = [];
  let chunkIdx = 0;
  let chunkSince = 0;
  for (let f = 0; f < t.frames; f++) {
    const s = f / FPS;
    const li = lineAt(s);
    const g = lines[li].gesture;
    const lineStart = Math.max(0, voice.spans[li].start - 0.12);
    const into = s - lineStart;
    // Punch-ins ease in over a quarter second; every framing creeps 3% closer while the line runs.
    const target = framing[li];
    const from = li > 0 && gesture(g).punch ? framing[li - 1] : target;
    const zoom = from + (target - from) * ease(into / 0.25) + 0.03 * Math.min(1, into / 4);
    const face = t.face(g) ?? { x: 640, y: 820 };
    // Close framings lean toward the face, but not all the way, so raised arms stay in shot.
    const near = 0.6 * Math.min(1, (zoom - 1) / 0.15);
    const camera: Camera = {
      zoom,
      cx: 640 + (face.x - 640) * near + 18 * Math.sin(s * 0.45),
      cy: 960 + (face.y + 120 - 960) * near + 10 * Math.sin(s * 0.33),
    };
    while (chunkIdx < chunks.length - 1 && s >= chunks[chunkIdx + 1].start) {
      chunkIdx++;
      chunkSince = f;
    }
    const c = chunks[chunkIdx];
    const showing = c && s >= c.start - 0.05 && s < c.end + 0.35;
    const word = showing ? c.words.findIndex((w) => s < w.end) : undefined;
    frames.push({
      gesture: g,
      mouth: !!t.mouth[f] && t.canMouth(g),
      blink: blinks[f] && t.canBlink(g),
      chunk: showing ? chunkIdx : undefined,
      word: showing ? (word === -1 ? c.words.length - 1 : word) : undefined,
      age: f - chunkSince,
      camera,
    });
  }
  return { frames, chunks };
}

/** The crop window of a camera on the canvas, kept inside it. */
export function cropWindow(c: Camera): { x: number; y: number; w: number; h: number } {
  // Never the full height, so there is always room to drift.
  const z = Math.max(1.01, c.zoom);
  const w = OUT.w / z;
  const h = OUT.h / z;
  const x = Math.min(CANVAS.w - w - 2, Math.max(0, c.cx - w / 2));
  const y = Math.min(CANVAS.h - h - 2, Math.max(0, c.cy - h / 2));
  return { x, y, w, h };
}
