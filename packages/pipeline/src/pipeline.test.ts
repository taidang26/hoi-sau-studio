import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Comment } from "@hoi-sau/channel";
import { loadBible, loadProfiles, type Premise } from "@hoi-sau/studio";
import { captions } from "./caption.js";
import { buildDeps } from "./config.js";
import { fold, mentioned, pickDirection, rejectReason } from "./direction.js";
import { parsePlan, runDaily } from "./pipeline.js";
import { acquireLock, loadRuns } from "./runs.js";
import { hanoiDate, missedToday, nextSlot, slotOn } from "./schedule.js";

const hasFfmpeg = (() => {
  try {
    execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const profiles = loadProfiles();
const bible = loadBible();

const comment = (id: string, text: string, extra: Partial<Comment> = {}): Comment => ({
  id,
  platform: "facebook",
  postId: "p1",
  text,
  author: { name: `user-${id}` },
  createdAt: `2026-11-01T0${id.length}:00:00Z`,
  ...extra,
});

test("folding matches names with or without diacritics", () => {
  assert.equal(fold("Cá Nóc đi họp"), "ca noc di hop");
  assert.deepEqual(mentioned("Tập sau cho CA NOC làm sếp", profiles, bible.cast), ["ca-noc"]);
  assert.deepEqual(mentioned("cu li với tê tê", profiles, bible.cast), ["cu-li", "te-te"]);
});

test("links, abuse, replies and noise never become a direction; ordinary words are not abuse", () => {
  assert.equal(rejectReason(comment("a", "xem ở https://spam.example")), "link");
  assert.equal(rejectReason(comment("a", "vcl hay quá")), "abuse");
  assert.equal(rejectReason(comment("a", "😂😂😂")), "too short");
  assert.equal(rejectReason(comment("a", "Cho cu li đi họp", { parentId: "x" })), "reply");
  assert.equal(rejectReason(comment("a", "Buổi họp lớn nhất năm của Tê Tê")), undefined);
});

test("dashboard picks beat comments, comments beat the fallback, used comments are skipped", () => {
  const comments = [
    comment("c1", "Cho cá nóc làm trưởng phòng một ngày đi"),
    comment("c2", "Đúng rồi!", { parentId: "c1", author: { name: "Hà" } }),
    comment("c3", "Tê tê đi họp mà quên laptop"),
  ];
  const base = { comments, profiles, bible, number: 4, used: new Set<string>() };

  const hand = pickDirection({ ...base, picked: [{ commentId: "c3", pickedAt: "x" }] });
  assert.equal(hand.source, "dashboard");
  assert.equal(hand.lead, "te-te");

  const auto = pickDirection({ ...base, picked: [] });
  assert.equal(auto.source, "comments");
  assert.deepEqual(auto.commentIds, ["c1"], "the comment people replied to wins");
  assert.equal(auto.lead, "ca-noc");
  assert.deepEqual(auto.credits.map((c) => c.name), ["user-c1", "Hà"]);
  assert.equal(auto.characters.length, 2, "the lead gets a partner from the bible");

  const used = pickDirection({ ...base, picked: [{ commentId: "c3", pickedAt: "x" }], used: new Set(["c1", "c3"]) });
  assert.equal(used.source, "fallback");
  assert.equal(used.lead, bible.cast[3], "the cast takes turns by episode number");

  assert.equal(pickDirection({ ...base, picked: [], manual: "Sao la xin tăng lương" }).lead, "sao-la");
  assert.equal(pickDirection({ ...base, picked: [], lead: "cu-li" }).lead, "cu-li");
});

test("captions fit each platform and credit the commenters", () => {
  const premise: Premise = { title: "Cu Li và cái deadline", logline: "Một câu.", setup: "", twist: "", hook: "Ai sẽ báo sếp?", cameo: null };
  const ep = { id: "cu-li-ep-002", lead: "cu-li", characters: ["cu-li"], direction: "", credits: [{ name: "Lan", comment: "x" }], createdAt: "" };
  const c = captions(premise, ep, { number: 2, leadName: "Cu Li" });
  assert.match(c.instagram, /Hồi Sau tập 2/);
  assert.match(c.instagram, /Lan/);
  assert.match(c.instagram, /#CuLi/);
  assert.ok([...c.threads].length <= 500);
  assert.equal(c.threads.match(/#/g)?.length, 1, "Threads takes one topic tag");
  assert.doesNotMatch(c.threads, /Ai sẽ báo sếp/, "the question goes in the reply, not the post");
  assert.match(c.threadsReply, /^Ai sẽ báo sếp\?/);
  assert.ok(c.instagram.split("\n")[1].includes("Ai sẽ báo sếp?"), "Instagram puts the question in the first two lines");
  assert.ok((c.instagram.match(/#/g)?.length ?? 0) > (c.facebook.match(/#/g)?.length ?? 0), "Instagram carries more hashtags");
});

test("post plans parse from PIPELINE_POSTS", () => {
  assert.deepEqual(parsePlan("reels:facebook,instagram;carousel:instagram,bogus"), [
    { format: "reels-9x16", platforms: ["facebook", "instagram"] },
    { format: "carousel-4x5", platforms: ["instagram"] },
  ]);
});

test("the daily slot is Hanoi time whatever the machine's zone", () => {
  const now = new Date("2026-11-01T11:30:00Z"); // 18:30 in Hanoi
  assert.equal(hanoiDate(now), "2026-11-01");
  assert.equal(hanoiDate(new Date("2026-11-01T17:30:00Z")), "2026-11-02");
  assert.equal(slotOn("2026-11-01", "19:00").toISOString(), "2026-11-01T12:00:00.000Z");
  assert.equal(nextSlot(now, "19:00").toISOString(), "2026-11-01T12:00:00.000Z");
  assert.equal(nextSlot(new Date("2026-11-01T12:00:00Z"), "19:00").toISOString(), "2026-11-02T12:00:00.000Z");
  assert.equal(missedToday(new Date("2026-11-01T13:00:00Z"), "19:00", false), true);
  assert.equal(missedToday(new Date("2026-11-01T13:00:00Z"), "19:00", true), false);
  assert.equal(missedToday(now, "19:00", false), false);
});

test("only one run at a time; a crashed lock expires", () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  const release = acquireLock(dir, new Date("2026-11-01T00:00:00Z"));
  assert.throws(() => acquireLock(dir, new Date("2026-11-01T01:00:00Z")), /still going/);
  assert.doesNotThrow(() => acquireLock(dir, new Date("2026-11-01T04:00:00Z"))());
  release();
});

test("mock: two days end to end, the second episode written from the first one's comments", { skip: !hasFfmpeg && "ffmpeg not installed", timeout: 240_000 }, async () => {
  const demoDir = mkdtempSync(join(tmpdir(), "pipeline-"));
  const deps = () => buildDeps({ mock: true }, { PIPELINE_DEMO_DIR: demoDir });
  let clock = new Date("2026-11-01T12:00:00Z");
  const at = () => ({ ...deps(), now: () => clock });

  const day1 = await runDaily(at());
  assert.equal(day1.status, "done", day1.error);
  assert.equal(day1.direction?.source, "fallback");
  assert.deepEqual(day1.stages.map((s) => s.name), ["listen", "direction", "studio", "motion", "package", "upload", "publish"]);
  assert.equal(day1.posts.filter((p) => p.status === "published").length, 5);
  assert.match(day1.stages.find((s) => s.name === "publish")!.note!, /Đã trả lời câu hỏi dưới bài Threads/);
  const epDir = join(demoDir, "studio", "episodes", day1.episodeId!);
  assert.ok(existsSync(join(epDir, "motion", "reel.mp4")));
  const post = JSON.parse(readFileSync(join(epDir, "post.json"), "utf8"));
  assert.equal(post.media["carousel-4x5"].length, post.urls["carousel-4x5"].length);
  assert.match(post.urls["reels-9x16"][0], /^https:\/\//);

  // Same day again: nothing new.
  const again = await runDaily(at());
  assert.equal(again.id, day1.id);
  assert.equal(loadRuns(join(demoDir)).length, 1);

  clock = new Date("2026-11-02T12:00:00Z");
  const day2 = await runDaily(at());
  assert.equal(day2.status, "done", day2.error);
  assert.equal(day2.direction?.source, "comments");
  assert.ok(day2.direction!.credits.length >= 1);
  assert.notEqual(day2.episodeId, day1.episodeId);
  const runs = loadRuns(demoDir);
  assert.deepEqual(runs.map((r) => r.id), ["2026-11-02", "2026-11-01"]);

  // The repo's own profiles never get the demo's episode memory.
  assert.doesNotMatch(readFileSync(new URL("../../../characters/cu-li/profile.yaml", import.meta.url), "utf8"), /cu-li-ep-00/);
});

test("mock: a failed day resumes the same episode instead of starting another", { skip: !hasFfmpeg && "ffmpeg not installed", timeout: 240_000 }, async () => {
  const demoDir = mkdtempSync(join(tmpdir(), "pipeline-"));
  const clock = new Date("2026-11-03T12:00:00Z");
  const broken = { ...buildDeps({ mock: true }, { PIPELINE_DEMO_DIR: demoDir }), now: () => clock, host: undefined };
  const first = await runDaily(broken);
  assert.equal(first.status, "failed");
  assert.equal(first.stages.at(-1)?.name, "upload");
  assert.match(first.error!, /MEDIA_DIR/);

  const fixed = await runDaily({ ...buildDeps({ mock: true }, { PIPELINE_DEMO_DIR: demoDir }), now: () => clock });
  assert.equal(fixed.id, first.id);
  assert.equal(fixed.episodeId, first.episodeId);
  assert.equal(fixed.status, "done");
  assert.equal(fixed.stages.find((s) => s.name === "direction")?.status, "skipped");
});
