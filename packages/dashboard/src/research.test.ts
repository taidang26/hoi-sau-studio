import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { svgToPng } from "@hoi-sau/svg-text";
import { demoAnalyst, instagramHandle, Research, seedResearch } from "./research.js";
import { writeDemoData } from "./seed.js";
import { startDashboard } from "./server.js";

const root = mkdtempSync(join(tmpdir(), "hoisau-research-"));
const cast = () => [
  { slug: "cu-li", name: "Lolo", about: "slow intern" },
  { slug: "ca-noc", name: "Poppy", about: "puffs up" },
];
const png = (fill: string) => svgToPng(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="100"><rect width="80" height="100" fill="${fill}"/></svg>`);
const research = new Research({
  dir: join(root, "research"),
  cast,
  analyst: (() => {
    const a = demoAnalyst(() => cast().map((c) => c.slug));
    return () => a;
  })(),
  discover: async (handle) => [{ image: "https://cdn.example/1.png", link: `https://www.instagram.com/p/1/`, account: handle, caption: "hi" }],
  fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(png("#abcdef")).buffer }),
});
let base = "";
let close = () => {};

before(async () => {
  const dataDir = join(root, "data");
  writeDemoData(dataDir);
  const server = await startDashboard({ dataDir, runsDir: join(root, "runs"), research, channel: () => ({ facebook: false, instagram: false, mock: false }) }, 0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

test("instagram handles from @name, name or a profile link", () => {
  assert.equal(instagramHandle("@satank.vn"), "satank.vn");
  assert.equal(instagramHandle("https://www.instagram.com/chim_chim/?hl=vi"), "chim_chim");
  assert.throws(() => instagramHandle("not a name!"), /không hợp lệ/);
});

test("images are kept once, anything else is refused", () => {
  const a = research.add("lolo", png("#ff0000"), { from: "upload" });
  assert.equal(a.added, true);
  assert.equal(research.add("lolo", png("#ff0000"), { from: "upload" }).added, false);
  assert.throws(() => research.add("lolo", Buffer.from("hello"), { from: "upload" }), /PNG, JPG/);
  assert.throws(() => research.add("../x", png("#000"), { from: "upload" }), /Không thấy kênh/);
});

test("reading an image gives recipes; pins feed the next episode, then are spent", async () => {
  const { clip } = research.add("hoi-sau", png("#00ff00"), { from: "upload", link: "https://example.com/p" });
  const read = await research.read("hoi-sau", clip.id);
  assert.equal(read.status, "done");
  assert.ok(read.ideas.length >= 1);
  assert.ok(read.ideas.every((i) => i.fits.every((f) => ["cu-li", "ca-noc"].includes(f))));
  const [first, second] = read.ideas;
  research.pin("hoi-sau", first.id, { to: "next" });
  research.pin("hoi-sau", second.id, { to: "character", slug: "cu-li" });
  assert.equal(research.pinned(["ca-noc"]).length, 1, "a character note shows only for that character");
  assert.equal(research.pinned(["cu-li"]).length, 2);
  const refs = [`hoi-sau:${first.id}`, `hoi-sau:${second.id}`];
  assert.match(research.recipes(refs), new RegExp(first.title));
  research.attach(refs, "cu-li-ep-009");
  assert.equal(research.pinned().length, 1, "the next-episode pin is spent; the character note stays");
  assert.deepEqual(research.sourcesOf("cu-li-ep-009").map((c) => c.id), [clip.id]);
});

test("the similarity check flags a page that is the source itself", async () => {
  const { clip } = research.add("hoi-sau", png("#0000ff"), { from: "upload" });
  const read = await research.read("hoi-sau", clip.id);
  research.attach([`hoi-sau:${read.ideas[0].id}`], "copy-ep");
  const pages = join(root, "pages");
  mkdirSync(pages, { recursive: true });
  writeFileSync(join(pages, "same.png"), png("#0000ff"));
  writeFileSync(join(pages, "ours.png"), png("#ffff00"));
  research.compare("copy-ep", [join(pages, "same.png")]);
  while (research.jobs.get("compare:copy-ep")?.running) await new Promise((r) => setTimeout(r, 10));
  assert.equal(research.comparison("copy-ep")!.results[0].tooClose, true);
  research.compare("copy-ep", [join(pages, "ours.png")]);
  while (research.jobs.get("compare:copy-ep")?.running) await new Promise((r) => setTimeout(r, 10));
  assert.equal(research.comparison("copy-ep")!.results[0].tooClose, false);
});

test("Instagram import downloads the posts and keeps the source", async () => {
  assert.equal(await research.importInstagram("poppy", "@someone"), 1);
  const [c] = research.list("poppy");
  assert.equal(c.source.account, "someone");
  assert.equal(c.source.link, "https://www.instagram.com/p/1/");
  assert.equal(await research.importInstagram("poppy", "someone"), 0, "the same post twice is kept once");
});

test("the page: upload, read, pin, and the images are served", async () => {
  await seedResearch(research, "uni");
  const page = await (await fetch(`${base}/research?brand=uni`)).text();
  assert.match(page, /Tư liệu/);
  assert.match(page, /không bao giờ làm ảnh mẫu khi vẽ/);
  assert.doesNotMatch(page, /npm run|\.env\b|library\.json/);
  const [, src, w] = page.match(/src="(\/research-media\/uni\/files\/[a-f0-9]+\.png)(\?w=\d+)"/)!;
  assert.equal((await fetch(base + src)).headers.get("content-type"), "image/png");
  assert.equal((await fetch(base + src + w)).headers.get("content-type"), "image/webp", "the page asks for a small WebP");
  assert.equal((await fetch(`${base}/research-media/uni/library.json`)).status, 404);

  const form = new FormData();
  form.append("files", new Blob([new Uint8Array(png("#123456"))], { type: "image/png" }), "a.png");
  form.append("link", "https://example.com/post");
  const up = await fetch(`${base}/research/upload?brand=uni`, { method: "POST", body: form, redirect: "manual" });
  assert.match(decodeURIComponent(up.headers.get("location")!), /ok=Đã thêm 1 ảnh/);
  const read = await fetch(`${base}/research/read?brand=uni`, { method: "POST", redirect: "manual" });
  assert.equal(read.status, 303);
  while (research.running("uni")) await new Promise((r) => setTimeout(r, 10));
  assert.ok(research.list("uni").every((c) => c.status === "done"));

  const en = await (await fetch(`${base}/research?brand=uni`, { headers: { cookie: "lang=en" } })).text();
  assert.match(en, />References</);
});
