#!/usr/bin/env node
/**
 *   npm run talk -- art <slug> [--pose sit|stand] [--mock] [--only explain,shock] [--force]   draw the talk pictures once (Muse Image + SAM 3.1)
 *                    --pose stand: waist-up on a plain wall, no desk (art in characters/<slug>/talk-stand); cut/sync/make take --pose too
 *   npm run talk -- make <slug> [--topic "..."] [--like sample-transcript.json] [--seconds 30] [--script file.json] [--voice dir] [--music file] [--tts seamless|mms|mms-hn] [--mock]
 *                    Muse Spark writes, safety gate, SeamlessM4T v2 speaks (--tts mms: MMS-TTS; mms-hn: our Hà Nội fine-tune in TALK_HN_MODEL; or --voice recordings 01.wav...), render 1080x1920
 *   npm run talk -- sync <slug> <sound|video> [--lyrics file.txt] [--vocals stem.wav] [--start s] [--duration s] [--mock]
 *                    lip-sync to an existing sound: Muse Voice Transcribe times the words, Muse Spark picks gestures
 *   npm run talk -- cut <slug> [--phrase "cartoon character"] [--keep desk|none] [--force]  SAM 3.1 cuts the character (and desk) out
 *   npm run talk -- sets [--only office,cafe] [--force]                    Muse Image draws empty background sets in series/sets/
 *                    make/sync take --bg plain[:#hex], office|pantry|phong-tro|cafe, or photo.jpg: the cut-out character stands in front of it
 *   npm run talk -- illustrate <slug> <clip.mp4> [--vocals stem.wav] [--lines lines.json] [--end s] [--step plan|draw|poses|stabilize|render|all] [--only s01,s02] [--out dir]
 *                    the clip's voice and cuts, one picture per shot of <slug> acting it out (Muse Image, checked by Muse Spark), two poses on one background (SAM 3.1)
 *   npm run talk -- demo                                                   offline: mock pictures, hummed voice
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeVideo, reelsProblems } from "@hoi-sau/motion";
import { openStudio } from "@hoi-sau/studio";
import { Sam } from "@hoi-sau/dance";
import { cutTalkArt, drawTalkArt, loadArt, talkDir, type Pose } from "./art.js";
import { drawSets, resolveBackground, setsDir } from "./sets.js";
import { GESTURES } from "./gestures.js";
import { renderTalk, silentCopy } from "./render.js";
import { gateMouth, linesFromWords, readSound, soundVoice, stageLines, timeLyrics, toWords, voicedRegions } from "./sync.js";
import { MuseTranscribe, type TimedWord } from "./transcribe.js";
import { checkScript, PACE, writeScript, type TalkScript } from "./script.js";
import { buildTimeline, FPS } from "./timeline.js";
import { mouthTrack, ttsArg, voiceFor, type Tts } from "./voice.js";
import { drawPoses, drawShots, groupLines, hearWords, planShots, renderIllustrated, sceneCuts, shotSpans, stabilizePoses, timeWords, type Line, type Plan } from "./illustrate.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CHARACTERS = join(ROOT, "characters");
const SETS_DIR = setsDir(join(ROOT, "series"));
const fromCwd = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));

function flags(argv: string[]) {
  const pos: string[] = [];
  const opt: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) opt[a.slice(2)] = argv[++i];
      else opt[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

function loadDotEnv(file = join(ROOT, ".env")): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);

interface MakeOptions {
  mock: boolean;
  background?: string;
  topic?: string;
  /** A sample's words to copy the shape of (hook, rhythm, punchline), never the words. */
  like?: string;
  seconds: number;
  script?: string;
  voice?: string;
  tts: Tts;
  music?: string;
  out: string;
  artDir: string;
  pose?: Pose;
  log: (s: string) => void;
}

