/**
 * Âm thanh hiệu ứng: short sound effects made once with AudioGen (Meta AudioCraft, on the owner's GPU)
 * and dropped on the punchline of a meme, the way office meme pages do (a "ting", crickets, a sigh).
 *
 *   series/sfx/<name>.wav   one sound each
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { python } from "./voice.js";

export interface Sound { name: string; vi: string; seconds: number; prompt: string }

export const SOUNDS: Sound[] = [
  { name: "ting", vi: "Ting (lóe ý)", seconds: 1.5, prompt: "a single bright bell ding, clean, short" },
  { name: "boing", vi: "Boing", seconds: 1.5, prompt: "a cartoon spring boing sound" },
  { name: "de-keu", vi: "Dế kêu (im lặng)", seconds: 3, prompt: "crickets chirping at night in an awkward silence" },
  { name: "qua-keu", vi: "Quạ kêu", seconds: 2, prompt: "a single crow cawing twice" },
  { name: "tho-dai", vi: "Thở dài", seconds: 2, prompt: "a long tired human sigh" },
  { name: "ba-dum-tss", vi: "Ba dum tss", seconds: 2, prompt: "drum rimshot ba dum tss joke sting" },
  { name: "dia-xuoc", vi: "Đĩa xước (khựng lại)", seconds: 1.5, prompt: "a record scratch stopping the music suddenly" },
  { name: "tim-dap", vi: "Tim đập", seconds: 3, prompt: "a loud nervous heartbeat thumping" },
  { name: "tien-roi", vi: "Tiền rơi", seconds: 2, prompt: "coins dropping and jingling on a desk" },
  { name: "chuong-dt", vi: "Chuông điện thoại", seconds: 2.5, prompt: "a smartphone notification ringtone, short melody" },
  { name: "go-phim", vi: "Gõ phím", seconds: 3, prompt: "fast typing on a computer keyboard" },
  { name: "vo-tay", vi: "Vỗ tay", seconds: 2.5, prompt: "a small group clapping politely" },
];

const AUDIOGEN = fileURLToPath(new URL("../scripts/audiogen.py", import.meta.url));
export const sfxDir = (root: string) => join(root, "series", "sfx");

/** The sounds that have been made, for Muse Spark to pick from. */
export const availableSfx = (root: string): Sound[] => {
  const dir = sfxDir(root);
  const have = existsSync(dir) ? new Set(readdirSync(dir)) : new Set<string>();
  return SOUNDS.filter((s) => have.has(`${s.name}.wav`));
};

export const sfxFile = (root: string, name: string | undefined): string | undefined => {
  const f = name ? join(sfxDir(root), `${name}.wav`) : "";
  return f && existsSync(f) ? f : undefined;
};

/** Makes the missing sounds (or `only`) with AudioGen. */
export function makeSfx(root: string, opts: { only?: string[]; log?: (s: string) => void } = {}): number {
  const dir = sfxDir(root);
  mkdirSync(dir, { recursive: true });
  let made = 0;
  for (const s of SOUNDS) {
    const out = join(dir, `${s.name}.wav`);
    if (opts.only ? !opts.only.includes(s.name) : existsSync(out)) continue;
    opts.log?.(`sfx: AudioGen ${s.name} "${s.prompt}"`);
    const r = spawnSync(python(), [AUDIOGEN, out, String(s.seconds), s.prompt], { encoding: "utf8" });
    if (r.status !== 0 || !existsSync(out)) {
      opts.log?.(`sfx ${s.name} failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-2).join(" ")}`);
      continue;
    }
    made++;
  }
  return made;
}

/** ffmpeg arguments that lay `sfx` over the music (input 1) at `at` seconds, as input 2: the filter and the output label. */
export function sfxMix(music: boolean, at: number, end: number): string {
  const ms = Math.max(0, Math.round(at * 1000));
  const m = music ? `[1:a]afade=t=in:d=0.3,afade=t=out:st=${(end - 1.2).toFixed(2)}:d=1.2[m]` : "[1:a]anull[m]";
  return `${m};[2:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${ms}|${ms},volume=0.9[s];[m]aformat=sample_rates=44100:channel_layouts=stereo[m2];[m2][s]amix=inputs=2:duration=first:normalize=0[a]`;
}
