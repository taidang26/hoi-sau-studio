import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { postHash, type EpisodePost } from "@hoi-sau/channel";
import { buildTai, mediaPath, taiItems, taiPage } from "./tai.js";

const root = mkdtempSync(join(tmpdir(), "hoisau-tai-"));
after(() => rmSync(root, { recursive: true, force: true }));

function approved(id: string, post: EpisodePost, at: string, opts: { inFolder?: boolean; video?: boolean; cover?: boolean; hash?: string } = {}) {
  const dir = join(root, "episodes", id);
  mkdirSync(dir, { recursive: true });
  if (opts.video) writeFileSync(join(dir, "video.mp4"), "mp4");
  if (opts.cover) writeFileSync(join(dir, "cover.jpg"), "jpg");
  writeFileSync(opts.inFolder ? join(dir, "post.json") : join(root, "posts", `${id}.json`), JSON.stringify(post));
  writeFileSync(join(dir, "approval.json"), JSON.stringify({ episodeId: id, approvedBy: "t", approvedAt: at, files: {}, post: opts.hash ?? postHash(post) }));
}

mkdirSync(join(root, "posts"), { recursive: true });
mkdirSync(join(root, "site", "media", "ep-9"), { recursive: true });
for (const n of ["01", "02"]) writeFileSync(join(root, "site", "media", "ep-9", `${n}.jpg`), n);
const reel = (id: string, caption: string): EpisodePost => ({ episodeId: id, format: "reels-9x16", caption, mediaUrls: [`https://hoisau.web.app/media/pilot/${id}.mp4`] });
approved("clip-3", reel("clip-3", "Mệt nhất tuần <là> thứ Hai\n#danvanphong"), "2026-10-29T06:00:00Z", { video: true, cover: true });
approved("clip-4", reel("clip-4", "KPI"), "2026-10-29T10:00:00Z", { video: true });
approved("clip-5", reel("clip-5", "changed"), "2026-10-29T11:00:00Z", { video: true, hash: "old" });
approved("clip-3-still", { episodeId: "clip-3-still", format: "image-4x5", caption: "q", mediaUrls: ["x.jpg"] }, "2026-10-29T07:00:00Z");
approved("ep-9", { episodeId: "ep-9", format: "carousel-4x5", caption: "100 ngày trước Tết\n#tet", mediaUrls: ["ep-9/01.jpg", "ep-9/02.jpg"] }, "2026-10-28T09:00:00Z", { inFolder: true });

test("tai: approved videos and photo posts, newest first; changed posts and Threads stills left out", () => {
  const { items, skipped } = taiItems({ episodes: join(root, "episodes"), posts: join(root, "posts"), media: join(root, "site", "media") });
  assert.deepEqual(items.map((i) => i.id), ["clip-4", "clip-3", "ep-9"]);
  assert.deepEqual(skipped, ["clip-5: the post changed after approval"]);
  assert.equal(items[1].title, "Mệt nhất tuần <là> thứ Hai");
  assert.ok(items[1].cover && !items[0].cover);
  assert.equal(items[2].kind, "photos");
  assert.equal(mediaPath("https://hoisau.web.app/media/ep-9/01.jpg", "/m"), join("/m", "ep-9/01.jpg"));
});

test("tai: the page escapes captions and shares each set of files at once", () => {
  const { items } = taiItems({ episodes: join(root, "episodes"), posts: join(root, "posts"), media: join(root, "site", "media") });
  const html = taiPage(items);
  assert.match(html, /Mệt nhất tuần &lt;là&gt; thứ Hai/);
  assert.match(html, /share\(this,\['\/media\/dl\/ep-9-01\.jpg','\/media\/dl\/ep-9-02\.jpg'\],'image\/jpeg'\)/);
  assert.match(html, /Lưu cả bộ 2 ảnh/);
  assert.match(html, /\/media\/dl\/clip-3-bia\.jpg/);
  assert.ok(html.indexOf("<h3>Video</h3>") < html.indexOf("<h3>Bài ảnh</h3>"));
});

test("tai: build copies the approved files under the names the page uses", () => {
  const { file } = buildTai({ episodes: join(root, "episodes"), posts: join(root, "posts"), site: join(root, "site") });
  assert.ok(existsSync(file));
  assert.equal(readFileSync(join(root, "site", "media", "dl", "ep-9-02.jpg"), "utf8"), "02");
  assert.ok(existsSync(join(root, "site", "media", "dl", "clip-3.mp4")) && existsSync(join(root, "site", "media", "dl", "clip-3-bia.jpg")));
});
