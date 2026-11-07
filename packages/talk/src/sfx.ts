/**
 * Âm thanh hiệu ứng: short sound effects made once with AudioGen (Meta AudioCraft, on the owner's GPU)
 * and dropped on the punchline of a meme, the way office meme pages do (a "ting", crickets, a sigh).
 *
 *   series/sfx/<name>.wav          one sound each (AudioGen, the fallback)
 *   series/sfx/_lib/<name>-env.*   the same names from Envato (licensed), -fs from Freesound (CC0)
 *   series/sfx/_meme/<name>.*      internet meme sounds (vine boom, bruh, Sad Violin, FAHHH…)
 *
 * The house recipe (Tài, 7/11, clips meme-25..34): Envato music of the mood; when the punchline
 * appears one hit (vine boom, whoosh, or a record scratch that cuts the music), then one meme
 * reaction (bruh, Sad Violin, FAHHH, applause, ba dum tss). Meme and Envato sounds come first;
 * AudioGen only when nothing else has the sound.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
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

/** Sounds Envato added that AudioGen never made. */
const EXTRA: Record<string, string> = {
  vut: "a fast whoosh", whoosh: "a fast whoosh", bup: "a cartoon pop", pop: "a cartoon pop",
  "swoosh-chu": "a quick swoosh as text pops in", "thong-bao": "a phone message notification", "cua-mo": "a door opening",
  "tieng-cuoi": "an audience laughing", gasp: "a room of people gasping in shock", "xe-may": "a motorbike passing by",
  mua: "rain falling", "van-phong-on": "busy office background noise",
};

const AUDIO = new Set([".wav", ".mp3", ".ogg", ".m4a"]);
const audioFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => AUDIO.has(extname(f).toLowerCase())).sort() : []);

/** Titles a download kept in sources*.json next to it ({file|name, title}), when there are any. */
function titles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => /^sources.*\.json$/.test(x)) : []) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
      const list = Array.isArray(raw) ? raw : Object.entries(raw as Record<string, unknown>).map(([k, v]) => ({ file: k, ...(v && typeof v === "object" ? (v as object) : { title: v }) }));
      for (const e of list as Array<Record<string, unknown>>) {
        const key = String(e.file ?? e.name ?? "").replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]+$/i, "");
        const title = e.title ?? e.vi ?? e.label;
        if (key && typeof title === "string") out[key] = title;
      }
    } catch {
      /* a broken sources file only loses the titles */
    }
  }
  return out;
}

export interface LibSound extends Sound {
  file: string;
  /** "meme": an internet meme sound (trimmed to 3 s); "sfx": a plain effect. */
  kind: "meme" | "sfx";
}

/**
 * Every sound on hand, one file per name. A name resolves to the meme sound first (_meme), then
 * Envato (_lib/<name>-env), Freesound (_lib/<name>-fs), and AudioGen (series/sfx/<name>.wav) last.
 */
