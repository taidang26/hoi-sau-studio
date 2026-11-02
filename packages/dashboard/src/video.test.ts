import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import sharp from "sharp";
import { writeDemoData } from "./seed.js";
import { startDashboard } from "./server.js";
import { DRIFT_WARN, edgeDrift, mockExec, videoPage, Videos, type Exec } from "./video.js";

const root = mkdtempSync(join(tmpdir(), "hoisau-video-"));
const calls: string[][] = [];
const mock = mockExec();
const exec: Exec = (script, args, log, env) => {
  calls.push([script, ...args, ...(env?.EPISODES_DIR ? ["EPISODES_DIR"] : [])]);
  return mock(script, args, log, env);
};
const samples = join(root, "samples");
mkdirSync(samples, { recursive: true });
writeFileSync(join(samples, "luong.mp4"), "sample clip");
const v = new Videos({
  dir: join(root, "video"),
  episodesDir: join(root, "episodes"),
  siteMediaDir: join(root, "site-media"),
  mediaBase: "https://example.com/media/",
  samplesDirs: [samples, join(root, "missing")],
  cast: () => [{ slug: "cu-li", name: "Lolo" }],
  exec,
  deploy: false,
});

test("a video from a sample clip is planned, drawn, given second poses and mouths; failures are kept, not retried", async () => {
  assert.deepEqual(v.samples().map((s) => s.label), ["samples / luong.mp4"]);
  assert.throws(() => v.create({ slug: "nobody", mouth: true, sample: v.samples()[0].path }), /nhân vật/);
  const id = v.create({ slug: "cu-li", mouth: true, sample: v.samples()[0].path });
  await v.settle(id);
  assert.equal(v.jobs.get(id)?.error, undefined);
  const shots = v.shotsDir(id);
  for (const f of ["s01.png", "s01-b2.png", "s01-m.png", "s01-b2-m.png", "s02.png", "s03.png", "s03-m.png"]) assert.ok(existsSync(join(shots, f)), f);
  assert.ok(!existsSync(join(shots, "s02-b2.png")), "s02's pose B did not paste");
  const m = v.meta(id);
  assert.equal(m.stabilize.s02.ok, false);
  assert.equal(m.mouths.s02.ok, false);
  assert.equal(m.title, "luong");

  // Running on does not pay again for what failed.
  calls.length = 0;
  v.continue(id);
  await v.settle(id);
  assert.deepEqual(calls.map((c) => c[c.indexOf("--step") + 1]), ["draw", "poses"]);
});

test("nothing is approved before every shot is ticked and the render is newer than the pictures", async () => {
  const id = v.list()[0].id;
  await assert.rejects(v.approve(id, { caption: "Làm tốt thì thêm việc 🙃 #HoiSau", version: "mouth", still: [] }), /3 cảnh chưa soát/);
  for (const s of ["s01", "s02", "s03"]) v.tick(id, s);
  assert.deepEqual(v.unchecked(id), []);
  await assert.rejects(v.approve(id, { caption: "x", version: "mouth", still: [] }), /dựng/);
  v.render(id);
  await v.settle(id);
  assert.ok(!v.stale(id, "mouth") && !v.stale(id, "plain"));
  await assert.rejects(v.approve(id, { caption: "", version: "mouth", still: [] }), /chú thích/i);
  await assert.rejects(v.approve(id, { caption: "a".repeat(300), version: "mouth", still: [] }), /dài quá/);

  // Changing a bubble makes the shot unchecked again and the render old.
  await new Promise((r) => setTimeout(r, 20));
  v.editShot(id, "s01", { bubble: "Thứ Hai à…" });
  assert.deepEqual(v.unchecked(id), ["s01"]);
  assert.ok(v.stale(id, "mouth"));
  v.tick(id, "s01");
  v.render(id);
  await v.settle(id);

  await v.approve(id, { caption: "Làm tốt thì thêm việc 🙃 #HoiSau", threadsCaption: "thứ hai vs thứ sáu? #danvanphong", version: "mouth", still: ["s01", "s01-b2"], when: "" });
  await v.settle(id);
  assert.ok(calls.some((c) => c[0] === "packages/studio/dist/cli.js" && c[1] === "tai"), "the download page is rebuilt");
  assert.ok(!existsSync(v.coverFile(id)), "no cover line, no cover");
  const ep = join(root, "episodes", `v-${id}`);
  const post = JSON.parse(readFileSync(join(ep, "post.json"), "utf8"));
  assert.equal(post.format, "reels-9x16");
  assert.deepEqual(post.mediaUrls, [`https://example.com/media/v-${id}/video.mp4`]);
  assert.ok(existsSync(join(ep, "approval.json")));
  assert.ok(existsSync(join(root, "site-media", `v-${id}`, "video.mp4")));
  const still = await sharp(join(root, "site-media", `v-${id}-still`, "still.jpg")).metadata();
  assert.deepEqual([still.width, still.height], [1080, 1350]);
  assert.equal(JSON.parse(readFileSync(join(root, "episodes", `v-${id}-still`, "post.json"), "utf8")).caption, "thứ hai vs thứ sáu? #danvanphong");
  assert.ok(v.approved(id));
});

