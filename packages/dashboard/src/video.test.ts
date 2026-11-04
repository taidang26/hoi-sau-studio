import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import sharp from "sharp";
import { writeDemoData } from "./seed.js";
import { startDashboard } from "./server.js";
import { DRIFT_WARN, edgeDrift, leadFromText, mockExec, videoPage, Videos, type Exec } from "./video.js";

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
  assert.deepEqual(calls.map((c) => [c[c.indexOf("--step") + 1], c[c.indexOf("--only") + 1]]), [["draw", "s03"], ["mouths", "s03"]]);
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
  // Lịch đăng lists it and can move or clear its time.
  assert.deepEqual(v.scheduled().map((m) => m.id), [id]);
  const first = v.meta(id).when!;
  v.setWhen(id, new Date(Date.now() + 5400_000).toISOString());
  assert.notEqual(v.meta(id).when, first);
  v.setWhen(id);
  assert.deepEqual(v.scheduled(), []);
  v.setWhen(id, first);
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
  assert.match(list, /Muốn làm gì, cứ viết như nhắn tin/);
  assert.doesNotMatch(list, /name="top"|name="punch"/, "one box, no form to fill on the first screen");
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
  assert.deepEqual(plan.shots.map((s) => s.t), [0, 2.96], "the punchline once the seven-word line is read");
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

test("a text meme posted straight to the form is still made", async () => {
  const form = new FormData();
  for (const [k, val] of Object.entries({ kind: "meme", top: "Lương về", punch: "Lương đi", slug: "cu-li", scenes: "1", seconds: "", scene1: "", music: "" })) form.append(k, val);
  const res = await fetch(`${base}/video/new`, { method: "POST", body: form, redirect: "manual" });
  assert.equal(res.status, 303);
  const id = res.headers.get("location")!.split("/").pop()!;
  await v.settle(id);
  assert.equal(v.plan(id)!.shots.length, 1);
  // No length typed: the punchline comes once "Lương về" is read, and the clip is as long as the reading needs.
  assert.equal(v.plan(id)!.lines[1].start, 2);
  assert.equal(v.plan(id)!.end, 6.06);
});

test("a detail fix changes only pose A, makes pose B and mouths again from it, and can be undone", async () => {
  const id = v.create({ slug: "cu-li", mouth: true, sample: v.samples()[0].path });
  await v.settle(id);
  const d = v.shotsDir(id);
  const before = readFileSync(join(d, "s01.png"));
  assert.throws(() => v.fixDetail(id, "s01", " "), /Viết chỗ cần sửa/);
  calls.length = 0;
  v.fixDetail(id, "s01", "remove the star pin on his back");
  await v.settle(id);
  assert.equal(v.jobs.get(id)?.error, undefined);
  const steps = calls.map((c) => [c[c.indexOf("--step") + 1], c[c.indexOf("--only") + 1]]);
  assert.deepEqual(steps, [["fix", "s01"], ["poses", "s01"], ["stabilize", "s01"], ["mouths", "s01,s01-b2"]]);
  assert.equal(calls[0][calls[0].indexOf("--note") + 1], "remove the star pin on his back");
  assert.ok(!before.equals(readFileSync(join(d, "s01.png"))), "pose A changed");
  assert.ok(before.equals(readFileSync(join(d, "s01-prev.png"))), "the old picture is kept");
  assert.ok(existsSync(join(d, "s01-b2.png")) && existsSync(join(d, "s01-m.png")));
  assert.match(videoPage(v, id)!, /Quay lại bản trước khi sửa/);
  v.undoFix(id, "s01");
  await v.settle(id);
  assert.ok(before.equals(readFileSync(join(d, "s01.png"))), "back to the picture before the fix");
  assert.ok(!existsSync(join(d, "s01-prev.png")));
});

