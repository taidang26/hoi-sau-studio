import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadState, parseJournal, toggleDirection } from "./data.js";
import { writeDemoData } from "./seed.js";
import { inside, startDashboard } from "./server.js";
import { GraphClient, sendReply } from "@hoi-sau/channel";
import { DEMO, demoGraph } from "@hoi-sau/channel/dist/demo.js";
import { esc, filterComments } from "./views.js";

const root = mkdtempSync(join(tmpdir(), "hoisau-dash-"));
const dataDir = join(root, "data");
const runsDir = join(root, "runs");
let base = "";
let close = () => {};

before(async () => {
  writeDemoData(dataDir);
  mkdirSync(join(runsDir, "cu-li"), { recursive: true });
  writeFileSync(join(runsDir, "cu-li", "sheet.png"), "png");
  writeFileSync(
    join(runsDir, "cu-li", "run.json"),
    JSON.stringify({ slug: "cu-li", model: "mock", mock: true, startedAt: "2026-10-27T09:00:00Z", finishedAt: "", signature: [], images: [{ id: "sheet", file: "sheet.png", size: "1536x1024", prompt: "", responseId: "r", usage: {}, note: "" }] }),
  );
  const page = new GraphClient({ token: DEMO.pageToken, fetch: demoGraph().fetch });
  const server = await startDashboard(
    { dataDir, runsDir, channel: () => ({ facebook: true, instagram: false, mock: false }), inbox: { send: (c, text) => sendReply(page, DEMO.pageId, c, text) } },
    0,
  );
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

test("journal keys become episodes with character and platform", () => {
  const eps = parseJournal({
    "te-te-ep-002:instagram:reels-9x16": { state: "publishing", startedAt: "2026-10-27T01:00:00Z" },
    "te-te-ep-001:facebook:carousel-4x5": { state: "published", platform: "facebook", postId: "p1", publishedAt: "2026-10-26T01:00:00Z" },
  });
  assert.deepEqual(
    eps.map((e) => [e.episodeId, e.character, e.platform, e.state]),
    [
      ["te-te-ep-002", "te-te", "instagram", "publishing"],
      ["te-te-ep-001", "te-te", "facebook", "published"],
    ],
  );
});

test("state ties comments to characters through their posts", () => {
  const s = loadState({ dataDir, runsDir });
  const total = s.characters.reduce((n, c) => n + c.comments, 0);
  assert.equal(total, s.comments.length);
  assert.equal(s.characters.find((c) => c.profile.slug === "cu-li")!.episodes, 1);
  assert.ok(s.characters.find((c) => c.profile.slug === "cu-li")!.run);
});

test("comment search ignores case and Unicode composition", () => {
  const s = loadState({ dataDir, runsDir });
  const decomposed = "CÁ NÓC"; // "CÁ NÓC" written with combining accents
  const hits = filterComments(s, { q: decomposed });
  assert.ok(hits.length > 0 && hits.every((c) => c.text.includes("Cá Nóc")));
  assert.equal(filterComments(s, { platform: "instagram" }).every((c) => c.platform === "instagram"), true);
});

test("every page renders, with escaped user text", async () => {
  for (const path of ["/inbox", "/inbox?c=demo_t2", "/", "/characters", "/characters/cu-li", "/episodes", "/comments", "/comments?q=deadline&platform=facebook"]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /<title>.*Hồi Sau<\/title>/);
  }
  assert.equal((await fetch(base + "/characters/nobody")).status, 404);
  assert.equal(esc(`<script>"x"</script>`), "&lt;script&gt;&quot;x&quot;&lt;/script&gt;");
});

test("picking a comment persists and toggles", async () => {
  const res = await fetch(base + "/comments/demo_1/pick", { method: "POST", redirect: "manual" });
  assert.equal(res.status, 303);
  const saved = JSON.parse(readFileSync(join(dataDir, "directions.json"), "utf8"));
  assert.ok(saved.some((d: { commentId: string }) => d.commentId === "demo_1"));
  const again = await toggleDirection(dataDir, "demo_1");
  assert.ok(!again.some((d) => d.commentId === "demo_1"));
});

test("media and static files cannot escape their folders", async () => {
  assert.equal(inside(runsDir, "../data/comments.json"), null);
  assert.equal((await fetch(base + "/media/cu-li/sheet.png")).status, 200);
  assert.equal((await fetch(base + "/media/..%2F..%2Fdata%2Fcomments.json")).status, 404);
  assert.equal((await fetch(base + "/static/BeVietnamPro-Bold.ttf")).status, 200);
  assert.equal((await fetch(base + "/static/app.css")).status, 200);
});

test("inbox reply is sent and stored; a closed window refuses before any send", async () => {
  const ok = await fetch(base + "/inbox/demo_t2/reply", { method: "POST", body: new URLSearchParams({ text: "Gửi đi bạn ơi!" }), redirect: "manual" });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/inbox?c=demo_t2");
  const saved = JSON.parse(readFileSync(join(dataDir, "inbox.json"), "utf8"));
  const t2 = saved.find((c: { id: string }) => c.id === "demo_t2");
  assert.equal(t2.messages.at(-1).text, "Gửi đi bạn ơi!");
  assert.equal(t2.messages.at(-1).from, "page");

  const late = await fetch(base + "/inbox/demo_t4/reply", { method: "POST", body: new URLSearchParams({ text: "muộn" }), redirect: "manual" });
  assert.match(decodeURIComponent(late.headers.get("location")!), /err=.*24 giờ/);
  const html = await (await fetch(base + "/inbox?c=demo_t4")).text();
  assert.match(html, /Quá 24 giờ/);
  assert.doesNotMatch(html, /<textarea/);
});

test("studio: create a character, lock its sheet, build an episode end to end", async () => {
  const { mkdtempSync: tmp, cpSync, existsSync } = await import("node:fs");
  const { CHARACTERS_DIR, SERIES_DIR, openStudio } = await import("@hoi-sau/studio");
  const { Studio } = await import("./studio.js");
  const box = tmp(join(tmpdir(), "hoisau-dash-studio-"));
  const dirs = { charactersDir: join(box, "characters"), seriesDir: join(box, "series"), episodesDir: join(box, "episodes") };
  cpSync(CHARACTERS_DIR, dirs.charactersDir, { recursive: true });
  cpSync(SERIES_DIR, dirs.seriesDir, { recursive: true });
  writeFileSync(join(runsDir, "cu-li", "sheet.png"), readFileSync(new URL("../../../docs/images/svg-text-demo.png", import.meta.url)));
  const studio = new Studio({ ...dirs, runsDir, mock: true, open: (log) => openStudio({ mock: true, ...dirs, log }) });
  const server = await startDashboard({ dataDir, runsDir, charactersDir: dirs.charactersDir, studio, channel: () => ({ facebook: false, instagram: false, mock: false }) }, 0);
  const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, form: Record<string, string | string[]>) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) for (const x of [v].flat()) body.append(k, x);
    return fetch(at + path, { method: "POST", body, redirect: "manual" });
  };
  try {
    const made = await post("/characters/new", { idea: "một con vượn hay đến muộn" });
    assert.equal(made.headers.get("location"), "/characters/gibbo");
    assert.match(await (await fetch(at + "/characters/gibbo")).text(), /Gibbo/);

    assert.equal((await post("/characters/cu-li/approve", {})).headers.get("location"), "/characters/cu-li");
    assert.ok(existsSync(join(dirs.charactersDir, "cu-li", "model-sheet.png")));
    assert.match(await (await fetch(at + "/characters/cu-li")).text(), /Model sheet đã khoá/);
    assert.equal((await fetch(at + "/sheet/cu-li/model-sheet.png")).status, 200);
    assert.equal((await fetch(at + "/sheet/cu-li/profile.yaml")).status, 404);

    const ep = await post("/studio/new", { id: "ep-009", lead: "cu-li", with: ["ca-noc"], direction: "Cu Li quên họp", credit: "Lan::cho Cá Nóc nổ tung" });
    assert.equal(ep.headers.get("location"), "/studio/ep-009");
    assert.match(decodeURIComponent((await post("/studio/new", { id: "ep-009", lead: "cu-li", direction: "x" })).headers.get("location")!), /already exists/);

    await post("/studio/ep-009/run", {});
    await studio.settle("ep-009");
    assert.equal(studio.jobs.get("ep-009")!.error, undefined);
    const html = await (await fetch(at + "/studio/ep-009")).text();
    assert.match(html, /Bản hoàn chỉnh/);
    assert.match(html, /\/studio-media\/ep-009\/final\/01\.png/);
    assert.equal((await fetch(at + "/studio-media/ep-009/final/01.png")).status, 200);
    assert.equal((await fetch(at + "/studio-media/..%2F..%2Fcharacters%2Fcu-li%2Fprofile.yaml")).status, 404);
    assert.equal((await fetch(at + "/studio")).status, 200);
  } finally {
    server.close();
  }
});