test("a redrawn shot is drawn again from scratch and has to be checked again", async () => {
  const id = v.list()[0].id;
  calls.length = 0;
  v.redraw(id, "s03", "one hand too many");
  await v.settle(id);
  assert.match(v.plan(id)!.shots.find((s) => s.id === "s03")!.act, /Fix: one hand too many$/);
  assert.deepEqual(calls.map((c) => [c[c.indexOf("--step") + 1], c[c.indexOf("--only") + 1]]), [["draw", "s03"], ["poses", "s03"], ["mouths", "s03"]]);
  assert.deepEqual(v.unchecked(id), ["s03"]);
  v.onePose(id, "s01");
  assert.ok(!existsSync(join(v.shotsDir(id), "s01-b2.png")));
  assert.equal(v.plan(id)!.shots[0].pose, "");
});

test("an approved video posts once: Reels and TikTok with the video, Threads with the still, on time", async () => {
  const id = v.list()[0].id;
  for (const s of v.unchecked(id)) v.tick(id, s);
  v.render(id);
  await v.settle(id);
  await v.approve(id, { caption: "Làm tốt thì thêm việc 🙃", version: "plain", still: ["s01"], when: new Date(Date.now() + 3600_000).toISOString(), cover: "Làm tốt|thì *thêm việc*" });
  await v.settle(id);
  assert.ok(existsSync(v.coverFile(id)), "the TikTok cover is made on approval");
  assert.equal(v.meta(id).cover, "Làm tốt|thì *thêm việc*");
  assert.deepEqual(v.due(), [], "not yet");
  calls.length = 0;
  assert.deepEqual(v.due(new Date(Date.now() + 2 * 3600_000)), [id]);
  await v.settle(id);
  assert.deepEqual(calls.map((c) => c.slice(2)), [
    [join(root, "episodes", `v-${id}`, "post.json"), "facebook", "instagram", "tiktok", "EPISODES_DIR"],
    [join(root, "episodes", `v-${id}-still`, "post.json"), "threads", "EPISODES_DIR"],
  ]);
  assert.match(v.meta(id).posted!.log, /threads: https/);
  assert.deepEqual(v.due(new Date(Date.now() + 3 * 3600_000)), [], "posted once");
  assert.throws(() => v.publish(id), /đã đăng/);
});

