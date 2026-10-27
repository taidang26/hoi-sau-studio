import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEpisode, openStudio, runEpisode, SERIES_DIR } from "@hoi-sau/studio";
import { moveForShot, preset, zoompanExprs } from "./camera.js";
import { episodeNumber, lineTimes, specFromEpisode } from "./episode.js";
import { probeVideo, reelsProblems, type VideoInfo } from "./probe.js";
import { joinGraph, panelBox, renderMotionComic, spreadCues, timeline } from "./render.js";
import { toSrt } from "./srt.js";
import { readingSeconds, wrap } from "./text.js";

const hasFfmpeg = (() => {
  try {
    execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("zoompan expressions ease between framings and stay constant when equal", () => {
  const z = zoompanExprs(preset("pan-right"), 90);
  assert.equal(z.z, "1.2");
  assert.match(z.x, /\(iw-iw\/zoom\)\*\(0\+\(1\)\*\(\(on\/89\)/);
  const p = zoompanExprs(preset("punch"), 60);
  assert.match(p.z, /pow/);
  assert.match(p.x, /sin\(on\*1\.9\)/, "punch shakes");
});

test("storyboard shots map to moves, the last panel punches", () => {
  assert.equal(moveForShot("wide", "left", { index: 0 }).from.x, 0);
  assert.equal(moveForShot("wide", "left", { index: 1 }).from.x, 1, "consecutive wide shots alternate");
  assert.equal(moveForShot("close-up", "right").to.x, 0.75);
  assert.equal(moveForShot("medium", "center", { last: true }).ease, "punch");
});

test("a 4:5 panel fills the width and sits between the app's top and bottom bars", () => {
  const b = panelBox({ width: 1024, height: 1280 }, 1080, 1920);
  assert.deepEqual([b.w, b.h, b.x], [1080, 1350, 0]);
  assert.ok(b.y >= b.top && b.y + b.h <= 1920 - b.top);
  const tall = panelBox({ width: 1000, height: 2000 }, 1080, 1920);
  assert.ok(tall.h <= 1920 - 2 * tall.top && tall.w < 1080);
});

test("Vietnamese wraps between syllables and keeps diacritics composed", () => {
  const lines = wrap("Dạ em gửi bản final… à final_v2… à final_v2_xong_that", 16);
  assert.ok(lines.every((l) => [...l].length <= 22));
  assert.equal(lines.join(" "), "Dạ em gửi bản final… à final_v2… à final_v2_xong_that".normalize("NFC"));
});

test("reading time grows with dialogue and is clamped", () => {
  assert.equal(readingSeconds([]), 2.6);
  assert.ok(readingSeconds(["Sắp xong rồi, còn 90% nữa thôi."]) > 3);
  assert.equal(readingSeconds(["x".repeat(500)]), 7);
  const [a, b] = lineTimes(["Dạ em đang làm ạ…", "Ừ"]);
  assert.ok(b > a + 1);
});

test("timeline overlaps clips by the crossfade, except where the transition is a cut", () => {
  const { starts, total } = timeline(
    [
      { duration: 2, transition: "fade" },
      { duration: 3, transition: "none" },
      { duration: 3, transition: "fade" },
    ],
    0.5,
  );
  assert.deepEqual(starts, [0, 1.5, 4.5]);
  assert.equal(total, 7.5);
  const g = joinGraph(
    [
      { file: "a", duration: 2, transition: "fade" },
      { file: "b", duration: 3, transition: "none" },
      { file: "c", duration: 3, transition: "fade" },
    ],
    0.5,
  );
  assert.match(g, /xfade=transition=fade:duration=0.5:offset=1.5\[x1\]/);
  assert.match(g, /\[x1\]\[c2\]concat=n=2:v=1:a=0\[v\]/);
});

test("subtitles split a clip across its lines and format as SRT", () => {
  const cues = spreadCues(["một hai", "ba"], 1, 4);
  assert.equal(cues[0].end, cues[1].start);
  assert.equal(cues[1].end, 4);
  assert.equal(toSrt([{ start: 61.5, end: 62, text: "Dạ" }]), "1\n00:01:01,500 --> 00:01:02,000\nDạ\n");
});

test("Reels check flags the usual rejections", () => {
  const ok: VideoInfo = { duration: 20, width: 1080, height: 1920, fps: 30, videoCodec: "h264", pixFmt: "yuv420p", audioCodec: "aac", sizeBytes: 2e6 };
  assert.deepEqual(reelsProblems(ok), []);
  const bad = reelsProblems({ ...ok, width: 1080, height: 1350, audioCodec: undefined, duration: 2 });
  assert.equal(bad.length, 3);
});

test("episode numbers come from the id", () => {
  assert.equal(episodeNumber("cu-li-ep-003"), 3);
  assert.equal(episodeNumber("ep12"), 12);
  assert.equal(episodeNumber("pilot"), undefined);
});

test("a mock Studio episode becomes a Reels-ready motion comic", { skip: !hasFfmpeg && "ffmpeg not installed", timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "motion-"));
  const id = "cu-li-ep-002";
  createEpisode({ id, lead: "cu-li", characters: ["ca-noc"], direction: "Sếp giao việc lúc 4h50", credits: [{ name: "Lan", comment: "Cho cu li xin nghỉ" }] }, root);
  // A copy of series/, so story memory and canon from this run stay out of the repo.
  const seriesDir = join(root, "series");
  cpSync(SERIES_DIR, seriesDir, { recursive: true });
  const ctx = openStudio({ mock: true, episodesDir: root, seriesDir });
  // Keep the repo's profiles and bible untouched.
  ctx.saveBible = undefined;
  ctx.saveMemory = undefined;
  await runEpisode(ctx, id);

  const dir = join(root, id);
  const spec = specFromEpisode(dir, { quality: "draft", names: { "cu-li": "Cu Li" } });
  assert.equal(spec.header, "HỒI SAU · TẬP 2");
  assert.ok(spec.shots[0].layers?.length, "bubbles are separate layers over the art");
  assert.match(spec.shots[0].image, /^panels\//);

  const res = await renderMotionComic(spec, join(dir, "motion"));
  const info = await probeVideo(res.video);
  assert.equal(info.width, 540);
  assert.equal(info.height, 960);
  assert.equal(info.audioCodec, "aac");
  assert.ok(Math.abs(info.duration - res.duration) < 0.25, `${info.duration} vs ${res.duration}`);
  assert.match(readFileSync(res.subtitles, "utf8"), /Cu Li: /);
  assert.equal(res.segments[0].kind, "intro");
  assert.equal(res.segments.at(-1)!.kind, "outro");

  // A second render reuses every clip.
  const t = Date.now();
  await renderMotionComic(spec, join(dir, "motion"));
  assert.ok(Date.now() - t < 20_000);
});
