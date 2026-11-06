import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { pickPosts, planDays, stockPage, type ScrapedPost } from "./kho.js";
import { mockExec, Videos } from "./video.js";

const post = (id: string, content: string, type: string | null, reactions: number, shares = 0): ScrapedPost => ({
  source_id: id,
  content,
  item_timestamp: "2026-10-01T00:00:00.000Z",
  url: `https://example.com/p/${id}`,
  reactions_count: reactions,
  share_count: shares,
  comment_count: 0,
  attachments_detail: type ? [{ type, url: `https://img.example.com/${id}.jpg` }] : [],
});

const posts = [
  post("1", "Lương tháng này về rồi đi đâu mất", "photo", 500, 100),
  post("2", "Clip phim cắt ra", "video", 90000),
  post("3", "Sếp lưu ý: nhân sự đang rất ngoan, sau Tết thì chưa chắc", null, 800),
  post("4", "Ngắn", null, 9999),
  post("5", "Page sắp tổ chức minigame", "photo", 5000),
  post("6", "Lương tháng này về rồi đi đâu mất", "photo", 10),
  post("7", "Tiền đâu mà tiêu", "photo", 400),
  post("8", "Thứ hai lại đến", "photo", 300),
];

test("scraped posts: videos, page notices, short text and repeats are left out; shares count more than likes", () => {
  const { items, left } = pickPosts(posts);
  assert.deepEqual(items.map((i) => i.sourceId), ["1", "3", "7", "8"]);
  assert.equal(items[0].score, 500 + 5 * 100);
  assert.equal(items[1].kind, "text");
  assert.equal(left["video, clip của người khác"], 1);
  assert.equal(left["không hợp kênh"], 1);
  assert.equal(left["trùng"], 1);
  assert.equal(pickPosts(posts, new Set(["1", "lươngthángnàyvềrồiđiđâumất"])).items.length, 3);
});

test("days: best first, a few a day, no topic twice on a day, dated posts wait for their date", () => {
  const items = [
    { score: 90, topic: "luong", caption: "Lương 1" },
    { score: 80, topic: "luong", caption: "Lương 2" },
    { score: 70, topic: "sep", caption: "Sếp" },
    { score: 60, topic: "khac", caption: "Nhật ký 20/10" },
  ] as Array<{ score: number; topic: string; caption: string; makeOn?: string; slot?: number; season?: string }>;
  planDays(items, "2026-11-07", 2);
  assert.deepEqual(items.map((i) => i.makeOn), ["2026-11-07", "2026-11-08", "2026-11-07", "2027-10-17"]);
  assert.equal(items[3].season, "20/10");
});

test("the stock: added from a scrape, pictures downloaded, read into meme proposals, shown by day", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoisau-kho-"));
  const jpg = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#fff" } }).jpeg().toBuffer();
  const got: string[] = [];
  const v = new Videos({
    dir: join(root, "video"),
    episodesDir: join(root, "episodes"),
    siteMediaDir: join(root, "site"),
    mediaBase: "https://example.com/media/",
    samplesDirs: [],
    cast: () => [{ slug: "cu-li", name: "Lolo" }],
    exec: mockExec(),
    deploy: false,
    fetch: async (url) => {
      got.push(url);
      const dead = url.includes("/8.jpg");
      return { ok: !dead, status: dead ? 403 : 200, arrayBuffer: async () => jpg.buffer.slice(jpg.byteOffset, jpg.byteOffset + jpg.byteLength) as ArrayBuffer };
    },
  });
  const k = v.stock;
  const r = k.add(posts, { perDay: 2, start: "2026-11-07" });
  assert.equal(r.added, 4);
  assert.equal(k.add(posts, { start: "2026-11-07" }).added, 0, "adding the same file twice keeps one of each");
  const items = k.load().items;
  assert.ok(items.every((i) => /^k-\d{4}$/.test(i.id)));
  assert.equal(readFileSync(join(k.dirOf(items.find((i) => i.kind === "text")!), "input.txt"), "utf8"), "Sếp lưu ý: nhân sự đang rất ngoan, sau Tết thì chưa chắc");
  assert.equal(k.status(items.find((i) => i.sourceId === "1")!), "download");

  assert.equal(k.download(), 3);
  await k.settle();
  const by = (id: string) => k.load().items.find((i) => i.sourceId === id)!;
  assert.ok(existsSync(join(k.dirOf(by("1")), "img-1.jpg")));
  assert.equal(k.status(by("8")), "failed", "an expired link is shown, not hidden");
  assert.match(by("8").error ?? "", /403/);

  const n = k.readDays(1, "2026-11-07");
  assert.equal(n, 1, "only today's item whose picture came down");
  await k.settle();
  assert.equal(k.status(by("1")), "ready");
  assert.ok(existsSync(join(k.dirOf(by("1")), "idea.json")));
  assert.equal(by("3").season, "Tết", "a Tết post waits for Tết");

  // The week in one go: today's proposal becomes a drawn and rendered text clip, linked from the stock.
  assert.equal(k.makeDays(1, "2026-11-07"), 1);
  await k.settle();
  const made = by("1");
  assert.ok(made.video, "the clip is remembered on the item");
  assert.equal(k.status(made), "made");
  assert.ok(existsSync(v.videoFile(made.video!, "plain")), "rendered");
  assert.equal(k.makeDays(1, "2026-11-07"), 0, "a clip is made once");
  assert.match(stockPage(k, { all: true }), new RegExp(`/video/${made.video}`));

  k.setSkip(by("7").id, true);
  assert.equal(k.status(by("7")), "skip");
  const html = stockPage(k, { all: true });
  assert.match(html, /Đã có clip/);
  assert.match(html, /Đã bỏ/);
  assert.doesNotMatch(html, /Than Thở/);
});