async function make(slug: string, o: MakeOptions) {
  const ctx = openStudio({ mock: o.mock, log: o.log });
  mkdirSync(o.out, { recursive: true });
  const art = await ensureArt(slug, o);
  const script: TalkScript = o.script ? JSON.parse(readFileSync(o.script, "utf8")) : await writeScript(ctx, slug, { topic: o.topic, like: o.like ? sampleText(o.like) : undefined, seconds: o.seconds, pace: PACE[o.tts], mock: o.mock });
  writeFileSync(join(o.out, "script.json"), JSON.stringify(script, null, 2) + "\n");
  const verdict = await checkScript(ctx, slug, script);
  writeFileSync(join(o.out, "safety.json"), JSON.stringify(verdict, null, 2) + "\n");
  if (!verdict.pass) throw new Error(`Safety gate failed: ${verdict.issues.map((i) => `${i.where}: ${i.topic}`).join("; ")}. See ${join(o.out, "safety.json")}.`);
  o.log(`script: ${script.lines.length} lines, gestures ${script.lines.map((l) => l.gesture).join(" ")}`);

  const voice = await voiceFor(script.lines.map((l) => l.text), o.out, { mock: o.mock, recorded: o.voice, tts: o.tts });
  const frames = Math.ceil((voice.pcm.length / voice.rate) * FPS);
  const { frames: timeline, chunks } = buildTimeline({
    lines: script.lines,
    voice,
    mouth: mouthTrack(voice, FPS, frames),
    canMouth: (g) => !!art.gestures[g]?.mouth,
    canBlink: (g) => !!art.gestures[g]?.blink,
    frames,
  });
  const out = join(o.out, `${slug}.mp4`);
  const r = await renderTalk({ art, artDir: o.artDir, frames: timeline, chunks, title: script.title, voice, background: o.background, out, music: o.music, log: o.log });
  writeFileSync(join(o.out, "post.txt"), `${script.caption}\n`);
  const info = await probeVideo(r.video);
  const problems = reelsProblems(info);
  console.log(`${r.video} (${info.duration.toFixed(1)} s, ${info.width}x${info.height})`);
  console.log(problems.length ? `Reels check: ${problems.join("; ")}` : "Reels check: ok for Facebook/Instagram Reels and TikTok");
}

const backgroundArg = (bg: string) => {
  const r = resolveBackground(bg, SETS_DIR);
  return r.startsWith("plain") ? r : fromCwd(r);
};

/** A sample's words from a transcript.json, a script.json or plain text. */
function sampleText(file: string): string {
  const raw = readFileSync(file, "utf8");
  try {
    const j = JSON.parse(raw);
    return j.text ?? (j.lines ?? []).map((l: { text: string }) => l.text).join("\n");
  } catch {
    return raw;
  }
}

async function ensureArt(slug: string, o: { mock: boolean; artDir: string; pose?: Pose; log: (s: string) => void }) {
  let art = loadArt(o.artDir);
  if (!art || GESTURES.some((g) => !art!.gestures[g.id])) {
    o.log("drawing the talk pictures first (once per character)");
    art = await drawTalkArt(openStudio({ mock: o.mock, log: o.log }), slug, o.artDir, { sam: o.mock ? undefined : Sam.fromEnv(), pose: o.pose, log: o.log });
  }
  return art;
}

interface SyncOptions {
  mock: boolean;
  background?: string;
  /** The voice alone (e.g. a Demucs vocals stem) for the mouth, when the sound has music under it. */
  vocals?: string;
  lyrics?: string;
  start?: number;
  duration?: number;
  out: string;
  artDir: string;
  pose?: Pose;
  log: (s: string) => void;
}

