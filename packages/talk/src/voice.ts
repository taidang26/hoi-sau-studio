/**
 * The voice track. Lines are spoken one by one (Meta's SeamlessM4T v2 or MMS-TTS, or recordings
 * named 01.wav, 02.wav... in the same order), trimmed, pitched for the
 * character, and joined with short pauses. The mouth opens and closes with
 * the loudness of that track.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpeg } from "@hoi-sau/motion";
import { syllables } from "./script.js";

export const RATE = 48000;

export interface Voice {
  pcm: Int16Array;
  rate: number;
  /** Where each line sits in the track, in seconds. */
  spans: Array<{ start: number; end: number }>;
}

/** Which Meta model speaks: SeamlessM4T v2 by default, MMS-TTS as the lighter fallback. */
export type Tts = "seamless" | "mms";
const TTS: Record<Tts, { script: string; name: string; pitch: number; tempo: number }> = {
  seamless: { script: fileURLToPath(new URL("../tts/seamless.py", import.meta.url)), name: "SeamlessM4T v2", pitch: 1.12, tempo: 1.05 },
  mms: { script: fileURLToPath(new URL("../tts/tts.py", import.meta.url)), name: "MMS-TTS", pitch: 1.12, tempo: 1 },
};

export function ttsArg(v: unknown): Tts {
  if (v === undefined || v === true) return "seamless";
  if (v === "seamless" || v === "mms") return v;
  throw new Error(`--tts takes seamless or mms, not ${String(v)}.`);
}

/** The cartoon voice: pitch and speed applied to a generated line (a recording keeps its own). */
export function voiceShape(tts: Tts, opts: { pitch?: number; tempo?: number } = {}): { pitch: number; tempo: number } {
  return { pitch: opts.pitch ?? TTS[tts].pitch, tempo: opts.tempo ?? TTS[tts].tempo };
}

export const lineId = (i: number) => String(i + 1).padStart(2, "0");

export function python(): string {
  return process.env.TALK_PYTHON || process.env.DANCE_PYTHON || (process.platform === "win32" ? "python" : "python3");
}

/** SeamlessM4T v2 or MMS-TTS speaks every line into `dir`/<01..>.wav. */
export async function speakLines(texts: string[], dir: string, opts: { rate?: number; tts?: Tts } = {}): Promise<void> {
  const tts = TTS[opts.tts ?? "seamless"];
  mkdirSync(dir, { recursive: true });
  const list = join(dir, "lines.json");
  writeFileSync(list, JSON.stringify(texts.map((text, i) => ({ id: lineId(i), text })), null, 2));
  await new Promise<void>((ok, fail) => {
    const args = opts.tts === "mms" ? ["--rate", String(opts.rate ?? 1)] : [];
    const p = spawn(python(), [tts.script, list, dir, ...args], { stdio: "inherit" });
    p.on("error", (e) => fail(new Error(`Could not start Python (${e.message}). pip install -r packages/talk/tts/requirements.txt, or set TALK_PYTHON.`)));
    p.on("close", (code) => (code === 0 ? ok() : fail(new Error(`${tts.name} exited with ${code}.`))));
  });
}

/**
 * One line as 48 kHz mono samples: silence trimmed at both ends and the pitch
 * raised by `pitch` (1.1 is about a semitone and a half) at the same speed.
 */
export async function readLine(wav: string, pitch = 1, tempo = 1): Promise<Int16Array> {
  const raw = `${wav}.pcm`;
  const trim = "silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.02";
  const filters = [trim, "areverse", trim, "areverse", `aresample=${RATE}`];
  if (pitch !== 1) filters.push(`asetrate=${Math.round(RATE * pitch)}`, `aresample=${RATE}`);
  const speed = tempo / pitch;
  if (Math.abs(speed - 1) > 1e-3) filters.push(`atempo=${speed.toFixed(4)}`);
  await ffmpeg(["-i", wav, "-af", filters.join(","), "-ac", "1", "-ar", String(RATE), "-f", "s16le", raw]);
  const b = readFileSync(raw);
  return new Int16Array(b.buffer, b.byteOffset, b.length >> 1).slice();
}

