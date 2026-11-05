#!/usr/bin/env node
/**
 *   npm run motion -- episode <id> [--draft] [--audio music.mp3] [--story]   episodes/<id>/ → episodes/<id>/motion/reel.mp4
 *                    --story: the short-video cut, still panels with hard cuts, title on top, all inside the safe area
 *   npm run motion -- render <spec.json> <out-dir>                 any list of panels, see MotionSpec
 *   npm run motion -- check <video.mp4>                            would Reels accept it?
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EPISODES_DIR, episodeDir, loadProfiles } from "@hoi-sau/studio";
import { specFromEpisode } from "./episode.js";
import { probeVideo, reelsProblems } from "./probe.js";
import { renderMotionComic, type MotionSpec } from "./render.js";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv.splice(i, 2)[1] ?? "") : undefined;
};
const bool = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv.splice(i, 1), true) : false;
};

async function report(video: string) {
  const info = await probeVideo(video);
  const problems = reelsProblems(info);
  console.log(`${video}: ${info.width}x${info.height}, ${info.duration.toFixed(1)}s, ${(info.sizeBytes / 1e6).toFixed(1)} MB`);
  console.log(problems.length ? `Not ready for Reels:\n  - ${problems.join("\n  - ")}` : "Ready for Reels and Threads.");
  return problems.length === 0;
}

async function main() {
  const draft = bool("draft");
  const story = bool("story");
  const audio = flag("audio");
  const episodesDir = flag("episodes-dir") ?? process.env.EPISODES_DIR ?? EPISODES_DIR;
  const [cmd, a, b] = argv;

  if (cmd === "episode" && a) {
    const dir = episodeDir(a, episodesDir);
    const names = Object.fromEntries([...loadProfiles().values()].map((p) => [p.slug, p.name]));
    const spec = specFromEpisode(dir, { names, quality: draft ? "draft" : "final", audio: audio ? { file: resolve(audio) } : undefined, story });
    const res = await renderMotionComic(spec, join(dir, "motion"));
    console.log(`${res.video}\n${res.cover}\n${res.subtitles}`);
    if (!draft && !(await report(res.video))) process.exitCode = 1;
    return;
  }
  if (cmd === "render" && a && b) {
    const spec = JSON.parse(readFileSync(a, "utf8")) as MotionSpec;
    const res = await renderMotionComic({ ...spec, baseDir: spec.baseDir ?? dirname(resolve(a)), quality: draft ? "draft" : spec.quality }, resolve(b));
    console.log(res.video);
    return;
  }
  if (cmd === "check" && a) {
    if (!(await report(a))) process.exitCode = 1;
    return;
  }
  console.log("commands: episode <id> [--draft] [--audio file] | render <spec.json> <out-dir> [--draft] | check <video.mp4>");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