export function soundLibrary(root: string): LibSound[] {
  const dir = sfxDir(root), lib = join(dir, "_lib"), meme = join(dir, "_meme");
  const known = new Map(SOUNDS.map((s) => [s.name, s]));
  const pick = new Map<string, { file: string; rank: number; kind: "meme" | "sfx" }>();
  const offer = (name: string, file: string, rank: number, kind: "meme" | "sfx") => {
    const had = pick.get(name);
    if (!had || rank < had.rank) pick.set(name, { file, rank, kind });
  };
  for (const f of audioFiles(meme)) offer(f.replace(/\.[^.]+$/, ""), join(meme, f), 0, "meme");
  for (const f of audioFiles(lib)) {
    const m = /^(.+?)-(env|fs)\.[^.]+$/i.exec(f);
    if (m) offer(m[1], join(lib, f), m[2].toLowerCase() === "env" ? 1 : 2, "sfx");
  }
  for (const f of audioFiles(dir)) offer(f.replace(/\.[^.]+$/, ""), join(dir, f), 3, "sfx");
  const said = titles(meme);
  return [...pick]
    .map(([name, { file, kind }]) => {
      const k = known.get(name);
      const prompt = kind === "meme" ? `internet meme sound "${said[name] ?? name.replace(/[-_]+/g, " ")}"` : (k?.prompt ?? EXTRA[name] ?? name.replace(/-/g, " "));
      return { name, vi: k?.vi ?? said[name] ?? name, seconds: k?.seconds ?? 2, prompt, file, kind };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One sound of a meme: `at` seconds from the punchline (negative = before it), its volume, an optional trim. */
export interface PlannedSound { name: string; at: number; volume?: number; trim?: number }

/**
 * The music around the punchline: "keep" plays on to the end, "stop" cuts it as the punchline lands
 * (the letdown beat), "switch" cuts it and starts `musicB` (another mood) just after.
 */
export type MusicTurn = "keep" | "stop" | "switch";

export interface SoundPlan {
  turn: MusicTurn;
  /** The mood of the second track for "switch". */
  musicB?: string;
  sounds: PlannedSound[];
}

/** Meme sounds are cut to 3 s (a long spoken one would talk over the clip). */
export const MEME_MAX = 3;

/**
 * ffmpeg filter for the house mix (clips meme-25..34). Input 1 is music A (or silence); with
 * "switch", input 2 is music B; the sounds follow in order. `cut` is when the punchline appears.
 *   music A  loudnorm -21, fade in 0.2; to the end with a 1.2 s fade, or cut at cut-0.05 (0.1 s fade)
 *   music B  from cut+0.35, loudnorm -22, fade in 0.4, out over the last 1.3 s
 *   sounds   (trim with a 0.3 s fade) loudnorm -15, volume, at cut+at
 *   all      amix without normalising, cut to the clip, limiter 0.6, then loudnorm -14.5 LUFS, true peak -1.5 dBTP (stays under 0 after AAC)
 */
/** How much earlier than the picture a sound starts. */
export const LEAD = 0.07;

export function houseMix(o: { music: boolean; turn: MusicTurn; musicB: boolean; cut: number; end: number; sounds: Array<{ at: number; volume?: number; trim?: number }> }): string {
  const fmt = "aformat=sample_rates=44100:channel_layouts=stereo";
  const parts: string[] = [];
  const cutA = o.turn !== "keep";
  const outA = cutA ? `afade=t=out:st=${Math.max(0, o.cut - 0.05).toFixed(2)}:d=0.1` : `afade=t=out:st=${Math.max(0, o.end - 1.2).toFixed(2)}:d=1.2`;
  parts.push(o.music ? `[1:a]loudnorm=I=-21:TP=-3,afade=t=in:d=0.2,${outA},${fmt}[ma]` : `[1:a]${fmt}[ma]`);
  const mix = ["[ma]"];
  let next = 2;
  if (o.musicB && o.turn === "switch") {
    const start = o.cut + 0.35, ms = Math.round(start * 1000), len = Math.max(0.5, o.end - start);
    parts.push(`[2:a]loudnorm=I=-22:TP=-3,afade=t=in:d=0.4,afade=t=out:st=${Math.max(0, len - 1.3).toFixed(2)}:d=1.3,${fmt},adelay=${ms}|${ms}[mb]`);
    mix.push("[mb]");
    next = 3;
  }
  o.sounds.forEach((s, i) => {
    // A sound lands 2 frames (0.07 s) before the picture: on time to the ear; late by 0.2 s already feels off.
    const ms = Math.max(0, Math.round((o.cut + s.at - LEAD) * 1000));
    const trim = s.trim ? `atrim=0:${s.trim.toFixed(2)},afade=t=out:st=${Math.max(0, s.trim - 0.3).toFixed(2)}:d=0.3,` : "";
    parts.push(`[${next + i}:a]${trim}loudnorm=I=-15:TP=-2,volume=${(s.volume ?? 1).toFixed(2)},${fmt},adelay=${ms}|${ms}[s${i}]`);
    mix.push(`[s${i}]`);
  });
  parts.push(`${mix.join("")}amix=inputs=${mix.length}:duration=longest:normalize=0,atrim=0:${o.end.toFixed(2)},alimiter=limit=0.6,loudnorm=I=-14.5:TP=-1.5:LRA=11,aresample=44100[a]`);
  return parts.join(";");
}

/** The house recipe, for the planner prompt and the dashboard. */
export const SOUND_RECIPE = [
  "One cut sound right on the punchline (at 0): a record scratch (dia-xuoc) when the mood flips, vine-boom for a reveal, a whoosh just before (-0.25) a cartoon reaction.",
  "Then one or two reaction sounds a beat later (+0.1 to +2.8) that match the feeling: sad-violin for misery, a laugh or ba-dum-tss for a gag, bruh or huh for something absurd, applause for a fake victory.",
  "When the punchline is a letdown, switch the music at the cut to another mood (turn = switch, music_b, e.g. buon); otherwise keep it. Never leave the end without music.",
  "Prefer the internet meme sounds; a spoken Vietnamese meme is cut to 3 s. Volume 0.7-0.9 for the second and third sounds.",
].join(" ");

/** ffmpeg arguments that lay `sfx` over the music (input 1) at `at` seconds, as input 2: the filter and the output label. */
export function sfxMix(music: boolean, at: number, end: number): string {
  const ms = Math.max(0, Math.round(at * 1000));
  const m = music ? `[1:a]afade=t=in:d=0.3,afade=t=out:st=${(end - 1.2).toFixed(2)}:d=1.2[m]` : "[1:a]anull[m]";
  return `${m};[2:a]loudnorm=I=-20:TP=-3,aformat=sample_rates=44100:channel_layouts=stereo,adelay=${ms}|${ms},volume=0.9[s];[m]aformat=sample_rates=44100:channel_layouts=stereo[m2];[m2][s]amix=inputs=2:duration=first:normalize=0[a]`;
}
