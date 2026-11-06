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
 *   npm run talk -- illustrate <slug> <clip.mp4> [--vocals stem.wav] [--lines lines.json (corrected lines; also lets the plan run without the speech recogniser)] [--end s] [--step plan|draw|fix|ask|gaps|poses|stabilize|mouths|review|render|all] [--find <thing>] [--at <s>] [--only s01] [--note <what to change>] [--mouth] [--no-beats (cuts stay where the plan puts them, not on the beat)] [--max-shot s (longest shot the plan makes; 3 for a fast song)] [--accept-review (render although the review flagged blocking faults)] [--retries n (pose B redraws before a shot keeps one pose; default 2). TALK_MOUTH_TRIES=n: open-mouth tries, default 3] [--only s01,s02] [--out dir]
 *                    the clip's voice and cuts, one picture per shot of <slug> acting it out (Muse Image, checked by Muse Spark), two poses on one background (SAM 3.1)
 *   npm run talk -- cover <slug> --out <illustrate dir> --quote "“line|line *key*.”" [--shot s08] [--episode <id>]
 *                    TikTok cover: the line on a white badge (key words red) + "Hồi Sau" tag over a shot, inside the grid's safe zone and off the faces (SAM 3.1)
 *   npm run talk -- meme <slug> --out <dir with meme.json> [--step plan|draw|fix|ask|retime|poses|stabilize|music|blink|render|all] [--find <thing>] [--at <s>] [--only s01] [--note <what to change>]
 *                    silent text meme: two beats of big text over one or two pictures (two poses, still background), MusicGen music
 *   npm run talk -- demo                                                   offline: mock pictures, hummed voice
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeVideo, reelsProblems } from "@hoi-sau/motion";
import { episodeDir, openStudio } from "@hoi-sau/studio";
import { Sam } from "@hoi-sau/dance";
import { cutTalkArt, drawTalkArt, loadArt, talkDir, type Pose } from "./art.js";
import { drawSets, resolveBackground, setsDir } from "./sets.js";
import { GESTURES } from "./gestures.js";
import { renderTalk, silentCopy } from "./render.js";
import { gateMouth, linesFromWords, readSound, soundVoice, stageLines, timeLyrics, toWords, voicedRegions } from "./sync.js";
import { MuseTranscribe, type TimedWord } from "./transcribe.js";
import { checkScript, PACE, writeScript, type TalkScript } from "./script.js";
import { buildTimeline, FPS } from "./timeline.js";
import { mouthTrack, RATE, ttsArg, voiceFor, type Tts } from "./voice.js";
import { facesBox, makeCover } from "./cover.js";
import sharp from "sharp";
import { makeBlink, makeMusic, planMeme, readMeme, renderMeme, retimeMeme } from "./meme.js";
import { makeLibrary, MOODS, takeTrack } from "./music-lib.js";
import { kitSheet, loadKit, makeMouthKit, type Angle } from "./mouthkit.js";
import { approveStock, availableStock, loadStock, makeStock, REACTIONS, stockSheet, useStock } from "./stock.js";
import { askFixes, speechGaps } from "./fixes.js";
import { ideaImages, readIdea } from "./idea.js";
import { drawMouths, drawPoses, drawShots, reviewShots, fixShot, gateToWords, groupLines, hearWords, planShots, renderIllustrated, sceneCuts, shotSpans, stabilizePoses, timeWords, type Line, type Plan } from "./illustrate.js";
import { detectBeats } from "./beats.js";

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
      if (!slug || !clip) throw new Error("Usage: talk illustrate <slug> <clip.mp4> [--vocals stem.wav] [--lines lines.json] [--step plan|draw|fix|ask|gaps|poses|stabilize|mouths|review|render|all] [--find <thing>] [--at <s>] [--only s01] [--note <what to change>] [--mouth]");
      const out = opt.out ? fromCwd(opt.out as string) : join(ROOT, "data", "talk", `${slug}-illustrate-${stamp()}`);
      mkdirSync(out, { recursive: true });
      const step = String(opt.step ?? "all");
      const only = opt.only ? String(opt.only).split(",") : undefined;
      const ctx = openStudio({ log });
      const planFile = join(out, "plan.json"), wordsFile = join(out, "words.json"), shots = join(out, "shots");
      const run = (s: string) => step === "all" || step === s;
      if (run("plan") && (step === "plan" || !existsSync(planFile))) {
        // With corrected --lines the recogniser only refines word times: when it cannot run (no Python, no model), words are spread over each line instead.
        const heard = await hearWords(opt.vocals ? fromCwd(opt.vocals as string) : fromCwd(clip), wordsFile).catch((e: Error) => {
          if (!opt.lines) throw e;
          log(`Word times not heard (${e.message}); spreading the words over each line of --lines`);
          writeFileSync(wordsFile, "[]\n");
          return [];
        });
        // Corrected lines (text, start, end) when given; otherwise the recogniser's words split at pauses.
        const lines: Line[] = opt.lines ? JSON.parse(readFileSync(fromCwd(opt.lines as string), "utf8")) : groupLines(heard);
        const end = opt.end ? Number(opt.end) : (await probeVideo(fromCwd(clip))).duration;
        const shotsPlan = await planShots(ctx, slug, lines, shotSpans(lines, sceneCuts(fromCwd(clip)), end, Number(opt["max-shot"]) || 6));
        writeFileSync(planFile, JSON.stringify({ slug, clip: fromCwd(clip), end, lines, shots: shotsPlan } satisfies Plan, null, 2) + "\n");
        log(`${planFile}: ${lines.length} lines, ${shotsPlan.length} shots (edit it before drawing if needed)`);
      }
      const plan: Plan = JSON.parse(readFileSync(planFile, "utf8"));
      if (step === "fix") for (const id of only ?? []) await fixShot(ctx, plan, shots, id, String(opt.note ?? ""), { log, find: opt.find ? String(opt.find) : undefined, sam: opt.find ? Sam.fromEnv() : undefined });
      if (step === "ask") {
        const gaps = existsSync(join(out, "gaps.json")) ? JSON.parse(readFileSync(join(out, "gaps.json"), "utf8")) : [];
        const at = opt.at !== undefined && opt.at !== "" ? Number(opt.at) : undefined;
        writeFileSync(join(out, "fixes.json"), JSON.stringify(await askFixes(ctx, plan, shots, String(opt.note ?? ""), at, gaps), null, 1));
        log(`${join(out, "fixes.json")}: written`);
        return;
      }
      if (run("draw")) await drawShots(ctx, plan, shots, { only, log });
      if (run("poses")) await drawPoses(ctx, plan, shots, { only, log });
      // With --only a report keeps the other shots' rows, so separate --only runs never wipe each other's.
      const report = <T extends Record<string, unknown>>(name: string, key: keyof T, rows: T[]) => {
        const file = join(out, name);
        const old: T[] = only && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
        const mine = new Set(rows.map((r) => r[key]));
        writeFileSync(file, JSON.stringify([...old.filter((r) => !mine.has(r[key])), ...rows], null, 1));
      };
      if (run("stabilize")) report("stabilize.json", "id", await stabilizePoses(Sam.fromEnv(), ctx, plan, shots, { only, retries: Number(opt.retries) || undefined, log }));
      // --mouth: the lead talks; without it the clip renders as before.
      const mouth = !!opt.mouth || step === "mouths";
      if (mouth && run("mouths")) report("mouths.json", "pic", await drawMouths(Sam.fromEnv(), ctx, plan, shots, { only, kit: !opt["no-kit"], log }));
      // --step review: Spark looks at every picture the render will show and lists what is broken (review.json).
      if (step === "review" || step === "all") {
        report("review.json", "pic", await reviewShots(ctx, plan, shots, { only, log }));
        const bad = (JSON.parse(readFileSync(join(out, "review.json"), "utf8")) as Array<{ pic: string; pass: boolean }>).filter((r) => !r.pass);
        log(bad.length ? `Review: ${bad.length} picture(s) need a fix: ${bad.map((r) => r.pic).join(", ")}` : "Review: every picture passed");
      }
      if (run("render") || step === "gaps") {
        const pcm = await readSound(opt.vocals ? fromCwd(opt.vocals as string) : plan.clip, join(out, "voice.m4a"));
        writeFileSync(join(out, "gaps.json"), JSON.stringify(speechGaps(pcm, plan.lines)));
      }
      if (run("render")) {
        // The render says which pictures the last review failed (or that none ran), so nothing ships unchecked.
        const reviewFile = join(out, "review.json");
        const failed = existsSync(reviewFile) ? (JSON.parse(readFileSync(reviewFile, "utf8")) as Array<{ pic: string; pass: boolean; problems: string[] }>).filter((r) => !r.pass) : undefined;
        log(!failed ? "Review: not run; run --step review and look at every flag before sending" : failed.length ? `Review: ${failed.length} picture(s) still flagged: ${failed.map((r) => `${r.pic} (${r.problems[0] ?? ""})`).join("; ")}` : "Review: every picture passed");
        // Extra limbs, duplicates, seams and the like are never waved through: redraw, or say so with --accept-review.
        const blocking = (failed ?? []).filter((r) => (r as { blocking?: boolean }).blocking !== false);
        if (blocking.length && !opt["accept-review"]) throw new Error(`Review found blocking faults in ${blocking.map((r) => r.pic).join(", ")}; redraw them and run --step review again (only cosmetic flags can be accepted, with --accept-review)`);
        const heard = JSON.parse(readFileSync(wordsFile, "utf8"));
        const words = timeWords(plan.lines, heard);
        let track: boolean[] | undefined;
        if (opt.mouth) {
          const pcm = await readSound(opt.vocals ? fromCwd(opt.vocals as string) : plan.clip, join(out, "voice.m4a"));
          const frames = Math.ceil(plan.end * 30);
          track = gateToWords(mouthTrack({ pcm, rate: RATE, spans: [] }, 30, frames), words, 30);
        }
        // Cuts and pose changes snap to the song's beats (heard from the full mix); --no-beats keeps the plan's times.
        let beats: number[] | undefined;
        if (!opt["no-beats"]) {
          const mix = await readSound(plan.clip, join(out, "mix.m4a"));
          const found = detectBeats(mix, RATE);
          writeFileSync(join(out, "beats.json"), JSON.stringify(found));
          log(`Beats: ${found.bpm} bpm, ${found.beats.length} beats`);
          beats = found.beats.filter((b) => b <= plan.end);
        }
        const video = await renderIllustrated(plan, words, shots, join(out, `${slug}${opt.mouth ? "-mouth" : ""}.mp4`), { mouth: track, beats, log });
        await silentCopy(video);
        const problems = reelsProblems(await probeVideo(video));
        log(problems.length ? `Reels check: ${problems.join("; ")}` : "Reels check: ok for Facebook/Instagram Reels and TikTok");
        console.log(video);
      }
      return;
    }
    case "meme": {
      const [slug] = pos;
      if (!slug || !opt.out) throw new Error("Usage: talk meme <slug> --out <dir with meme.json> [--step plan|draw|fix|ask|retime|poses|stabilize|music|blink|render|all] [--find <thing>] [--at <s>] [--only s01] [--note <what to change>]");
      const out = fromCwd(opt.out as string);
      const step = String(opt.step ?? "all");
      const only = opt.only ? String(opt.only).split(",") : undefined;
      const run = (s: string) => step === "all" || step === s;
      const spec = readMeme(out);
      const ctx = openStudio({ log });
      const planFile = join(out, "plan.json"), shots = join(out, "shots"), music = join(out, "music.wav");
      if (step === "retime") {
        // Reading-time pacing on a clip already drawn: --seconds 0 (default) lets the text decide the length.
        spec.seconds = opt.seconds !== undefined ? Number(opt.seconds) : 0;
        writeFileSync(join(out, "meme.json"), JSON.stringify(spec, null, 2) + "\n");
        const p = retimeMeme(JSON.parse(readFileSync(planFile, "utf8")), spec);
        writeFileSync(planFile, JSON.stringify(p, null, 2) + "\n");
        log(`punchline at ${p.lines[1]?.start}s, ${p.end}s long; render again (music is made again for the new length)`);
        rmSync(join(out, "music.prompt"), { force: true });
        return;
      }
      if (run("plan") && (step === "plan" || !existsSync(planFile))) {
        writeFileSync(planFile, JSON.stringify(await planMeme(ctx, slug, spec, availableStock(ctx.charactersDir ?? CHARACTERS, slug)), null, 2) + "\n");
        log(`${planFile}: ${spec.scenes.length} scene(s)`);
      }
      const plan: Plan = JSON.parse(readFileSync(planFile, "utf8"));
      if (step === "fix") for (const id of only ?? []) await fixShot(ctx, plan, shots, id, String(opt.note ?? ""), { log, find: opt.find ? String(opt.find) : undefined, sam: opt.find ? Sam.fromEnv() : undefined });
      if (step === "ask") {
        const gaps = existsSync(join(out, "gaps.json")) ? JSON.parse(readFileSync(join(out, "gaps.json"), "utf8")) : [];
        const at = opt.at !== undefined && opt.at !== "" ? Number(opt.at) : undefined;
        writeFileSync(join(out, "fixes.json"), JSON.stringify(await askFixes(ctx, plan, shots, String(opt.note ?? ""), at, gaps), null, 1));
        log(`${join(out, "fixes.json")}: written`);
        return;
      }
      if (run("draw")) {
        useStock(ctx.charactersDir ?? CHARACTERS, plan, shots, basename(out), log);
        await drawShots(ctx, plan, shots, { only, log });
      }
      if (run("poses")) await drawPoses(ctx, plan, shots, { only, log });
      // With --only a report keeps the other shots' rows, so separate --only runs never wipe each other's.
      const report = <T extends Record<string, unknown>>(name: string, key: keyof T, rows: T[]) => {
        const file = join(out, name);
        const old: T[] = only && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
        const mine = new Set(rows.map((r) => r[key]));
        writeFileSync(file, JSON.stringify([...old.filter((r) => !mine.has(r[key])), ...rows], null, 1));
      };
      if (run("stabilize")) report("stabilize.json", "id", await stabilizePoses(Sam.fromEnv(), ctx, plan, shots, { only, log }));
      // Music once per prompt: a new prompt (or --step music) makes it again.
      const promptFile = join(out, "music.prompt");
      const fresh = existsSync(music) && existsSync(promptFile) && readFileSync(promptFile, "utf8") === spec.music;
      if (spec.music.trim() && (step === "music" || ((step === "all" || step === "render") && !fresh))) {
        // A ready track of the same mood when the library has one (talk music-lib), else MusicGen for this clip.
        if (!takeTrack(ROOT, spec.music, music, plan.end, log)) makeMusic(spec.music, plan.end, music, log);
        writeFileSync(promptFile, spec.music);
      }
      // Faces once per picture (faces.json, keyed by picture signature): where to lower each picture, and where its eyes are.
      // A shot that kept one pose still moves: its eyes blink (a shut-eye copy of pose A, found inside the face).
      const faceTop: Record<string, number | undefined> = {};
      if (run("render") || step === "blink") {
        const species = (ctx.profiles.get(slug)?.species ?? "character").split("(")[0].trim();
        const facesFile = join(out, "faces.json");
        const known: Record<string, { sig: string; box?: { x: number; y: number; w: number; h: number } }> = existsSync(facesFile) ? JSON.parse(readFileSync(facesFile, "utf8")) : {};
        for (const s of plan.shots.filter((x) => !x.src)) {
          const a = join(shots, `${s.id}.png`), b2 = join(shots, `${s.id}-b2.png`), blink = join(shots, `${s.id}-blink.png`);
          if (!existsSync(a)) continue;
          const sig = String(statSync(a).mtimeMs);
          if (known[s.id]?.sig !== sig) {
            const rgb = new Uint8Array(await sharp(a).resize(1080, 1920, { fit: "cover" }).removeAlpha().raw().toBuffer());
            known[s.id] = { sig, box: await facesBox(Sam.fromEnv(), rgb, species) };
            writeFileSync(facesFile, JSON.stringify(known, null, 1));
          }
          const face = known[s.id].box;
          faceTop[s.id] = face?.y;
          if ((only && !only.includes(s.id)) || existsSync(b2) || existsSync(blink)) continue;
          if (face) makeBlink(a, blink, face, log);
          else log(`${s.id}: no face found, no blink`);
        }
      }
      if (run("render")) {
        const video = await renderMeme(plan, shots, spec.music.trim() ? music : undefined, join(out, `${slug}.mp4`), log, faceTop);
        const problems = reelsProblems(await probeVideo(video));
        log(problems.length ? `Reels check: ${problems.join("; ")}` : "Reels check: ok for Facebook/Instagram Reels and TikTok");
        console.log(video);
      }
      return;
    }
    case "music-lib": {
      // Thư viện nhạc: talk music-lib [--count 4]: the missing tracks, `count` per mood (MusicGen on the GPU).
      const count = Number(opt.count ?? 4);
      const made = makeLibrary(ROOT, (out, secs, prompt, seed) => void makeMusic(prompt, secs - 1, out, log, seed), count, log);
      console.log(`${made} new track(s); ${MOODS.length} moods × ${count}`);
      return;
    }
    case "mouthkit": {
      // Ready-made mouths: talk mouthkit <slug|all> [--only front,side] [--sheet]
      const [who] = pos;
      if (!who) throw new Error("Usage: talk mouthkit <slug|all> [--only front,side] [--sheet]");
      const ctx = openStudio({ log });
      const cdir = ctx.charactersDir ?? CHARACTERS;
      for (const slug of who === "all" ? [...ctx.profiles.keys()] : [who]) {
        if (!opt.sheet) await makeMouthKit(ctx, Sam.fromEnv(), slug, { only: opt.only ? (String(opt.only).split(",") as Angle[]) : undefined, log });
        const kit = loadKit(cdir, slug);
        console.log(`${slug}: ${kit ? kit.angles.map((a) => `${a.angle} ${a.shapes.length}`).join(", ") : "no kit"}; ${(await kitSheet(cdir, slug)) ?? "no sheet"}`);
      }
      return;
    }
    case "stock": {
      // Ready-made reactions: talk stock <slug|all> [--only a,b] | --approve a,b|all | --unapprove a,b | --list
      const [who] = pos;
      if (!who) throw new Error("Usage: talk stock <slug|all> [--only do-mat,om-dau] [--approve names|all] [--unapprove names] [--list]");
      const ctx = openStudio({ log });
      const slugs = who === "all" ? [...ctx.profiles.keys()] : [who];
      const names = (v: unknown) => (String(v) === "all" ? "all" : String(v).split(",")) as string[] | "all";
      for (const slug of slugs) {
        if (opt.approve || opt.unapprove) {
          approveStock(ctx.charactersDir ?? CHARACTERS, slug, names(opt.approve ?? opt.unapprove), Boolean(opt.approve));
          log(`${slug}: ${await stockSheet(ctx.charactersDir ?? CHARACTERS, slug)}`);
        } else if (!opt.list) {
          await makeStock(ctx, Sam.fromEnv(), slug, { only: opt.only ? String(opt.only).split(",") : undefined, log });
        }
        const e = loadStock(ctx.charactersDir ?? CHARACTERS, slug);
        console.log(`${slug}: ${e.length}/${REACTIONS.length} drawn, ${e.filter((x) => x.approved).length} approved`);
      }
      return;
    }
    case "idea": {
      // What to make from what the owner dropped in <dir>: input.txt and any pictures. Writes idea.json.
      if (!opt.out) throw new Error("Usage: talk idea --out <dir with input.txt and pictures> [--kind meme|comic]");
      const out = fromCwd(opt.out as string);
      const text = existsSync(join(out, "input.txt")) ? readFileSync(join(out, "input.txt"), "utf8") : "";
      const kind = opt.kind === "meme" || opt.kind === "comic" ? opt.kind : "";
      const plan = await readIdea(openStudio({ log }), text, ideaImages(out), kind);
      writeFileSync(join(out, "idea.json"), JSON.stringify(plan, null, 2) + "\n");
      log(`${join(out, "idea.json")}: ${plan.kind}`);
      return;
    }
    case "cover": {
      const [slug] = pos;
      if (!slug || !opt.out || !opt.quote) throw new Error('Usage: talk cover <slug> --out <illustrate dir> --quote "“line|line *key*.”" [--shot s08] [--episode <id>]');
      const out = fromCwd(opt.out as string);
      const plan: Plan = JSON.parse(readFileSync(join(out, "plan.json"), "utf8"));
      // The tag's avatar: the channel's profile picture (studio brand-art), else the lead's portrait.
      const brand = join(ROOT, "output", "brand-art", "hoi-sau", "avatar.png");
      const avatar = existsSync(brand) ? brand : join(CHARACTERS, slug, "portrait.svg");
      const made = await makeCover(Sam.fromEnv(), openStudio({ log }), plan, join(out, "shots"), String(opt.quote), join(out, slug), { avatar, shot: opt.shot ? String(opt.shot) : undefined, log });
      // --episode: the approved video's folder, where `studio tai` picks the cover up.
      if (opt.episode) copyFileSync(made.file, join(episodeDir(String(opt.episode)), "cover.jpg"));
      console.log(made.file);
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
