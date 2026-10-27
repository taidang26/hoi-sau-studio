#!/usr/bin/env node
/**
 *   npm run talk -- art <slug> [--mock] [--only explain,shock] [--force]   draw the talk pictures once (Muse Image + SAM 3.1)
 *   npm run talk -- make <slug> [--topic "..."] [--seconds 30] [--script file.json] [--voice dir] [--music file] [--mock]
 *                    Muse Spark writes, safety gate, MMS-TTS speaks (or --voice recordings 01.wav...), render 1080x1920
 *   npm run talk -- demo                                                   offline: mock pictures, hummed voice
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeVideo, reelsProblems } from "@hoi-sau/motion";
import { openStudio } from "@hoi-sau/studio";
import { Sam } from "@hoi-sau/dance";
import { drawTalkArt, loadArt, talkDir } from "./art.js";
import { GESTURES } from "./gestures.js";
import { renderTalk } from "./render.js";
import { checkScript, writeScript, type TalkScript } from "./script.js";
import { buildTimeline, CANVAS, FPS } from "./timeline.js";
import { mouthTrack, voiceFor } from "./voice.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CHARACTERS = join(ROOT, "characters");
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
  topic?: string;
  seconds: number;
  script?: string;
  voice?: string;
  music?: string;
  out: string;
  artDir: string;
  log: (s: string) => void;
}

async function make(slug: string, o: MakeOptions) {
  const ctx = openStudio({ mock: o.mock, log: o.log });
  mkdirSync(o.out, { recursive: true });
  let art = loadArt(o.artDir);
  if (!art || GESTURES.some((g) => !art!.gestures[g.id])) {
    o.log("drawing the talk pictures first (once per character)");
    art = await drawTalkArt(ctx, slug, o.artDir, { sam: o.mock ? undefined : Sam.fromEnv(), log: o.log });
  }
  const script: TalkScript = o.script ? JSON.parse(readFileSync(o.script, "utf8")) : await writeScript(ctx, slug, { topic: o.topic, seconds: o.seconds, mock: o.mock });
  writeFileSync(join(o.out, "script.json"), JSON.stringify(script, null, 2) + "\n");
  const verdict = await checkScript(ctx, slug, script);
  writeFileSync(join(o.out, "safety.json"), JSON.stringify(verdict, null, 2) + "\n");
  if (!verdict.pass) throw new Error(`Safety gate failed: ${verdict.issues.map((i) => `${i.where}: ${i.topic}`).join("; ")}. See ${join(o.out, "safety.json")}.`);
  o.log(`script: ${script.lines.length} lines, gestures ${script.lines.map((l) => l.gesture).join(" ")}`);

  const voice = await voiceFor(script.lines.map((l) => l.text), o.out, { mock: o.mock, recorded: o.voice });
  const frames = Math.ceil((voice.pcm.length / voice.rate) * FPS);
  const scale = CANVAS.h / 1536;
  const { frames: timeline, chunks } = buildTimeline({
    lines: script.lines,
    voice,
    mouth: mouthTrack(voice, FPS, frames),
    canMouth: (g) => !!art!.gestures[g]?.mouth,
    canBlink: (g) => !!art!.gestures[g]?.blink,
    face: (g) => {
      const b = art!.gestures[g]?.mouth?.box;
      return b ? { x: (b.x + b.w / 2) * scale, y: (b.y + b.h / 2) * scale - 70 } : undefined;
    },
    frames,
  });
  const out = join(o.out, `${slug}.mp4`);
  const r = await renderTalk({ art, artDir: o.artDir, frames: timeline, chunks, title: script.title, voice, out, music: o.music, log: o.log });
  writeFileSync(join(o.out, "post.txt"), `${script.caption}\n`);
  const info = await probeVideo(r.video);
  const problems = reelsProblems(info);
  console.log(`${r.video} (${info.duration.toFixed(1)} s, ${info.width}x${info.height})`);
  console.log(problems.length ? `Reels check: ${problems.join("; ")}` : "Reels check: ok for Facebook/Instagram Reels and TikTok");
}

async function main() {
  loadDotEnv();
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = flags(rest);
  const log = (s: string) => console.error(s);
  switch (cmd) {
    case "art": {
      const slug = pos[0];
      if (!slug) throw new Error("Usage: talk art <slug> [--mock] [--only a,b] [--force]");
      const mock = !!opt.mock;
      const dir = mock ? join(ROOT, "data-demo", "talk", "art", slug) : talkDir(CHARACTERS, slug);
      await drawTalkArt(openStudio({ mock, log }), slug, dir, { sam: mock ? undefined : Sam.fromEnv(), only: opt.only ? String(opt.only).split(",") : undefined, force: !!opt.force, log });
      console.log(dir);
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
        seconds: Number(opt.seconds ?? 30),
        script: opt.script ? fromCwd(opt.script as string) : undefined,
        voice: opt.voice ? fromCwd(opt.voice as string) : undefined,
        music: opt.music ? fromCwd(opt.music as string) : undefined,
        out: opt.out ? fromCwd(opt.out as string) : join(ROOT, mock ? "data-demo" : "data", "talk", `${slug}-${stamp()}`),
        artDir: mock ? join(ROOT, "data-demo", "talk", "art", slug) : talkDir(CHARACTERS, slug),
        log,
      });
      return;
    }
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(2, 7).join("\n").replace(/^ \*/gm, ""));
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
