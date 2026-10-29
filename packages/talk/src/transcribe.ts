/**
 * Muse Voice Transcribe on the Meta Model API: the words of a sound with
 * their times, so captions land on each word and the mouth only moves while
 * someone is actually talking (not on the music under them).
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

export const TRANSCRIBE_MODEL = "muse-voice-transcribe-1.0";

export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

export interface Transcript {
  text: string;
  words: TimedWord[];
  segments: Array<{ text: string; start: number; end: number }>;
}

export class TranscribeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TranscribeError";
  }
}

export interface TranscribeOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
}

export class MuseTranscribe {
  constructor(private readonly opts: TranscribeOptions) {
    if (!opts.apiKey) throw new TranscribeError("Missing API key: set META_API_KEY (or MODEL_API_KEY) in .env");
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): MuseTranscribe {
    return new MuseTranscribe({ apiKey: env.META_API_KEY || env.MODEL_API_KEY || "", baseUrl: env.META_API_BASE_URL || undefined, model: env.TRANSCRIBE_MODEL || undefined });
  }

  /** Transcribes an audio file (wav, mp3, m4a). Asks for word times; falls back to segment times. */
  async transcribe(file: string, language = "vi"): Promise<Transcript> {
    const url = `${(this.opts.baseUrl ?? "https://api.meta.ai/v1").replace(/\/$/, "")}/audio/transcriptions`;
    const go = this.opts.fetch ?? fetch;
    const attempts: Array<Record<string, string | string[]>> = [
      { response_format: "verbose_json", "timestamp_granularities[]": ["word", "segment"], language },
      { response_format: "verbose_json", language },
      { language },
    ];
    let last = "";
    for (const extra of attempts) {
      const form = new FormData();
      form.append("model", this.opts.model ?? TRANSCRIBE_MODEL);
      form.append("file", new Blob([readFileSync(file)]), basename(file));
      for (const [k, v] of Object.entries(extra)) for (const x of [v].flat()) form.append(k, x);
      const res = await go(url, { method: "POST", headers: { Authorization: `Bearer ${this.opts.apiKey}` }, body: form });
      const json = (await res.json().catch(() => ({}))) as any;
      if (res.ok) return parseTranscript(json);
      last = `Muse Voice Transcribe ${res.status}: ${json?.error?.message ?? "request failed"}`;
      // Only an unsupported option is worth retrying without it.
      if (res.status !== 400 && res.status !== 422) break;
    }
    throw new TranscribeError(last);
  }
}

export function parseTranscript(json: any): Transcript {
  const num = (x: unknown) => (typeof x === "number" ? x : Number(x));
  const segments = (Array.isArray(json?.segments) ? json.segments : [])
    .map((s: any) => ({ text: String(s.text ?? "").trim(), start: num(s.start), end: num(s.end) }))
    .filter((s: any) => s.text && isFinite(s.start) && isFinite(s.end));
  let words: TimedWord[] = (Array.isArray(json?.words) ? json.words : [])
    .map((w: any) => ({ word: String(w.word ?? w.text ?? "").trim(), start: num(w.start), end: num(w.end) }))
    .filter((w: TimedWord) => w.word && isFinite(w.start) && isFinite(w.end));
  if (!words.length && segments.length) words = segments.flatMap((s: any) => spread(s.text, s.start, s.end));
  const text = String(json?.text ?? segments.map((s: any) => s.text).join(" ")).trim();
  return { text, words, segments };
}

/** Even times for the syllables of `text` between `start` and `end`. */
export function spread(text: string, start: number, end: number): TimedWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const d = (end - start) / Math.max(1, tokens.length);
  return tokens.map((word, i) => ({ word, start: start + i * d, end: start + (i + 1) * d }));
}

/**
 * Words grouped into lines: a new line after a pause of `gap` seconds or a
 * full stop, or once a line has `max` syllables.
 */
export function linesFromWords(words: TimedWord[], gap = 0.45, max = 14): TimedWord[][] {
  const out: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (cur.length && (w.start - prev.end > gap || cur.length >= max || /[.!?…]$/.test(prev.word))) {
      out.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out;
}