test("automation runs and motion comic files show up", async () => {
  const { mkdtempSync: tmp, mkdirSync: mk, writeFileSync: write } = await import("node:fs");
  const { Studio } = await import("./studio.js");
  const box = tmp(join(tmpdir(), "hoisau-dash-auto-"));
  const episodesDir = join(box, "episodes");
  const data = join(box, "data");
  writeDemoData(data);
  mk(join(data, "pipeline"), { recursive: true });
  write(
    join(data, "pipeline", "runs.json"),
    JSON.stringify([
      {
        id: "r1", date: "2026-10-27", mode: "mock", status: "partial", startedAt: "2026-10-27T00:30:00Z", finishedAt: "2026-10-27T00:31:00Z", episodeId: "cu-li-ep-001",
        direction: { text: "Cu Li bị gọi họp lúc 6h sáng", source: "comments", commentIds: ["demo_1"], credits: [{ name: "Minh Anh", comment: "x" }], lead: "cu-li", characters: ["cu-li"] },
        stages: [{ name: "studio", status: "done", startedAt: "" }, { name: "publish", status: "failed", startedAt: "", error: "token <hết hạn>" }],
        posts: [{ platform: "threads", format: "reels-9x16", status: "failed", error: "quota" }, { platform: "facebook", format: "carousel-4x5", status: "published", permalink: "https://facebook.com/p/1" }],
        video: "cu-li-ep-001/motion/reel.mp4", cover: "cu-li-ep-001/motion/cover.jpg",
      },
    ]),
  );
  const ep = join(episodesDir, "cu-li-ep-001");
  mk(join(ep, "motion", "layers"), { recursive: true });
  write(join(ep, "episode.json"), JSON.stringify({ id: "cu-li-ep-001", lead: "cu-li", characters: ["cu-li"], direction: "x", credits: [], createdAt: "" }));
  write(join(ep, "motion", "reel.mp4"), Buffer.alloc(1000, 7));
  write(join(ep, "motion", "cover.jpg"), "jpg");
  write(join(ep, "motion", "layers", "secret.png"), "x");
  write(join(ep, "motion", "motion.json"), JSON.stringify({ duration: 21.5, width: 1080, height: 1920, segments: [] }));
  write(join(ep, "post.json"), JSON.stringify({ episodeId: "cu-li-ep-001", captions: { facebook: "Cu Li <3 deadline #hoisau", threads: "Ngắn" } }));
  const studio = new Studio({ episodesDir, charactersDir: join(box, "none"), runsDir, mock: true, open: () => { throw new Error("unused"); } });
  const server = await startDashboard({ dataDir: data, runsDir, studio, channel: () => ({ facebook: true, instagram: true, mock: false }) }, 0);
  const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const auto = await (await fetch(at + "/automation")).text();
    assert.match(auto, /Xong một phần/);
    assert.match(auto, /token &lt;hết hạn&gt;/);
    assert.match(auto, /href="\/studio\/cu-li-ep-001"/);
    assert.match(auto, /https:\/\/facebook.com\/p\/1/);
    assert.match(await (await fetch(at + "/")).text(), /Lần chạy gần nhất/);

    const page = await (await fetch(at + "/studio/cu-li-ep-001")).text();
    assert.match(page, /<video[^>]+src="\/studio-media\/cu-li-ep-001\/motion\/reel\.mp4"/);
    assert.match(page, /21\.5 giây/);
    assert.match(page, /Cu Li &lt;3 deadline/);

    const part = await fetch(at + "/studio-media/cu-li-ep-001/motion/reel.mp4", { headers: { Range: "bytes=100-199" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 100-199/1000");
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    assert.equal((await fetch(at + "/studio-media/cu-li-ep-001/motion/layers/secret.png")).status, 404);
  } finally {
    server.close();
  }
});

test("posting streak counts Hanoi days in a row, ending today or yesterday", async () => {
  const { postingStreak } = await import("./data.js");
  const ep = (at: string) => ({ key: at, episodeId: "x", character: "x", brand: "hoi-sau", platform: "facebook" as const, format: "f", state: "published" as const, at });
  const now = new Date("2026-10-30T03:00:00Z"); // 10:00 on 30 Oct in Hanoi
  assert.equal(postingStreak([ep("2026-10-29T20:00:00Z"), ep("2026-10-29T01:00:00Z"), ep("2026-10-28T01:00:00Z")], now), 3); // 30, 29, 28 Oct in Hanoi
  assert.equal(postingStreak([ep("2026-10-29T01:00:00Z"), ep("2026-10-27T01:00:00Z")], now), 1);
  assert.equal(postingStreak([ep("2026-10-26T01:00:00Z")], now), 0);
});

test("coach lessons and episode scores show on the dashboard", async () => {
  const { mkdtempSync: tmp } = await import("node:fs");
  const { seedLessons } = await import("./seed.js");
  const seriesDir = tmp(join(tmpdir(), "hoisau-dash-series-"));
  seedLessons(seriesDir);
  const s = loadState({ dataDir, runsDir, seriesDir });
  assert.equal(s.lessons.length, 3);
  assert.ok(s.stats.length > 0 && s.stats.every((x) => typeof x.score === "number"));
  const server = await startDashboard({ dataDir, runsDir, seriesDir, channel: () => ({ facebook: true, instagram: true, mock: false }) }, 0);
  const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const home = await (await fetch(at + "/")).text();
    assert.match(home, /Bài học từ khán giả/);
    assert.match(home, /class="lesson bad">Tránh/);
    assert.match(home, /Chuỗi ngày đăng/);
    assert.match(await (await fetch(at + "/episodes")).text(), /<th[^>]*>Điểm<\/th>/);
  } finally {
    server.close();
  }
});

test("brands: Hồi Sau plus a channel per character, with what each needs in .env", async () => {
  const s = loadState({ dataDir, runsDir, env: { FB_PAGE_ID: "1", FB_PAGE_TOKEN: "t", FB_PAGE_ID_LOLO: "2" } });
  assert.deepEqual(s.brands.map((b) => b.brand.id), ["hoi-sau", "lolo", "poppy", "pango", "uni"]);
  const lolo = s.brands.find((b) => b.brand.id === "lolo")!;
  assert.equal(lolo.character?.profile.slug, "cu-li");
  assert.ok(lolo.posts > 0 && lolo.comments > 0, "demo data has Lolo posts with comments");
  assert.deepEqual(lolo.channels[0].missing, ["FB_PAGE_TOKEN_LOLO"]);
  // Old keys stay on the main brand.
  assert.ok(s.episodes.filter((e) => !e.key.endsWith(":lolo")).every((e) => e.brand === "hoi-sau"));

  const list = await (await fetch(base + "/channels")).text();
  assert.match(list, /kênh tổng/);
  for (const name of ["Lolo", "Poppy", "Pango", "Uni"]) assert.match(list, new RegExp(`<h2>${name}</h2>`));
  const page = await (await fetch(base + "/channels/lolo")).text();
  assert.match(page, /FB_PAGE_TOKEN_LOLO/);
  assert.match(page, /setup &lt;token&gt; --brand lolo/);
  assert.doesNotMatch(page, /hoi-sau-only/);
  assert.equal((await fetch(base + "/channels/nope")).status, 404);
  const filtered = await (await fetch(base + "/comments?brand=lolo")).text();
  assert.match(filtered, /Mọi kênh/);
});

test("pictures first: placeholder portraits are served and pages use them", async () => {
  const res = await fetch(base + "/portrait/cu-li.svg");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /svg/);
  assert.equal((await fetch(base + "/portrait/..%2Fsecret.svg")).status, 404);
  const home = await (await fetch(base + "/")).text();
  assert.match(home, /class="cast-card"/);
  assert.match(await (await fetch(base + "/channels")).text(), /src="\/portrait\/sao-la\.svg"/);
});