test("a missed line is added with its times, times are corrected, and a shot is added for it or taken out", async () => {
  const id = v.list().find((m) => existsSync(join(v.shotsDir(m.id), "s01-prev.png")) === false && m.kind !== "meme" && !m.posted)!.id;
  // A line the recogniser missed, and a corrected end time for one it heard.
  v.editShot(id, "s02", { add: { text: "Taeyang về Việt Nam hát concert", start: "3,6", end: "3.9" }, ends: { 0: "1.9" } });
  let plan = v.plan(id)!;
  assert.deepEqual(plan.lines.map((l) => l.text), ["Sáng thứ Hai vào làm", "sếp giao thêm ba việc", "Taeyang về Việt Nam hát concert", "chiều về vẫn chưa xong"]);
  assert.equal(plan.lines[0].end, 1.9);
  assert.equal(plan.lines[2].start, 3.6);
  assert.throws(() => v.editShot(id, "s02", { add: { text: "x", start: "5", end: "" } }), /giờ bắt đầu và kết thúc/);
  assert.throws(() => v.editShot(id, "s02", { starts: { 1: "9" } }), /giây phải từ 0/);
  assert.throws(() => v.editShot(id, "s01", { t: "1" }), /Cảnh đầu/);

  // Its own picture from 3.9 s.
  assert.throws(() => v.addShot(id, { t: "4.1", act: "x" }), /s03 bắt đầu lúc 4.0s/);
  assert.throws(() => v.addShot(id, { t: "3.5", act: "" }), /vẽ gì/);
  calls.length = 0;
  const shot = v.addShot(id, { t: "3.5", act: "Rico from behind facing a concert crowd with yellow crown lightsticks", pose: "" });
  await v.settle(id);
  plan = v.plan(id)!;
  assert.equal(shot, "s04");
  assert.deepEqual(plan.shots.map((s) => [s.id, s.t]), [["s01", 0], ["s02", 2], ["s04", 3.5], ["s03", 4]]);
  assert.deepEqual(calls.map((c) => [c[c.indexOf("--step") + 1], c[c.indexOf("--only") + 1]]), [["draw", "s04"], ["mouths", "s04"]]);
  assert.ok(existsSync(join(v.shotsDir(id), "s04.png")));
  assert.deepEqual(v.shotLines(plan, plan.shots[2]).map((l) => l.text), ["Taeyang về Việt Nam hát concert"]);
  assert.ok(v.unchecked(id).includes("s04"));

  // Moving the shot start, then taking it out.
  v.editShot(id, "s04", { t: "3.6" });
  assert.equal(v.plan(id)!.shots[2].t, 3.6);
  assert.throws(() => v.removeShot(id, "s01"), /cảnh đầu/);
  v.removeShot(id, "s04");
  assert.deepEqual(v.plan(id)!.shots.map((s) => s.id), ["s01", "s02", "s03"]);

  // The page has the new fields; deleting a line works through the form.
  const html = videoPage(v, id)!;
  for (const re of [/Thêm câu máy nghe sót/, /name="start-0"/, /thêm cảnh/, /Sửa chi tiết, giữ tranh/, /Sửa bằng lời/]) assert.match(html, re);
  const res = await fetch(`${base}/video/${id}/shot/s02/edit`, { method: "POST", body: new URLSearchParams({ drop: "2" }), redirect: "manual" });
  assert.equal(res.status, 303);
  assert.equal(v.plan(id)!.lines.length, 3);
  const add = await fetch(`${base}/video/${id}/addshot`, { method: "POST", body: new URLSearchParams({ t: "5", act: "the lead walks home" }), redirect: "manual" });
  assert.equal(add.status, 303);
  assert.match(add.headers.get("location")!, /#s0\d$/);
  await v.settle(id);
});

test("fixing by note: the proposal shows evidence first, Làm does it and renders, and Hoàn tác puts it all back", async () => {
  const id = v.create({ slug: "cu-li", mouth: true, sample: v.samples()[0].path });
  await v.settle(id);
  v.render(id);
  await v.settle(id);
  const d = v.shotsDir(id);
  const before = readFileSync(join(d, "s01.png"));
  const firstLine = v.plan(id)!.lines[0].text;

  // An unclear note gets a question and nothing else.
  v.ask(id, "sửa giúp cái", "");
  await v.settle(id);
  assert.equal(v.meta(id).ask!.actions.length, 0);
  assert.match(videoPage(v, id)!, /Anh muốn sửa cảnh nào\?/);

  // A clear note: the page shows each edit with the old and new text before anything changes.
  const res = await fetch(`${base}/video/${id}/ask`, { method: "POST", body: new URLSearchParams({ note: "câu đầu là Mẹ không phải Sáng, Rico quay lưng mà có ghim sao", at: "0.5" }), redirect: "manual" });
  assert.equal(res.status, 303);
  await v.settle(id);
  assert.equal(v.meta(id).ask!.at, 0.5);
  let html = videoPage(v, id)!;
  assert.match(html, /<del>“Sáng thứ Hai vào làm”<\/del> → <ins>“Mẹ thứ Hai vào làm”<\/ins>/);
  assert.match(html, /Chỉ sửa đúng chỗ “star pin”/);
  assert.match(html, /class="fixthumb"/);
  assert.equal(v.plan(id)!.lines[0].text, firstLine, "nothing changed yet");
  assert.match(html, /có tiếng nói mà không có phụ đề/, "the missed speech is flagged");

  calls.length = 0;
  const apply = await fetch(`${base}/video/${id}/apply`, { method: "POST", body: new URLSearchParams([["pick", "0"], ["pick", "1"]]), redirect: "manual" });
  assert.equal(apply.status, 303);
  await v.settle(id);
  assert.equal(v.jobs.get(id)?.error, undefined);
  assert.equal(v.plan(id)!.lines[0].text, "Mẹ thứ Hai vào làm");
  const fix = calls.find((c) => c.includes("fix"))!;
  assert.equal(fix[fix.indexOf("--find") + 1], "star pin");
  assert.ok(calls.some((c) => c.includes("render")), "the video is made again");
  assert.ok(!v.stale(id, "plain"));
  const done = v.meta(id).done!;
  assert.ok(done.changed.s01 > 0);
  assert.ok(existsSync(join(v.undoDir(id), "diff-s01.jpg")) && existsSync(join(v.undoDir(id), "zoom-s01-after.jpg")));
  html = videoPage(v, id)!;
  for (const re of [/Trước/, /Sau/, /Phóng to chỗ đổi/, /Đỏ: chỗ đã đổi/, /Hoàn tác/, /Giữ/]) assert.match(html, re);
  assert.equal(v.meta(id).ask, undefined);

  // Back to before.
  v.undo(id);
  assert.equal(v.plan(id)!.lines[0].text, firstLine);
  assert.ok(before.equals(readFileSync(join(d, "s01.png"))));
  assert.ok(!existsSync(v.undoDir(id)));
  assert.equal(v.meta(id).done, undefined);

  // Again, and this time keep it: a new shot shows as new.
  v.ask(id, "chỗ này thiếu tranh", "5");
  await v.settle(id);
  v.apply(id, [0]);
  await v.settle(id);
  assert.ok(v.plan(id)!.shots.some((s) => s.t === 5));
  assert.match(videoPage(v, id)!, /cảnh mới/);
  v.keep(id);
  assert.ok(!existsSync(v.undoDir(id)));
  assert.ok(v.plan(id)!.shots.some((s) => s.t === 5), "kept");
  assert.throws(() => v.apply(id, [0]), /Chưa có gì/);
});

test("text or pictures in, a proposal with what was read, then the clip is made from the checked form", async () => {
  const list = await (await fetch(`${base}/video`)).text();
  assert.match(list, /name="files"/);
  const empty = await fetch(`${base}/video/idea`, { method: "POST", body: new FormData(), redirect: "manual" });
  assert.match(decodeURIComponent(empty.headers.get("location")!), /Dán chữ hoặc thêm/);

  // A screenshot of a quote, no text: the words are read off it and split into two beats.
  const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#eee" } }).png().toBuffer();
  const form = new FormData();
  form.append("text", "");
  form.append("files", new Blob([new Uint8Array(png)], { type: "image/png" }), "IMG_0895.png");
  const res = await fetch(`${base}/video/idea`, { method: "POST", body: form, redirect: "manual" });
  assert.equal(res.status, 303);
  const id = res.headers.get("location")!.split("/").pop()!;
  await v.settle(`idea:${id}`);
  const html = await (await fetch(`${base}/video/idea/${id}`)).text();
  assert.match(html, /Chữ đọc được trong ảnh/);
  assert.match(html, /\/video-media\/_ideas\/y-[^/]+\/img-1\.png/);
  assert.match(html, /name="top"[^>]*value="Ai cũng xứng đáng có một công việc ổn định\."/);
  assert.match(html, /name="punch"[^>]*value="Trừ tôi, tôi xứng đáng trúng số rồi nghỉ việc"/);
  assert.match(html, /Hoặc làm tranh 1 khung/, "the comic is offered too");
  assert.equal((await fetch(`${base}/video-media/_ideas/${id}/img-1.png`)).status, 200);
  assert.ok(!v.list().some((m) => m.id.startsWith("y-")), "a drop-in is not a video");

  // Asked for a comic: the comic form comes first.
  const f2 = new FormData();
  f2.append("text", "Sếp gọi lên phòng lúc 5 giờ chiều thứ Sáu");
  f2.append("want", "comic");
  const r2 = await fetch(`${base}/video/idea`, { method: "POST", body: f2, redirect: "manual" });
  const id2 = r2.headers.get("location")!.split("/").pop()!;
  await v.settle(`idea:${id2}`);
  const h2 = await (await fetch(`${base}/video/idea/${id2}`)).text();
  assert.ok(h2.indexOf("<h2>Tranh 1 khung</h2>") > 0 && h2.indexOf("<h2>Tranh 1 khung</h2>") < h2.indexOf("Hoặc làm clip chữ"));
  assert.equal(v.idea(id2)!.plan!.kind, "comic");
  assert.equal(v.idea(id2)!.plan!.comic.headline, "Sếp gọi lên phòng lúc 5 giờ chiều thứ Sáu", "the words go on the panel as they are");
});

test("a sample clip picked in the one box starts a talking video right away", async () => {
  const form = new FormData();
  form.append("text", "Lolo nghe sếp nói tăng lương");
  form.append("sample", v.samples()[0].path);
  const res = await fetch(`${base}/video/idea`, { method: "POST", body: form, redirect: "manual" });
  assert.equal(res.status, 303);
  const id = res.headers.get("location")!.split("/").pop()!;
  assert.ok(!id.startsWith("y-"), "a video, not a proposal");
  await v.settle(id);
  assert.equal(v.meta(id).slug, "cu-li");
  assert.equal(v.meta(id).title, "Lolo nghe sếp nói tăng lương");
  const cast = [{ slug: "cu-li", name: "Tũn" }, { slug: "te-te", name: "Tê" }];
  assert.equal(leadFromText("Tê nghe sếp nói tăng lương", cast), "te-te");
  assert.equal(leadFromText("Tết này sếp thưởng", cast), "cu-li", "a name inside another word is not a mention");
});

test("one next step at the top: look at the scenes, then one button ticks them all and makes the video", async () => {
  const id = v.create({ slug: "cu-li", mouth: true, sample: v.samples()[0].path });
  await v.settle(id);
  const page1 = videoPage(v, id)!;
  assert.match(page1, /Bước tiếp: xem \d+ cảnh bên dưới/);
  assert.doesNotMatch(page1, /id="approve"/, "no approval form while scenes are unseen");
  const res = await fetch(`${base}/video/${id}/okall`, { method: "POST", redirect: "manual" });
  assert.equal(res.status, 303);
  await v.settle(id);
  assert.deepEqual(v.unchecked(id), []);
  assert.ok(!v.stale(id, "mouth"), "rendered");
  const page2 = videoPage(v, id)!;
  assert.match(page2, /Bước tiếp: xem video rồi duyệt/);
  assert.match(page2, /id="approve"/);
  assert.match(page2, /<details class="vmore">/, "version, cover and Threads are tucked away");
});

test("a step that dies on the network runs once more; a real failure does not", async () => {
  let n = 0;
  const flaky = new Videos({ ...v.opts, dir: join(root, "flaky"), exec: async (script, args, log, env) => {
    if (args.includes("draw") && n++ === 0) throw new Error("TypeError: fetch failed");
    return mock(script, args, log, env);
  } });
  const id = flaky.create({ kind: "meme", slug: "cu-li", mouth: false, meme: { top: "Lương về", punch: "Lương đi", scenes: [""], music: "", seconds: 0 }, caption: "Lương đi #danvanphong" });
  await flaky.settle(id);
  assert.equal(flaky.jobs.get(id)?.error, undefined);
  assert.equal(n, 2);
  assert.equal(flaky.meta(id).caption, "Lương đi #danvanphong", "the caption from the proposal is kept");
  const broken = new Videos({ ...v.opts, dir: join(root, "broken"), exec: async (script, args, log, env) => {
    if (args.includes("draw")) throw new Error("Muse Image refused the prompt");
    return mock(script, args, log, env);
  } });
  const id2 = broken.create({ kind: "meme", slug: "cu-li", mouth: false, meme: { top: "a", punch: "b", scenes: [""], music: "", seconds: 0 } });
  await broken.settle(id2);
  assert.match(broken.jobs.get(id2)!.error!, /refused/);
});

test("a new shot for a line starts with the line and hands back to the picture before; a failed picture fix can be undone", async () => {
  const id = v.create({ slug: "cu-li", mouth: false, sample: v.samples()[0].path });
  await v.settle(id);
  v.ask(id, "chỗ này cần cảnh cho câu Taeyang", "4.5");
  await v.settle(id);
  v.apply(id, [0]);
  await v.settle(id);
  const shots = v.plan(id)!.shots;
  assert.ok(shots.some((s) => s.t === 4.5 && !s.src), "s03 already starts with that line, so the new one starts at the pause");
  const back = shots.find((s) => s.src === "s03");
  assert.ok(back && back.t === 5, "s03 comes back when the new shot ends");
  v.keep(id);

  // The picture fix fails partway: the rest still runs, the page says so and Hoàn tác puts it back.
  const failing = new Videos({ ...v.opts, exec: async (script, args, log, env) => {
    if (args.includes("fix")) throw new Error("s02: the picture was left as it was (\"wall clock\" not found in the picture)");
    return mock(script, args, log, env);
  } });
  const planBefore = readFileSync(join(v.folder(id), "plan.json"), "utf8");
  failing.ask(id, "bỏ cái đồng hồ treo tường, câu đầu là Mẹ", "2.5");
  await failing.settle(id);
  assert.equal(failing.meta(id).ask!.actions.length, 2);
  failing.apply(id, [0, 1]);
  await failing.settle(id);
  assert.match(failing.jobs.get(id)!.error!, /not found/);
  assert.equal(failing.plan(id)!.lines[0].text.split(" ")[0], "Mẹ", "the text edit still went in");
  const html = videoPage(failing, id)!;
  assert.match(html, /Sửa chưa xong/);
  assert.match(html, /Hoàn tác/);
  failing.undo(id);
  assert.equal(readFileSync(join(v.folder(id), "plan.json"), "utf8"), planBefore);
});

test("an error note goes before the #part of the link, where the page can read it", async () => {
  const { withNote } = await import("./server.js");
  assert.equal(withNote("/video/a#fix", "err", "x y"), "/video/a?err=x%20y#fix");
  assert.equal(withNote("/video/a?v=1", "ok", "z"), "/video/a?v=1&ok=z");
});

test("when the only edit is refused, nothing is rendered and the page says why", async () => {
  const id = v.create({ slug: "cu-li", mouth: false, sample: v.samples()[0].path });
  await v.settle(id);
  const calls: string[][] = [];
  const refusing = new Videos({ ...v.opts, exec: async (script, args, log, env) => {
    calls.push(args);
    if (args.includes("fix")) throw new Error("Error: s02: the picture was left as it was (wall clock still present)");
    return mock(script, args, log, env);
  } });
  refusing.ask(id, "bỏ cái đồng hồ", "2.5");
  await refusing.settle(id);
  calls.length = 0;
  refusing.apply(id, [0]);
  await refusing.settle(id);
  assert.ok(!calls.some((c) => c.includes("render")), "no render when nothing changed");
  const m = refusing.meta(id);
  assert.equal(m.done, undefined);
  assert.match(m.refused!.why, /^s02: the picture was left as it was/);
  assert.ok(!existsSync(refusing.undoDir(id)));
  const html = videoPage(refusing, id)!;
  assert.match(html, /Không sửa được, tranh và video vẫn như cũ/);
  assert.doesNotMatch(html, /Hoàn tác/);
  assert.ok(existsSync(join(refusing.folder(id), "log.txt")), "the steps are logged");
});
