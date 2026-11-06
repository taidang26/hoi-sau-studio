/**
 * Thư viện nhạc: instrumental tracks made once with MusicGen (Meta, local GPU) and reused,
 * instead of one MusicGen run per meme (a minute of GPU each, and with a fixed seed the same
 * prompt gave nearly the same tune every time anyway). A meme takes the track of its mood
 * used least, so the feed does not play one tune all week.
 *
 *   series/music/<mood>-<n>.wav   the tracks, a little longer than the longest meme
 *   series/music/used.json        how often each was used
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Mood {
  name: string;
  vi: string;
  prompt: string;
}

/** The default mood's prompt is the one the dashboard has always sent, so existing memes map onto it. */
export const MOODS: Mood[] = [
  { name: "vui-nhon", vi: "Vui nhộn (mặc định)", prompt: "light playful lo-fi office background music, soft marimba and pizzicato, no vocals" },
  { name: "chan", vi: "Chán, uể oải", prompt: "slow sleepy lo-fi beat, lazy bass, soft electric piano, bored office afternoon, no vocals" },
  { name: "hi-hung", vi: "Hí hửng", prompt: "bouncy cheerful ukulele and glockenspiel, upbeat happy little tune, no vocals" },
  { name: "deadline", vi: "Căng thẳng, deadline", prompt: "tense ticking pizzicato strings and light percussion, comedic suspense, rushing, no vocals" },
  { name: "buon", vi: "Buồn cười ra nước mắt", prompt: "melancholic comedic piano with a sad violin, mock-dramatic, no vocals" },
];

export const TRACK_SECONDS = 22;
export const musicDir = (root: string) => join(root, "series", "music");

const tracks = (dir: string, mood: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(`${mood}-`) && f.endsWith(".wav")).sort() : []);

/** The mood a meme's music prompt stands for: an exact prompt or a mood name; the default otherwise. */
export const moodOf = (prompt: string): Mood => MOODS.find((m) => m.prompt === prompt.trim() || m.name === prompt.trim()) ?? MOODS[0];

/** Makes the missing tracks: `count` per mood, each with its own seed. `gen(out, seconds, prompt, seed)` runs MusicGen. */
export function makeLibrary(root: string, gen: (out: string, seconds: number, prompt: string, seed: number) => void, count = 4, log?: (s: string) => void): number {
  const dir = musicDir(root);
  mkdirSync(dir, { recursive: true });
  let made = 0;
  for (const m of MOODS)
    for (let n = 1; n <= count; n++) {
      const out = join(dir, `${m.name}-${n}.wav`);
      if (existsSync(out)) continue;
      log?.(`music library: ${m.name} ${n}/${count}`);
      gen(out, TRACK_SECONDS, m.prompt, n);
      made++;
    }
  return made;
}

/**
 * Copies the least used track of the prompt's mood to `out` and counts the use. Returns false when
 * the library has no track for it (the meme then makes its own) or the clip is longer than a track.
 */
export function takeTrack(root: string, prompt: string, out: string, seconds: number, log?: (s: string) => void): boolean {
  const dir = musicDir(root), mood = moodOf(prompt);
  const list = tracks(dir, mood.name);
  if (!list.length || seconds > TRACK_SECONDS - 0.5) return false;
  const usedFile = join(dir, "used.json");
  const used: Record<string, number> = existsSync(usedFile) ? JSON.parse(readFileSync(usedFile, "utf8")) : {};
  const pick = [...list].sort((a, b) => (used[a] ?? 0) - (used[b] ?? 0) || a.localeCompare(b))[0];
  copyFileSync(join(dir, pick), out);
  used[pick] = (used[pick] ?? 0) + 1;
  writeFileSync(usedFile, JSON.stringify(used, null, 1));
  log?.(`music: ${pick} from the library (${mood.vi})`);
  return true;
}