test("studio: pick a series style, draw and lock a sheet with poses, make a three-panel page", async () => {
  const { mkdtempSync: tmp, cpSync, existsSync } = await import("node:fs");
  const { CHARACTERS_DIR, SERIES_DIR, openStudio, loadStyle, loadProfile } = await import("@hoi-sau/studio");
  const { Studio } = await import("./studio.js");
  const box = tmp(join(tmpdir(), "hoisau-dash-style-"));
  const dirs = { charactersDir: join(box, "characters"), seriesDir: join(box, "series"), episodesDir: join(box, "episodes") };
  cpSync(CHARACTERS_DIR, dirs.charactersDir, { recursive: true });
  cpSync(SERIES_DIR, dirs.seriesDir, { recursive: true });
  const runs = join(box, "runs");
  const studio = new Studio({ ...dirs, runsDir: runs, styleDir: join(box, "style"), mock: true, open: (log) => openStudio({ mock: true, ...dirs, log }) });
  const server = await startDashboard({ dataDir, runsDir: runs, charactersDir: dirs.charactersDir, studio, channel: () => ({ facebook: false, instagram: false, mock: false }) }, 0);
  const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, form: Record<string, string | string[]> = {}) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) for (const x of [v].flat()) body.append(k, x);
    return fetch(at + path, { method: "POST", body, redirect: "manual" });
  };
  try {
    // Style: nothing drawn yet, then four renders, then one chosen and served.
    assert.match(await (await fetch(at + "/style")).text(), /Vẽ thử 4 kiểu/);
    assert.equal((await post("/style/draw")).headers.get("location"), "/style");
    await studio.settle("style");
    assert.equal(studio.jobs.get("style")!.error, undefined);
    const picker = await (await fetch(at + "/style")).text();
    assert.equal((picker.match(/action="\/style\/[a-z-]+\/approve"/g) ?? []).length, 4);
    assert.equal((await fetch(at + "/style-media/warm-pastel.png")).status, 200);
    assert.equal((await post("/style/warm-pastel/approve")).headers.get("location"), "/style");
    assert.equal(loadStyle(dirs.seriesDir)!.chosen, "warm-pastel");
    assert.match(await (await fetch(at + "/style")).text(), /Ảnh neo đang dùng/);
    assert.equal((await fetch(at + "/series-media/style-ref.png")).status, 200);
    assert.equal((await fetch(at + "/series-media/bible.yaml")).status, 404);
    assert.match(decodeURIComponent((await post("/style/nope/approve")).headers.get("location")!), /unknown style/);

    // Sheet: drawn from the dashboard in the chosen style, then locked with its pose sheet.
    assert.match(await (await fetch(at + "/characters/te-te")).text(), /Vẽ sheet/);
    await post("/characters/te-te/sheet");
    await studio.settle("sheet:te-te");
    assert.equal(studio.jobs.get("sheet:te-te")!.error, undefined);
    const run = JSON.parse(readFileSync(join(runs, "te-te", "run.json"), "utf8"));
    assert.deepEqual(run.images.map((i: { id: string }) => i.id), ["sheet", "poses", "desk", "meeting", "gag"]);
    assert.match(run.images[0].prompt, /Warm pastel palette/);
    await post("/characters/te-te/approve");
    assert.equal(loadProfile("te-te", dirs.charactersDir).look.pose_sheet, "pose-sheet.png");
    const char = await (await fetch(at + "/characters/te-te")).text();
    assert.match(char, /\/sheet\/te-te\/pose-sheet\.png/);
    assert.match(char, /Đồ nhận diện/);
    assert.equal((await fetch(at + "/sheet/te-te/pose-sheet.png")).status, 200);

    // A strip3 episode: the form offers it first, and the page shows the one-image post.
    assert.match(await (await fetch(at + "/studio")).text(), /<option value="strip3" selected>/);
    await post("/studio/new", { id: "ep-010", lead: "te-te", with: ["cu-li"], direction: "Ở nhà thì chán, đi làm thì mệt", format: "strip3" });
    await post("/studio/ep-010/run");
    await studio.settle("ep-010");
    assert.equal(studio.jobs.get("ep-010")!.error, undefined);
    const html = await (await fetch(at + "/studio/ep-010")).text();
    assert.match(html, /Trang đăng/);
    assert.match(html, /\/studio-media\/ep-010\/final\/page\.png/);
    assert.ok(existsSync(join(dirs.episodesDir, "ep-010", "final", "page.png")));
  } finally {
    server.close();
  }
});