async function sync(slug: string, media: string, o: SyncOptions) {
  const ctx = openStudio({ mock: o.mock, log: o.log });
  mkdirSync(o.out, { recursive: true });
  const art = await ensureArt(slug, o);
  const sound = join(o.out, "sound.m4a");
  let pcm = await readSound(media, sound, { start: o.start, duration: o.duration });
  if (o.vocals) pcm = await readSound(o.vocals, join(o.out, "vocals.m4a"), { start: o.start, duration: o.duration });
  let lines: TimedWord[][];
  if (o.lyrics) {
    lines = timeLyrics(readFileSync(o.lyrics, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean), voicedRegions(pcm));
  } else if (o.mock) {
    lines = timeLyrics(["Mọi người ơi nghe em kể", "Hôm nay sếp gọi em lên phòng", "Em run quá trời luôn"], voicedRegions(pcm));
  } else {
    const t = await MuseTranscribe.fromEnv().transcribe(sound);
    writeFileSync(join(o.out, "transcript.json"), JSON.stringify(t, null, 2) + "\n");
    if (!t.words.length) throw new Error("Muse Voice Transcribe heard no words. Pass the words with --lyrics file.txt (one line each).");
    lines = t.segments.length && !t.words.some((w, i) => i && w.start !== t.words[i - 1].end) ? t.segments.map((s) => t.words.filter((w) => w.start >= s.start - 0.01 && w.end <= s.end + 0.01)).filter((l) => l.length) : linesFromWords(t.words);
  }
  const texts = lines.map((l) => l.map((w) => w.word).join(" "));
  const script = await stageLines(ctx, slug, texts, o.mock);
  writeFileSync(join(o.out, "script.json"), JSON.stringify({ ...script, timing: lines }, null, 2) + "\n");
  const verdict = await checkScript(ctx, slug, script);
  writeFileSync(join(o.out, "safety.json"), JSON.stringify(verdict, null, 2) + "\n");
  if (!verdict.pass) throw new Error(`Safety gate failed: ${verdict.issues.map((i) => `${i.where}: ${i.topic}`).join("; ")}. See ${join(o.out, "safety.json")}.`);
  o.log(`${lines.length} lines, gestures ${script.lines.map((l) => l.gesture).join(" ")}`);

  const voice = soundVoice(pcm, lines);
  const frames = Math.ceil((pcm.length / voice.rate) * FPS);
  const { frames: timeline, chunks } = buildTimeline({
    lines: script.lines,
    voice,
    mouth: gateMouth(mouthTrack(voice, FPS, frames), lines, FPS),
    canMouth: (g) => !!art.gestures[g]?.mouth,
    canBlink: (g) => !!art.gestures[g]?.blink,
    frames,
    words: lines.map(toWords),
  });
  const out = join(o.out, `${slug}.mp4`);
  const r = await renderTalk({ art, artDir: o.artDir, frames: timeline, chunks, title: script.title, voice, audio: sound, background: o.background, out, log: o.log });
  const silent = await silentCopy(r.video);
  writeFileSync(join(o.out, "post.txt"), `${script.caption}\n`);
  const info = await probeVideo(r.video);
  const problems = reelsProblems(info);
  console.log(`${r.video} (${info.duration.toFixed(1)} s, ${info.width}x${info.height})`);
  console.log(`${silent} (no sound: pick the same sound in the app when posting)`);
  console.log(problems.length ? `Reels check: ${problems.join("; ")}` : "Reels check: ok for Facebook/Instagram Reels and TikTok");
}

