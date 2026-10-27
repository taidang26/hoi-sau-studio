#!/usr/bin/env node
/**
 *   npm run dance -- pose <video> [--out poses.json]       body poses with Meta's Keypoint R-CNN (Python, see pose/)
 *   npm run dance -- render <poses.json> --cast cu-li[,sao-la] [--out file.mp4] [--compare <video>]
 *                    [--bg "#hex"|image] [--start s] [--duration s] [--mirror]
 *   npm run dance -- rest <slug> [--mock]                   Muse Image draws the character front-on in an A-pose (rig/rest.png)
 *   npm run dance -- cut <slug> [--image rest.png]          SAM 3.1 cuts the rest drawing into a puppet (rig/rig.yaml + parts, check.png)
 *   npm run dance -- rig <slug> [--force]                   placeholder puppet from the character's palette
 *   npm run dance -- demo                                    made-up dance, placeholder puppets, no Python
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { openStudio } from "@hoi-sau/studio";
import { cutRig, writeCutRig } from "./cut.js";
import { paletteFrom, writePlaceholderRig } from "./placeholder.js";
import { loadPoses, renderDance } from "./render.js";
import { drawRest } from "./rest.js";
import { loadRig, rigDir } from "./rig.js";
import { Sam } from "./sam.js";
import { keepComposition } from "./scene.js";
import { syntheticPoses } from "./synth.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CHARACTERS = join(ROOT, "characters");
const PKG = fileURLToPath(new URL("..", import.meta.url));
const fromRoot = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));

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

function profile(slug: string): { name: string; palette: { name: string; hex: string }[] } {
  const file = join(CHARACTERS, slug, "profile.yaml");
  if (!existsSync(file)) throw new Error(`No character "${slug}" in characters/.`);
  const doc = parse(readFileSync(file, "utf8"));
  return { name: doc.name ?? slug, palette: doc.look?.palette ?? [] };
}

/** The character's rig; a placeholder in `fallbackDir` when it has none yet. */
function rigFor(slug: string, fallbackDir: string) {
  const dir = rigDir(CHARACTERS, slug);
  if (existsSync(join(dir, "rig.yaml"))) return loadRig(dir);
  const p = profile(slug);
  const tmp = join(fallbackDir, slug);
  writePlaceholderRig(tmp, p.name, paletteFrom(p.palette));
  console.error(`${slug} has no rig yet; using a placeholder puppet.`);
  return loadRig(tmp);
}

function python(): string {
  return process.env.DANCE_PYTHON || (process.platform === "win32" ? "python" : "python3");
}

async function pose(video: string, out: string) {
  await new Promise<void>((ok, fail) => {
    const p = spawn(python(), [join(PKG, "pose", "extract_pose.py"), video, out], { stdio: "inherit" });
    p.on("error", (e) => fail(new Error(`Could not start Python (${e.message}). Install Python 3 and run: pip install -r packages/dance/pose/requirements.txt, or set DANCE_PYTHON.`)));
    p.on("close", (code) => (code === 0 ? ok() : fail(new Error(`Pose extraction exited with ${code}.`))));
  });
}

function loadDotEnv(file = join(ROOT, ".env")): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

async function main() {
  loadDotEnv();
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = flags(rest);
  const log = (s: string) => console.error(s);
  switch (cmd) {
    case "pose": {
      const video = fromRoot(pos[0] ?? "");
      if (!pos[0] || !existsSync(video)) throw new Error("Usage: dance pose <video> [--out poses.json]");
      const out = fromRoot((opt.out as string) || join(ROOT, "data", "dance", `${basename(video, extname(video))}.poses.json`));
      mkdirSync(join(out, ".."), { recursive: true });
      await pose(video, out);
      console.log(out);
      return;
    }
    case "render": {
      if (!pos[0]) throw new Error("Usage: dance render <poses.json> --cast cu-li[,sao-la]");
      const file = loadPoses(fromRoot(pos[0]));
      const cast = String(opt.cast || "cu-li").split(",").filter(Boolean);
      const rigs = cast.map((slug) => rigFor(slug, join(ROOT, "data", "dance", "rigs")));
      const scene = keepComposition(file, rigs, { background: opt.bg as string | undefined, mirror: !!opt.mirror });
      if (opt.start) scene.start = Number(opt.start);
      if (opt.duration) scene.duration = Number(opt.duration);
      const out = fromRoot((opt.out as string) || pos[0].replace(/(\.poses)?\.json$/, `.${cast.join("+")}.mp4`));
      const r = await renderDance(file, scene, out, { compare: opt.compare ? fromRoot(opt.compare as string) : undefined, log });
      console.log(`${r.video} (${r.frames} frames, ${r.seconds.toFixed(1)} s)`);
      return;
    }
    case "rest": {
      const slug = pos[0];
      if (!slug) throw new Error("Usage: dance rest <slug> [--mock]");
      const ctx = openStudio({ mock: !!opt.mock, log });
      const png = await drawRest(ctx, slug, log);
      const dir = rigDir(CHARACTERS, slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "rest.png"), png);
      console.log(join(dir, "rest.png"));
      return;
    }
    case "cut": {
      const slug = pos[0];
      if (!slug) throw new Error("Usage: dance cut <slug> [--image rest.png]");
      const dir = rigDir(CHARACTERS, slug);
      const image = opt.image ? fromRoot(opt.image as string) : join(dir, "rest.png");
      if (!existsSync(image)) throw new Error(`${image} is missing. Draw it first: npm run dance -- rest ${slug}`);
      const { img, cut } = await cutRig(Sam.fromEnv(), readFileSync(image));
      await writeCutRig(dir, profile(slug).name, img, cut);
      console.log(`${dir} (check the joints in check.png)`);
      return;
    }
    case "rig": {
      const slug = pos[0];
      if (!slug) throw new Error("Usage: dance rig <slug> [--force]");
      const dir = rigDir(CHARACTERS, slug);
      if (existsSync(join(dir, "rig.yaml")) && !opt.force) throw new Error(`${dir} already has a rig. --force replaces it.`);
      const p = profile(slug);
      writePlaceholderRig(dir, p.name, paletteFrom(p.palette));
      console.log(dir);
      return;
    }
    case "demo": {
      const dir = join(ROOT, "data-demo", "dance");
      const file = syntheticPoses(Number(opt.seconds ?? 6));
      const rigs = ["sao-la", "cu-li"].map((slug) => rigFor(slug, join(dir, "rigs")));
      const out = join(dir, "demo.mp4");
      const r = await renderDance(file, keepComposition(file, rigs), out, { log });
      console.log(`${r.video} (${r.frames} frames)`);
      return;
    }
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(2, 8).join("\n").replace(/^ \*/gm, ""));
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