test("the video page shows every shot with its pictures and what was left out", () => {
  const id = v.list()[0].id;
  const html = videoPage(v, id)!;
  for (const s of ["s01", "s02", "s03"]) assert.match(html, new RegExp(`id="${s}"`));
  assert.match(html, /Tư thế 2 ghép không sạch/);
  assert.match(html, /Không nhép: no mouth found/);
  assert.match(html, /\/video-media\/[^"]+\/shots\/s01\.png/);
  assert.equal(videoPage(v, "nope"), undefined);
});

let base = "";
let close: () => void = () => {};
before(async () => {
  const dataDir = join(root, "data");
  writeDemoData(dataDir);
  const server = await startDashboard({ dataDir, runsDir: join(root, "runs"), videos: v, channel: () => ({ facebook: false, instagram: false, mock: true }) }, 0, "127.0.0.1");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

test("the dashboard lists videos, serves their pictures and takes the shot buttons", async () => {
  const id = v.list()[0].id;
  const list = await (await fetch(`${base}/video`)).text();
  assert.match(list, /Làm video mới/);
  assert.match(list, new RegExp(`/video/${id}`));
  assert.equal((await fetch(`${base}/video-media/${id}/shots/s01.png`)).headers.get("content-type"), "image/png");
  assert.equal((await fetch(`${base}/video-media/${id}/meta.json`)).status, 404);
  const res = await fetch(`${base}/video/${id}/shot/s02/edit`, { method: "POST", body: new URLSearchParams({ bubble: "Ba việc?!", "line-1": "sếp giao thêm ba việc nữa" }), redirect: "manual" });
  assert.equal(res.status, 303);
  assert.equal(v.plan(id)!.shots[1].bubble, "Ba việc?!");
  assert.equal(v.plan(id)!.lines[1].text, "sếp giao thêm ba việc nữa");
});

test("a text meme is planned from two lines of text, drawn, rendered and approved with its cover", async () => {
  assert.throws(() => v.create({ kind: "meme", slug: "cu-li", mouth: false, meme: { top: "Sếp bảo tăng ca là cơ hội", punch: "", scenes: ["", ""], music: "", seconds: 14 } }), /câu chốt/);
  assert.throws(() => v.create({ kind: "meme", slug: "cu-li", mouth: false, meme: { top: "a", punch: "b", scenes: [""], music: "", seconds: 40 } }), /Độ dài/);
  calls.length = 0;
  const id = v.create({ kind: "meme", slug: "cu-li", mouth: false, meme: { top: "Sếp bảo tăng ca là cơ hội", punch: "Cơ hội để sếp về sớm", scenes: ["Tũn ngáp ở bàn", ""], music: "soft lo-fi", seconds: 14 } });
  await v.settle(id);
  assert.equal(v.jobs.get(id)?.error, undefined);
  assert.equal(v.kind(id), "meme");
  assert.ok(calls.every((c) => c[1] === "meme"), "every step runs talk meme");
  assert.deepEqual(calls.map((c) => c[c.indexOf("--step") + 1]), ["plan", "draw", "poses", "stabilize"]);
  const plan = v.plan(id)!;
  assert.deepEqual(plan.lines.map((l) => l.text), ["Sếp bảo tăng ca là cơ hội", "Cơ hội để sếp về sớm"]);
  assert.deepEqual(plan.shots.map((s) => s.t), [0, 6.3]);
  for (const s of v.unchecked(id)) v.tick(id, s);
  v.render(id);
  await v.settle(id);
  assert.ok(!v.stale(id, "plain"));
  await v.approve(id, { caption: "Cơ hội 🙃 #danvanphong", version: "plain", still: [] });
  await v.settle(id);
  assert.ok(existsSync(v.coverFile(id)), "the cover defaults to the two lines");
  const html = videoPage(v, id)!;
  assert.match(html, /Sếp bảo tăng ca là cơ hội\|\*Cơ hội để sếp về sớm\*/);
  assert.match(html, /cover\.jpg/);
});

test("a second pose that moves the room is measured and flagged", async () => {
  const id = v.list().find((m) => m.kind === "meme")!.id;
  const d = v.shotsDir(id);
  assert.ok((v.meta(id).drift?.s01 ?? 1) < DRIFT_WARN, "the pose on a still background passes");
  assert.equal(await edgeDrift(join(d, "s01.png"), join(d, "s01.png")), 0);
  await sharp({ create: { width: 1080, height: 1920, channels: 3, background: "#1a1a1a" } }).png().toFile(join(d, "s01-b2.png"));
  await v.measureDrift(id, ["s01"]);
  assert.ok(v.meta(id).drift!.s01 > DRIFT_WARN);
  assert.match(videoPage(v, id)!, /Nền lệch giữa 2 tư thế/);
});

test("the Video screen offers the text meme form and takes it", async () => {
  const list = await (await fetch(`${base}/video`)).text();
  assert.match(list, /Làm clip chữ/);
  const form = new FormData();
  for (const [k, val] of Object.entries({ kind: "meme", top: "Lương về", punch: "Lương đi", slug: "cu-li", scenes: "1", seconds: "12", scene1: "", music: "" })) form.append(k, val);
  const res = await fetch(`${base}/video/new`, { method: "POST", body: form, redirect: "manual" });
  assert.equal(res.status, 303);
  const id = res.headers.get("location")!.split("/").pop()!;
  await v.settle(id);
  assert.equal(v.plan(id)!.shots.length, 1);
  assert.equal(v.plan(id)!.end, 12);
});
