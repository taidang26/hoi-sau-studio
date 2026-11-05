import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { blinkShut, fitText, MEME_FRAME, memeLower, memePose, memeProblems, memeTiming, readTime, renderMeme, retimeMeme } from "./meme.js";

const ok = { top: "Sếp bảo làm thêm giờ là cơ hội", punch: "Cơ hội để sếp về sớm", scenes: ["", ""], music: "", seconds: 14 };

test("what the owner typed is checked before anything is drawn", () => {
  assert.deepEqual(memeProblems(ok), []);
  assert.match(memeProblems({ ...ok, punch: " " }).join(" "), /câu chốt/);
  assert.match(memeProblems({ ...ok, seconds: 40 }).join(" "), /Độ dài/);
  assert.match(memeProblems({ ...ok, scenes: ["", "", ""] }).join(" "), /hai cảnh/);
  assert.match(memeProblems({ ...ok, top: "x".repeat(120) }).join(" "), /tối đa/);
});

test("the punchline comes as soon as the first line is read, then holds; poses alternate", () => {
  // Clip 17: a five-word lead-in is read in 2.4 s, not the old 6.3 s.
  const t17 = memeTiming({ top: "Đi làm đã mệt rồi", punch: "còn phải ăn bữa cơm dở ẹc do mình tự nấu mang theo", seconds: 0 });
  assert.equal(t17.punchAt, 2.4);
  assert.ok(t17.end > 8.5 && t17.end < 10, String(t17.end));
  const long = memeTiming({ top: "2 nguồn thu nhập thì luôn tốt hơn là chỉ có 1. Vì vậy", punch: "x", seconds: 0 });
  assert.equal(long.punchAt, +readTime("2 nguồn thu nhập thì luôn tốt hơn là chỉ có 1. Vì vậy").toFixed(2));
  assert.equal(memeTiming({ top: "a b", punch: "c", seconds: 0 }).end, 6, "never shorter than 6 s");
  assert.equal(memeTiming({ top: "a b", punch: "c", seconds: 14 }).end, 14, "a set length moves only the end");
  assert.equal(memeTiming({ top: "a b", punch: "c", seconds: 14 }).punchAt, 2);
  // Clips already drawn get the new timing without drawing again.
  const plan = { slug: "cu-li", clip: "", end: 14, lines: [{ text: "Đi làm đã mệt rồi", start: 0, end: 6.3 }, { text: "còn phải ăn bữa cơm dở ẹc do mình tự nấu mang theo", start: 6.3, end: 14 }], shots: [{ id: "s01", t: 0, act: "", pose: "", bubble: "", cast: [] }, { id: "s02", t: 6.3, act: "", pose: "", bubble: "", cast: [] }] };
  retimeMeme(plan, { top: plan.lines[0].text, punch: plan.lines[1].text, seconds: 0 });
  assert.deepEqual([plan.lines[0].end, plan.lines[1].start, plan.shots[1].t, plan.end, plan.lines[1].end], [2.4, 2.4, 2.4, t17.end, t17.end]);
  assert.equal(memePose(0.2, 2), 0);
  assert.equal(memePose(1.6, 2), 1);
  assert.equal(memePose(2.5, 2), 0);
  assert.equal(memePose(1.6, 1), 0);
});

test("a one-pose shot blinks briefly; the pictures move down under the text", () => {
  assert.equal(blinkShut(1), false);
  assert.equal(blinkShut(1.85), true);
  assert.equal(blinkShut(2.1), false);
  assert.equal(blinkShut(4.25), true);
  // Faces already under the text: no move. Faces up high: down until they clear it. Never more than 520.
  assert.equal(memeLower(720, 1300), 0);
  assert.equal(memeLower(720, 700), 160);
  assert.equal(memeLower(720, 100), 520);
  assert.equal(memeLower(720), 300);
  assert.match(MEME_FRAME, /No clocks/);
});

test("text stays big, and the last line is never one lonely word", () => {
  const punch = fitText("Cơ hội để sếp về sớm");
  assert.ok(punch.size >= 60);
  assert.ok(punch.lines.every((l) => l.split(" ").length > 1), punch.lines.join(" / "));
});

test("long text shrinks to fit three lines", () => {
  const short = fitText("Ngắn");
  const long = fitText("Một câu rất dài để thử xem chữ có tự nhỏ lại cho vừa ba dòng trên màn hình điện thoại không");
  assert.equal(short.lines.length, 1);
  assert.ok(long.lines.length <= 3 || long.size === 48);
  assert.ok(long.size < short.size);
});

test("a two-scene meme renders at 1080x1920, 30 fps, for the whole length", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "meme-"));
  mkdirSync(dir, { recursive: true });
  for (const [f, hue] of [["s01", 30], ["s01-b2", 50], ["s02", 120]] as const)
    await sharp({ create: { width: 1080, height: 1920, channels: 3, background: `hsl(${hue}, 45%, 70%)` } }).png().toFile(join(dir, `${f}.png`));
  const plan = {
    slug: "cu-li", clip: "", end: 4,
    lines: [{ text: ok.top, start: 0, end: 2 }, { text: ok.punch, start: 2, end: 4 }],
    shots: [{ id: "s01", t: 0, act: "", pose: "x", bubble: "", cast: [] }, { id: "s02", t: 2, act: "", pose: "", bubble: "", cast: [] }],
  };
  const out = await renderMeme(plan, dir, undefined, join(dir, "cu-li.mp4"));
  assert.ok(existsSync(out));
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-show_entries", "format=duration", "-of", "json", out], { encoding: "utf8" });
  const info = JSON.parse(probe.stdout);
  assert.equal(info.streams[0].width, 1080);
  assert.equal(info.streams[0].height, 1920);
  assert.equal(info.streams[0].r_frame_rate, "30/1");
  assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.2);
});
