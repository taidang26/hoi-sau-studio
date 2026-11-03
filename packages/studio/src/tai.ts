/**
 * hoisau.web.app/tai: the owner's phone page for posting to TikTok by hand.
 * Built from what was approved: every episode folder with an approval.json
 * whose post still matches it. Videos (reels) and photo posts (carousel or a
 * single picture) get save buttons, the cover when there is one, and the
 * caption to copy. Threads stills (`*-still`) are not TikTok posts and are left out.
 *
 *   npm run studio -- tai     writes site/public/tai/index.html and copies the files into site/public/media/dl/
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { postHash, readApproval, type EpisodePost } from "@hoi-sau/channel";

export interface TaiItem {
  id: string;
  kind: "video" | "photos";
  /** First caption line, at most 90 characters (TikTok's photo title). */
  title: string;
  caption: string;
  approvedAt: string;
  /** Files to copy, in order: the approved video, or the photos. */
  media: string[];
  /** The episode's cover.jpg (see `talk cover --episode`), if any. */
  cover?: string;
}

/** A post's media path on disk: absolute site URLs and relative paths are both read under the site's media folder. */
export function mediaPath(url: string, mediaDir: string): string {
  return join(mediaDir, url.replace(/^https?:\/\/[^/]+\/media\//, "").replace(/^\/?media\//, ""));
}

/** What the page lists, newest approval first, plus why anything approved was left out. */
export function taiItems(opts: { episodes: string; posts: string; media: string }): { items: TaiItem[]; skipped: string[] } {
  const items: TaiItem[] = [], skipped: string[] = [];
  if (!existsSync(opts.episodes)) return { items, skipped };
  for (const id of readdirSync(opts.episodes).sort()) {
    const dir = join(opts.episodes, id);
    const approval = readApproval(dir);
    if (!approval || id.endsWith("-still")) continue;
    const postFile = [join(dir, "post.json"), join(opts.posts, `${id}.json`)].find(existsSync);
    if (!postFile) { skipped.push(`${id}: no post.json`); continue; }
    const post = JSON.parse(readFileSync(postFile, "utf8")) as EpisodePost;
    if (approval.post !== postHash(post)) { skipped.push(`${id}: the post changed after approval`); continue; }
    const video = post.format === "reels-9x16";
    const media = video ? [join(dir, "video.mp4")] : post.mediaUrls.map((u) => mediaPath(u, opts.media));
    const missing = media.filter((m) => !existsSync(m));
    if (missing.length) { skipped.push(`${id}: missing ${missing.join(", ")}`); continue; }
    const cover = join(dir, "cover.jpg");
    items.push({
      id, kind: video ? "video" : "photos",
      title: post.caption.split("\n")[0].slice(0, 90), caption: post.caption,
      approvedAt: approval.approvedAt, media, cover: existsSync(cover) ? cover : undefined,
    });
  }
  items.sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));
  return { items, skipped };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const js = (urls: string[]) => `[${urls.map((u) => `'${u}'`).join(",")}]`;
const copyBox = (label: string, text: string, rows: number) =>
  `<label>${esc(label)}</label><textarea readonly rows="${rows}">${esc(text)}</textarea><button class="btn ghost" onclick="cp(this)">Copy ${esc(label.toLowerCase())}</button>`;

/** Where each item's files are served from, under /media/dl/. */
export function taiUrls(item: TaiItem): { media: string[]; cover?: string } {
  const media = item.kind === "video" ? [`/media/dl/${item.id}.mp4`] : item.media.map((_, i) => `/media/dl/${item.id}-${String(i + 1).padStart(2, "0")}.jpg`);
  return { media, cover: item.cover ? `/media/dl/${item.id}-bia.jpg` : undefined };
}

function card(item: TaiItem): string {
  const { media, cover } = taiUrls(item);
  const coverHtml = cover ? `<img src="${cover}" alt="Ảnh bìa" loading="lazy"><button class="btn ghost" onclick="share(this,['${cover}'],'image/jpeg')">Lưu ảnh bìa</button>` : "";
  if (item.kind === "video") {
    return `<section class="card"><h2>${esc(item.title)}</h2>
<video src="${media[0]}" controls playsinline preload="metadata"></video>
<button class="btn" onclick="share(this,${js(media)},'video/mp4')">Lưu video vào Ảnh</button>
<a class="btn ghost" href="${media[0]}" download="${item.id}.mp4">Tải file video</a>
${coverHtml}
${copyBox("Caption TikTok", item.caption, 3)}</section>`;
  }
  const grid = media.map((u, i) => `<figure><img src="${u}" alt="Ảnh ${i + 1}" loading="lazy"><a class="mini" href="${u}" download>Tải ảnh ${i + 1}</a></figure>`).join("");
  return `<section class="card"><h2>${esc(item.title)} · ${media.length} ảnh</h2>
<div class="grid">${grid}</div>
<button class="btn" onclick="share(this,${js(media)},'image/jpeg')">Lưu cả bộ ${media.length} ảnh vào Ảnh</button>
${coverHtml}
${copyBox("Tiêu đề", item.title, 2)}${copyBox("Mô tả", item.caption, 4)}</section>`;
}

/** The page: videos first, then photo posts, each newest first. */
export function taiPage(items: TaiItem[]): string {
  const videos = items.filter((i) => i.kind === "video").map(card).join("\n");
  const photos = items.filter((i) => i.kind === "photos").map(card).join("\n");
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Tải clip Hồi Sau</title>
<style>:root{--bg:#fbf8f1;--fg:#222;--card:#fff;--line:#e6e0d2;--acc:#e0a526}@media (prefers-color-scheme:dark){:root{--bg:#1c1b19;--fg:#eee;--card:#262522;--line:#3a3833}}
body{background:var(--bg);color:var(--fg);font:17px/1.5 system-ui,sans-serif;margin:0;padding:16px;max-width:560px;margin:auto}h1{font-size:22px}h2{font-size:18px;margin:0 0 8px}h3{margin:28px 0 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin:14px 0}img,video{width:100%;border-radius:8px;display:block}video{max-height:60vh;background:#000}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}figure{margin:0}.mini{display:block;text-align:center;font-size:13px;padding:4px 0;color:var(--fg)}
.btn{display:block;text-align:center;background:var(--acc);color:#222;font-weight:600;border:0;border-radius:10px;padding:12px;margin:10px 0;text-decoration:none;font-size:17px;width:100%;box-sizing:border-box;cursor:pointer}.ghost{background:transparent;border:1px solid var(--line);color:var(--fg)}
textarea{width:100%;box-sizing:border-box;font:inherit;border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--bg);color:var(--fg)}label{font-size:14px;opacity:.7}small{opacity:.7}</style></head><body>
<h1>Tải clip Hồi Sau</h1><small>Bấm "Lưu … vào Ảnh": iPhone mở bảng chia sẻ, chọn "Lưu video" / "Lưu N hình ảnh" là vào thẳng Ảnh. Máy nào không hỗ trợ thì dùng nút tải file (vào Tệp → Tải về). Ảnh bìa: trên TikTok vào Sửa ảnh bìa → Tải lên → chọn ảnh, kiểu chữ để "Không có".</small>
${videos ? `<h3>Video</h3>\n${videos}` : ""}
${photos ? `<h3>Bài ảnh</h3>\n${photos}` : ""}
<script>
function cp(b){const t=b.previousElementSibling;t.select();(navigator.clipboard?navigator.clipboard.writeText(t.value):Promise.resolve(document.execCommand("copy"))).then(()=>{b.textContent="Đã copy ✓"})}
async function share(b,urls,type){
  const old=b.textContent;b.textContent="Đang chuẩn bị…";b.disabled=true;
  try{
    const files=await Promise.all(urls.map(async u=>{const r=await fetch(u);const bl=await r.blob();return new File([bl],u.split("/").pop(),{type})}));
    if(navigator.canShare&&navigator.canShare({files})){await navigator.share({files});b.textContent=old}
    else{for(const u of urls){const a=document.createElement("a");a.href=u;a.download=u.split("/").pop();document.body.appendChild(a);a.click();a.remove();await new Promise(r=>setTimeout(r,400))}b.textContent="Đã tải ✓ (xem Tệp → Tải về)"}
  }catch(err){b.textContent=err&&err.name==="AbortError"?old:"Lỗi, thử nút tải file"}
  b.disabled=false
}
</script></body></html>`;
}

/** Writes the page and copies every listed file into <site>/media/dl/ under the names the page uses. */
export function buildTai(opts: { episodes: string; posts: string; site: string }): { file: string; items: TaiItem[]; skipped: string[] } {
  const media = join(opts.site, "media");
  const { items, skipped } = taiItems({ episodes: opts.episodes, posts: opts.posts, media });
  const dl = join(media, "dl");
  mkdirSync(dl, { recursive: true });
  for (const item of items) {
    const urls = taiUrls(item);
    item.media.forEach((src, i) => copyFileSync(src, join(opts.site, urls.media[i])));
    if (item.cover && urls.cover) copyFileSync(item.cover, join(opts.site, urls.cover));
  }
  mkdirSync(join(opts.site, "tai"), { recursive: true });
  const file = join(opts.site, "tai", "index.html");
  writeFileSync(file, taiPage(items));
  return { file, items, skipped };
}