async function main() {
  loadDotEnv();
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = flags(rest);
  const log = (s: string) => console.error(s);
  const pose: Pose = opt.pose === "stand" ? "stand" : "sit";
  switch (cmd) {
    case "art": {
      const slug = pos[0];
      if (!slug) throw new Error("Usage: talk art <slug> [--mock] [--only a,b] [--force]");
      const mock = !!opt.mock;
      const dir = mock ? join(ROOT, "data-demo", "talk", "art", slug) : talkDir(CHARACTERS, slug, pose);
      await drawTalkArt(openStudio({ mock, log }), slug, dir, { sam: mock ? undefined : Sam.fromEnv(), only: opt.only ? String(opt.only).split(",") : undefined, force: !!opt.force, pose, log });
      console.log(dir);
      return;
    }
    case "sets": {
      const files = await drawSets(openStudio({ mock: !!opt.mock, log }), SETS_DIR, { only: opt.only ? String(opt.only).split(",") : undefined, force: !!opt.force, log });
      console.log(files.join("\n"));
      return;
    }
    case "cut": {
      const slug = pos[0];
      if (!slug) throw new Error('Usage: talk cut <slug> [--phrase "cartoon character"] [--force]');
      const dir = talkDir(CHARACTERS, slug, pose);
      const art = loadArt(dir);
      if (!art) throw new Error(`No talk pictures for ${slug} yet. Draw them: npm run talk -- art ${slug}`);
      await cutTalkArt(Sam.fromEnv(), dir, art, (opt.phrase as string) || "cartoon character", { force: !!opt.force, keep: opt.keep === "none" || (pose === "stand" && !opt.keep) ? undefined : (opt.keep as string) || "desk", log });
      console.log(dir);
      return;
    }
    case "sync": {
      const [slug, media] = pos;
      if (!slug || !media) throw new Error("Usage: talk sync <slug> <sound|video> [--lyrics file.txt] [--start s] [--duration s]");
      const mock = !!opt.mock;
      await sync(slug, fromCwd(media), {
        mock,
        lyrics: opt.lyrics ? fromCwd(opt.lyrics as string) : undefined,
        background: opt.bg ? backgroundArg(opt.bg as string) : undefined,
        vocals: opt.vocals ? fromCwd(opt.vocals as string) : undefined,
        start: opt.start ? Number(opt.start) : undefined,
        duration: opt.duration ? Number(opt.duration) : undefined,
        out: opt.out ? fromCwd(opt.out as string) : join(ROOT, mock ? "data-demo" : "data", "talk", `${slug}-sync-${stamp()}`),
        artDir: mock ? join(ROOT, "data-demo", "talk", "art", slug) : talkDir(CHARACTERS, slug, pose),
        pose,
        log,
      });
      return;
    }
    case "illustrate": {
      const [slug, clip] = pos;
      if (!slug || !clip) throw new Error("Usage: talk illustrate <slug> <clip.mp4> [--vocals stem.wav] [--lines lines.json] [--step plan|draw|poses|stabilize|render|all]");
      const out = opt.out ? fromCwd(opt.out as string) : join(ROOT, "data", "talk", `${slug}-illustrate-${stamp()}`);
      mkdirSync(out, { recursive: true });
      const step = String(opt.step ?? "all");
      const only = opt.only ? String(opt.only).split(",") : undefined;
      const ctx = openStudio({ log });
      const planFile = join(out, "plan.json"), wordsFile = join(out, "words.json"), shots = join(out, "shots");
      const run = (s: string) => step === "all" || step === s;
      if (run("plan") && (step === "plan" || !existsSync(planFile))) {
        const heard = await hearWords(opt.vocals ? fromCwd(opt.vocals as string) : fromCwd(clip), wordsFile);
        // Corrected lines (text, start, end) when given; otherwise the recogniser's words split at pauses.
        const lines: Line[] = opt.lines ? JSON.parse(readFileSync(fromCwd(opt.lines as string), "utf8")) : groupLines(heard);
        const end = opt.end ? Number(opt.end) : (await probeVideo(fromCwd(clip))).duration;
        const shotsPlan = await planShots(ctx, slug, lines, shotSpans(lines, sceneCuts(fromCwd(clip)), end));
        writeFileSync(planFile, JSON.stringify({ slug, clip: fromCwd(clip), end, lines, shots: shotsPlan } satisfies Plan, null, 2) + "\n");
        log(`${planFile}: ${lines.length} lines, ${shotsPlan.length} shots (edit it before drawing if needed)`);
      }
      const plan: Plan = JSON.parse(readFileSync(planFile, "utf8"));
      if (run("draw")) await drawShots(ctx, plan, shots, { only, log });
      if (run("poses")) await drawPoses(ctx, plan, shots, { only, log });
      if (run("stabilize")) writeFileSync(join(out, "stabilize.json"), JSON.stringify(await stabilizePoses(Sam.fromEnv(), ctx, plan, shots, { only, log }), null, 1));
      if (run("render")) {
        const heard = JSON.parse(readFileSync(wordsFile, "utf8"));
        const video = await renderIllustrated(plan, timeWords(plan.lines, heard), shots, join(out, `${slug}.mp4`), { log });
        await silentCopy(video);
        const problems = reelsProblems(await probeVideo(video));
        log(problems.length ? `Reels check: ${problems.join("; ")}` : "Reels check: ok for Facebook/Instagram Reels and TikTok");
        console.log(video);
      }
      return;
    }
    case "make":
    case "demo": {
      const slug = cmd === "demo" ? "cu-li" : pos[0];
      if (!slug) throw new Error("Usage: talk make <slug> [--topic ...]");
      const mock = cmd === "demo" || !!opt.mock;
      await make(slug, {
        mock,
        topic: opt.topic as string | undefined,
        background: opt.bg ? backgroundArg(opt.bg as string) : undefined,
        like: opt.like ? fromCwd(opt.like as string) : undefined,
        seconds: Number(opt.seconds ?? 30),
        script: opt.script ? fromCwd(opt.script as string) : undefined,
        voice: opt.voice ? fromCwd(opt.voice as string) : undefined,
        tts: ttsArg(opt.tts),
        music: opt.music ? fromCwd(opt.music as string) : undefined,
        out: opt.out ? fromCwd(opt.out as string) : join(ROOT, mock ? "data-demo" : "data", "talk", `${slug}-${stamp()}`),
        artDir: mock ? join(ROOT, "data-demo", "talk", "art", slug) : talkDir(CHARACTERS, slug, pose),
        pose,
        log,
      });
      return;
    }
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(2, 12).join("\n").replace(/^ \*/gm, ""));
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