/** Lines joined with `gap` seconds between them and `lead` seconds before the first. */
export function joinLines(lines: Int16Array[], opts: { gap?: number; lead?: number; tail?: number } = {}): Voice {
  const gap = Math.round((opts.gap ?? 0.28) * RATE);
  const lead = Math.round((opts.lead ?? 0.25) * RATE);
  const tail = Math.round((opts.tail ?? 0.8) * RATE);
  const total = lead + lines.reduce((n, l) => n + l.length, 0) + gap * Math.max(0, lines.length - 1) + tail;
  const pcm = new Int16Array(total);
  const spans: Voice["spans"] = [];
  let at = lead;
  for (const l of lines) {
    pcm.set(l, at);
    spans.push({ start: at / RATE, end: (at + l.length) / RATE });
    at += l.length + gap;
  }
  return { pcm, rate: RATE, spans };
}

export function wavBytes(pcm: Int16Array, rate = RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length * 2, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length * 2, 40);
  return Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2)]);
}

/**
 * Mouth open (true) or shut per video frame, from the loudness of the track:
 * open above a threshold, shut again only well below it, never open or shut
 * for less than two frames so it does not flicker.
 */
export function mouthTrack(voice: Voice, fps: number, frames: number): boolean[] {
  const per = voice.rate / fps;
  const rms = Array.from({ length: frames }, (_, f) => {
    const a = Math.floor(f * per);
    const b = Math.min(voice.pcm.length, Math.floor((f + 1) * per));
    let s = 0;
    for (let i = a; i < b; i++) s += voice.pcm[i] * voice.pcm[i];
    return b > a ? Math.sqrt(s / (b - a)) / 32768 : 0;
  });
  const peak = [...rms].sort((x, y) => x - y)[Math.floor(rms.length * 0.95)] || 1;
  const on = peak * 0.32;
  const off = peak * 0.18;
  const out: boolean[] = [];
  let open = false;
  let held = 0;
  for (const v of rms) {
    const want: boolean = open ? v > off : v > on;
    if (want !== open && held >= 2) {
      open = want;
      held = 0;
    }
    held++;
    out.push(open);
  }
  // Long vowels hold the mouth open; a real mouth moves, so close it briefly every 6 frames.
  for (let f = 0, run = 0; f < out.length; f++) {
    run = out[f] ? run + 1 : 0;
    if (run > 6) {
      out[f] = false;
      run = 0;
    }
  }
  return out;
}

/** A stand-in voice without Python: one soft tone burst per syllable. */
export function hummedLine(text: string, rate = RATE): Int16Array {
  const n = Math.max(1, syllables(text));
  const syl = Math.round(rate * 0.24);
  const pcm = new Int16Array(n * syl);
  for (let k = 0; k < n; k++) {
    const f0 = 190 + 30 * Math.sin(k * 1.7);
    for (let i = 0; i < syl * 0.8; i++) {
      const env = Math.sin((Math.PI * i) / (syl * 0.8));
      pcm[k * syl + i] = Math.round(9000 * env * Math.sin((2 * Math.PI * f0 * i) / rate));
    }
  }
  return pcm;
}

export async function voiceFor(texts: string[], dir: string, opts: { mock?: boolean; recorded?: string; pitch?: number; tempo?: number; rate?: number; tts?: Tts }): Promise<Voice> {
  if (opts.mock) return joinLines(texts.map((t) => hummedLine(t)));
  const src = opts.recorded ?? join(dir, "lines");
  let tts = opts.tts ?? "seamless";
  if (!opts.recorded) {
    try {
      await speakLines(texts, src, { rate: opts.rate, tts });
    } catch (e) {
      if (tts !== "seamless") throw e;
      // SeamlessM4T needs ~9 GB of weights plus sentencepiece; MMS-TTS still speaks without them.
      console.warn(`${(e as Error).message} Falling back to MMS-TTS.`);
      tts = "mms";
      await speakLines(texts, src, { rate: opts.rate, tts });
    }
  }
  const shape = opts.recorded ? { pitch: 1, tempo: 1 } : voiceShape(tts, opts);
  const lines: Int16Array[] = [];
  for (const [i] of texts.entries()) {
    const wav = join(src, `${lineId(i)}.wav`);
    if (!existsSync(wav)) throw new Error(`${wav} is missing.`);
    // A recorded voice keeps its own pitch.
    lines.push(await readLine(wav, shape.pitch, shape.tempo));
  }
  return joinLines(lines);
}
