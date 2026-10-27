/**
 * Server-rendered pages. Plain HTML strings, one stylesheet, no client
 * framework: the dashboard is a window onto files, not an app of its own.
 */

import { canReply, windowClosesAt, type Comment, type Conversation } from "@hoi-sau/channel";
import type { BrandView, CharacterView, Episode, Run, State } from "./data.js";

export const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface ChannelStatus {
  facebook: boolean;
  instagram: boolean;
  mock: boolean;
}

const time = (iso: string) =>
  new Date(iso).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const PLATFORM = { facebook: "Facebook", instagram: "Instagram", threads: "Threads" } as const;
const platformName = (p: string) => (PLATFORM as Record<string, string>)[p] ?? p;
const FORMAT: Record<string, string> = { "carousel-4x5": "Carousel 4:5", "image-4x5": "Trang 3 khung 4:5", "reels-9x16": "Reels 9:16" };

// Line icons, 24px grid, stroke follows currentColor.
const icon = (d: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const NAV = [
  ["/", "Tổng quan", icon('<rect x="3" y="3" width="7.5" height="9" rx="2"/><rect x="13.5" y="3" width="7.5" height="5" rx="2"/><rect x="13.5" y="11" width="7.5" height="10" rx="2"/><rect x="3" y="15" width="7.5" height="6" rx="2"/>')],
  ["/channels", "Kênh", icon('<circle cx="12" cy="12" r="2.5"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2"/>')],
  ["/characters", "Nhân vật", icon('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>')],
  ["/style", "Phong cách", icon('<circle cx="12" cy="12" r="9"/><circle cx="8.5" cy="10" r="1.3"/><circle cx="12" cy="7.5" r="1.3"/><circle cx="15.5" cy="10" r="1.3"/><path d="M12 21a2.5 2.5 0 0 1 0-5h2.5a2.5 2.5 0 0 0 2.5-2.5"/>')],
  ["/studio", "Studio", icon('<path d="M4 20l4-1 11-11a2.1 2.1 0 0 0-3-3L5 16z"/><path d="M14 7l3 3"/>')],
  ["/automation", "Tự động", icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>')],
  ["/episodes", "Tập đã đăng", icon('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M8 4v5M16 4v5"/>')],
  ["/inbox", "Hộp thư", icon('<path d="M3 13l3-8h12l3 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>')],
  ["/comments", "Bình luận", icon('<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1z"/>')],
] as const;

export function layout(title: string, path: string, body: string): string {
  const nav = NAV.map(([href, label, svg]) => {
    const active = href === "/" ? path === "/" : path.startsWith(href);
    return `<a href="${href}"${active ? ' class="active" aria-current="page"' : ""}>${svg}<span>${label}</span></a>`;
  }).join("");
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#eef1f8">
<title>${esc(title)} · Hồi Sau</title><link rel="stylesheet" href="/static/app.css"></head>
<body><div class="shell"><aside class="side"><a class="brand" href="/"><span class="mark">HS</span><span>Hồi Sau<small>Studio dashboard</small></span></a><nav>${nav}</nav>
<p class="side-foot">Khán giả viết tiếp.<br>Xem hồi sau sẽ rõ.</p></aside>
<main>${body}</main></div></body></html>`;
}

const swatches = (c: CharacterView) =>
  `<span class="swatches">${c.profile.look.palette.map((s) => `<i style="background:${esc(s.hex)}" title="${esc(s.name)} ${esc(s.hex)}"></i>`).join("")}</span>`;

/** The character's picture: the latest Muse Image sheet, else the placeholder portrait. */
const charSrc = (c: CharacterView) => {
  const sheet = c.run?.images.find((i) => i.id === "sheet");
  return sheet ? `/media/${esc(c.profile.slug)}/${esc(sheet.file)}` : `/portrait/${esc(c.profile.slug)}.svg`;
};

const sheetImg = (c: CharacterView) =>
  c.run?.images.some((i) => i.id === "sheet")
    ? `<img src="${charSrc(c)}" alt="Character sheet ${esc(c.profile.name)}" loading="lazy">`
    : `<div class="ph portrait" style="background:${esc(c.profile.look.palette[0].hex)}33"><img src="${charSrc(c)}" alt="${esc(c.profile.name)}" loading="lazy"><span class="badge" title="Chân dung tạm, thay bằng model sheet khi chạy Muse Image">tạm</span></div>`;

/** Round face of a character, by slug. */
function face(s: State, slug: string, size = "") {
  const c = s.characters.find((x) => x.profile.slug === slug);
  if (!c) return "";
  return `<img class="face${size ? ` ${size}` : ""}" src="${charSrc(c)}" alt="${esc(c.profile.name)}" title="${esc(c.profile.name)}" style="background:${esc(c.profile.look.palette[0].hex)}44" loading="lazy">`;
}

/** Comic page 1 (or the motion cover) of an episode, if Studio made it. */
const thumb = (s: State, episodeId: string, cls = "thumb") => {
  const c = s.comics.get(episodeId);
  return c?.cover ? `<img class="${cls}" src="${esc(c.cover)}" alt="${esc(c.title)}" loading="lazy">` : "";
};

const mini = (label: string, value: string | number, hint = "") =>
  `<div class="mini"><b>${esc(value)}</b><span>${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ""}</div>`;

function stat(label: string, value: string | number, hint = ""): string {
  return `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ""}</div>`;
}

function commentRow(c: Comment, s: State, picked: Set<string>): string {
  const ep = s.byPost.get(c.postId);
  const isPicked = picked.has(c.id);
  return `<li class="comment${isPicked ? " picked" : ""}">
<div class="avatar">${c.author.avatarUrl ? `<img src="${esc(c.author.avatarUrl)}" alt="">` : esc(c.author.name.trim().charAt(0).toUpperCase())}</div>
<div class="c-body"><div class="c-meta"><b>${esc(c.author.name)}</b><span class="tag ${c.platform}">${PLATFORM[c.platform]}</span>${ep && s.brands.length > 1 ? `<span class="muted small">${esc(brandName(s, ep.brand))}</span>` : ""}${ep ? `<a href="/comments?episode=${esc(ep.episodeId)}">${esc(ep.episodeId)}</a>` : ""}<time>${time(c.createdAt)}</time>${c.parentId ? '<span class="muted">trả lời</span>' : ""}</div>
<p>${esc(c.text)}</p></div>
${ep ? `<a class="c-thumb" href="/comments?episode=${esc(ep.episodeId)}">${thumb(s, ep.episodeId)}</a>` : ""}
<form method="post" action="/comments/${encodeURIComponent(c.id)}/pick"><button class="${isPicked ? "btn on" : "btn"}" title="Dùng làm hướng cho tập sau">${isPicked ? "✓ Đã chọn" : "Chọn hướng"}</button></form></li>`;
}

export function overviewPage(s: State, ch: ChannelStatus): string {
  const published = s.episodes.filter((e) => e.state === "published");
  const stuck = s.episodes.filter((e) => e.state === "publishing");
  const picked = new Set(s.directions.map((d) => d.commentId));
  const dayAgo = Date.now() - 24 * 3600_000;
  const fresh = s.comments.filter((c) => Date.parse(c.createdAt) > dayAgo).length;

  const channel = (ok: boolean, name: string) =>
    `<li><span class="dot ${ok ? "ok" : "off"}"></span>${name}<span class="muted">${ok ? "đã kết nối" : "chưa kết nối"}</span></li>`;

  // Newest published episode that Studio has pages for, else the newest Studio episode.
  const latestId = published.find((e) => s.comics.get(e.episodeId)?.pages.length)?.episodeId ?? [...s.comics.values()].pop()?.id;
  const latest = latestId ? s.comics.get(latestId) : undefined;
  const latestPosts = published.filter((e) => e.episodeId === latestId);
  const latestComments = s.comments.filter((c) => s.byPost.get(c.postId)?.episodeId === latestId).length;
  const hero = latest
    ? `<section class="card hero-comic"><div class="hero-meta"><span class="tag due">Tập mới nhất</span><h2>${esc(latest.title)}</h2>${latest.logline ? `<p class="muted">${esc(latest.logline)}</p>` : ""}
<div class="faces">${[...new Set([latest.lead, ...latest.characters])].map((slug) => face(s, slug)).join("")}</div>
<div class="hero-tags">${latestPosts.map((e) => (e.permalink ? `<a class="tag ${e.platform}" href="${esc(e.permalink)}" target="_blank" rel="noopener">${esc(platformName(e.platform))} ↗</a>` : `<span class="tag ${e.platform}">${esc(platformName(e.platform))}</span>`)).join("")}</div>
<p class="muted small">${latestComments} bình luận · <a href="/studio/${esc(latest.id)}">mở trong Studio</a></p></div>
<a class="strip" href="/studio/${esc(latest.id)}">${latest.reel ? `<video src="${esc(latest.reel)}" muted loop playsinline autoplay poster="${esc(latest.cover ?? "")}"></video>` : ""}${latest.pages.map((p, i) => `<img src="${esc(p)}" alt="Trang ${i + 1}" loading="lazy">`).join("")}</a></section>`
    : "";

  const cast = s.characters
    .map((c) => {
      const max = Math.max(1, ...s.characters.map((x) => x.comments));
      return `<a class="cast-card" href="/characters/${esc(c.profile.slug)}"><img src="${charSrc(c)}" alt="" style="background:${esc(c.profile.look.palette[0].hex)}44" loading="lazy"><b>${esc(c.profile.name)}</b>
<span class="bar"><i style="width:${Math.round((c.comments / max) * 100)}%;background:${esc(c.profile.look.palette[0].hex)}"></i></span><small class="muted">${c.comments} bình luận · ${c.episodes} tập</small></a>`;
    })
    .join("");

  const body = `<header class="page-head"><div><h1>Tổng quan</h1></div>
<div class="minis">${mini("Tập", new Set(published.map((e) => e.episodeId)).size)}${mini("Bình luận", s.comments.length, fresh ? `+${fresh} hôm nay` : "")}${mini("Chuỗi ngày đăng", s.streak)}${mini("Hướng đã chọn", picked.size)}${mini("Tin chờ", s.inbox.filter((c) => canReply(c) && c.messages[c.messages.length - 1]?.from === "customer").length)}</div></header>
${stuck.length ? `<div class="warn"><b>${stuck.length} bài đang ở trạng thái "đang đăng".</b> Có thể đã lên trang: kiểm tra trước khi đăng lại. ${stuck.map((e) => `<code>${esc(e.key)}</code>`).join(" ")}</div>` : ""}
${hero}
<section class="cast">${cast}</section>
<div class="grid2">
${s.brands.length ? brandsCard(s, ch) : `<section class="card"><h2>Kênh</h2><ul class="channels">${channel(ch.facebook, "Facebook Page")}${channel(ch.instagram, "Instagram")}</ul>
${ch.mock ? '<p class="muted">Đang chạy với Graph API giả lập (META_GRAPH_MOCK=1).</p>' : ""}</section>`}
${lessonsCard(s)}
${lastRun(s.runs[0])}
</div>
<section class="card"><div class="card-head"><h2>Bình luận mới nhất</h2><a href="/comments">Xem tất cả →</a></div>
${s.comments.length ? `<ul class="comments">${s.comments.slice(0, 5).map((c) => commentRow(c, s, picked)).join("")}</ul>` : empty("Chưa có bình luận.", "npm run channel -- comments")}</section>`;
  return layout("Tổng quan", "/", body);
}

const RUN_STATUS: Record<Run["status"], [string, string]> = {
  running: ["warn", "Đang chạy"],
  done: ["ok", "Xong"],
  partial: ["warn", "Xong một phần"],
  failed: ["bad", "Lỗi"],
};
const STAGE: Record<string, string> = { listen: "Đọc bình luận", direction: "Chọn hướng", studio: "Studio", motion: "Motion comic", package: "Đóng gói", upload: "Tải lên", publish: "Đăng bài" };

const LESSON: Record<string, [string, string]> = { do: ["ok", "Nên"], avoid: ["bad", "Tránh"], test: ["warn", "Thử"] };

/** What the story coach learned from published episodes; the writer reads the same list. */
function lessonsCard(s: State): string {
  if (!s.lessons.length) return "";
  const rows = s.lessons
    .map((l) => {
      const [cls, label] = LESSON[l.kind] ?? ["off", l.kind];
      return `<li><span class="lesson ${cls}">${label}</span><span>${esc(l.text)}${l.evidence.length ? ` <span class="muted small">(${l.evidence.map(esc).join(", ")})</span>` : ""}</span></li>`;
    })
    .join("");
  return `<section class="card"><div class="card-head"><h2>Bài học từ khán giả</h2>${s.lessonsAt ? `<span class="muted small">${time(s.lessonsAt)}</span>` : ""}</div><ul class="lessons">${rows}</ul><p class="muted small">Rút ra từ số liệu các tập đã đăng (<code>npm run story -- coach</code>). Người viết kịch bản đọc đúng danh sách này.</p></section>`;
}

function lastRun(r?: Run): string {
  if (!r) return "";
  const [cls, label] = RUN_STATUS[r.status];
  return `<a class="card run-card" href="/automation"><div class="card-head"><h2>Lần chạy gần nhất</h2><span><span class="dot ${cls}"></span>${label}</span></div>
<p class="muted small">${esc(r.date)} · ${time(r.startedAt)}${r.mode === "mock" ? " · giả lập" : ""}${r.episodeId ? ` · ${esc(r.episodeId)}` : ""}</p>${stageChips(r)}</a>`;
}

const stageChips = (r: Run) =>
  `<ol class="stages">${r.stages.map((g) => `<li class="${esc(g.status)}" title="${esc(g.error ?? g.note ?? "")}">${esc(STAGE[g.name] ?? g.name)}</li>`).join("")}</ol>`;

export function automationPage(s: State, studio: boolean): string {
  const rows = s.runs
    .map((r) => {
      const [cls, label] = RUN_STATUS[r.status];
      const ep = r.episodeId ? (studio ? `<a href="/studio/${esc(r.episodeId)}">${esc(r.episodeId)}</a>` : esc(r.episodeId)) : "–";
      const posts = r.posts.length
        ? `<ul class="posts">${r.posts
            .map(
              (p) =>
                `<li><span class="tag ${esc(p.platform)}">${esc(platformName(p.platform))}</span> ${esc(FORMAT[p.format] ?? p.format)} · ${
                  p.status === "published" ? (p.permalink ? `<a href="${esc(p.permalink)}" target="_blank" rel="noopener">đã đăng ↗</a>` : "đã đăng") : p.status === "failed" ? `<span class="bad-text">lỗi: ${esc(p.error ?? "")}</span>` : '<span class="muted">bỏ qua</span>'
                }</li>`,
            )
            .join("")}</ul>`
        : "";
      const notes = r.stages.filter((g) => g.error || g.note).map((g) => `<li><b>${esc(STAGE[g.name] ?? g.name)}:</b> ${esc(g.error ?? g.note)}</li>`).join("");
      return `<section class="card run"><div class="card-head"><h2>${esc(r.date)} ${r.mode === "mock" ? '<span class="tag">giả lập</span>' : ""}</h2><span><span class="dot ${cls}"></span>${label}</span></div>
<div class="run-body">${r.cover && studio ? `<a href="/studio-media/${r.cover.split("/").map(encodeURIComponent).join("/")}" class="cover"><img src="/studio-media/${r.cover.split("/").map(encodeURIComponent).join("/")}" alt="Ảnh bìa" loading="lazy"></a>` : ""}
<div><p class="muted small">Tập ${ep} · bắt đầu ${time(r.startedAt)}${r.finishedAt ? ` · xong ${time(r.finishedAt)}` : ""}</p>${stageChips(r)}
${r.direction ? `<p><b>Hướng</b> <span class="muted small">(${esc(r.direction.source)})</span>: ${esc(r.direction.text)}</p>${r.direction.credits.length ? `<p class="muted small">Ghi công: ${r.direction.credits.map((c) => esc(c.name)).join(", ")}</p>` : ""}` : ""}
${posts}${notes ? `<ul class="notes small">${notes}</ul>` : ""}${r.error ? `<div class="warn small">${esc(r.error)}</div>` : ""}</div></div></section>`;
    })
    .join("");
  const body = `<header class="page-head"><div><h1>Tự động</h1><p class="muted">Mỗi ngày: đọc bình luận → chọn hướng → Studio làm tập → dựng motion comic → đăng Facebook, Instagram, Threads. Chạy thử: <code>npm run pipeline -- run --mock</code></p></div></header>
${rows || empty("Chưa có lần chạy nào.", "npm run pipeline -- run --mock")}${s.runs.some((r) => r.status === "running") ? '<meta http-equiv="refresh" content="5">' : ""}`;
  return layout("Tự động", "/automation", body);
}

function empty(text: string, cmd?: string): string {
  return `<div class="empty"><p>${esc(text)}</p>${cmd ? `<code>${esc(cmd)}</code>` : ""}</div>`;
}

export function charactersPage(s: State): string {
  const cards = s.characters
    .map(
      (c) => `<a class="card char" href="/characters/${esc(c.profile.slug)}">${sheetImg(c)}<div class="char-body"><h2>${esc(c.profile.name)} <span class="muted">${esc(c.profile.species)}</span></h2>
<p class="type">${esc(c.profile.office_type)}</p><p>${esc(c.profile.core_gag)}</p>${swatches(c)}<p class="muted small">${c.episodes} tập · ${c.comments} bình luận</p></div></a>`,
    )
    .join("");
  return layout("Nhân vật", "/characters", `<header class="page-head"><div><h1>Nhân vật</h1><p class="muted">Các nhân vật chạy cùng kịch bản; con nào có số liệu tốt nhất sẽ thành kênh chính.</p></div><a class="btn on" href="/characters/new">+ Tạo nhân vật</a></header><div class="chars">${cards}</div>`);
}

export interface SheetControls {
  /** The dashboard can start a Muse Image run (Studio is wired up). */
  canDraw: boolean;
  /** Step of a running sheet job, if one is running. */
  drawing?: string;
  error?: string;
}

export function characterPage(c: CharacterView, draw?: SheetControls): string {
  const p = c.profile;
  const list = (items: string[]) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
  const images = c.run
    ? `<div class="shots">${c.run.images
        .map((i) => `<figure><img src="/media/${esc(p.slug)}/${esc(i.file)}" alt="${esc(i.id)}" loading="lazy"><figcaption>${esc(i.id)} · ${esc(i.size)}</figcaption></figure>`)
        .join("")}</div><p class="muted small">${c.run.mock ? "Ảnh giả lập (chạy --mock). " : ""}${esc(c.run.model)} · ${time(c.run.startedAt)} · <a href="/media/${esc(p.slug)}/review.html">trang soát nét nhận dạng</a></p>`
    : empty("Chưa có lần thử Muse Image nào.", draw?.canDraw ? "" : `npm run studio -- sheet ${p.slug}`);
  const drawBar = !draw?.canDraw
    ? ""
    : draw.drawing
      ? `<div class="notice"><b>Đang vẽ:</b> ${esc(draw.drawing)}</div><meta http-equiv="refresh" content="2">`
      : `${draw.error ? `<div class="warn small">${esc(draw.error)}</div>` : ""}<form method="post" action="/characters/${esc(p.slug)}/sheet"><button class="btn${c.run ? "" : " on"}" title="Model sheet, bộ 6 tư thế và 3 khung thử, theo phong cách series">${c.run ? "Vẽ lại sheet" : "Vẽ sheet"}</button></form>`;
  const body = `<p><a href="/characters">← Nhân vật</a></p><header class="page-head"><div><h1>${esc(p.name)}</h1><p class="muted">${esc(p.species)} · ${esc(p.role)}</p></div>${swatches(c)}</header>
${modelSheet(c)}
<section class="card"><div class="card-head"><h2>Muse Image: thử độ nhất quán</h2>${drawBar}</div>${images}</section>
${depth(c)}
<div class="grid2"><section class="card"><h2>Ngoại hình</h2><p>${esc(p.look.description)}</p>${p.look.icon ? `<h3>Đồ nhận diện</h3><p>${esc(p.look.icon)}</p>` : ""}<h3>Không được sai</h3>${list(p.look.signature)}<h3>Biểu cảm</h3>${list(Object.entries(p.look.expressions).map(([k, v]) => `${k}: ${v}`))}</section>
<section class="card"><h2>Tính cách và giọng</h2>${list(p.personality)}<h3>Câu cửa miệng</h3>${list(p.voice.catchphrases)}<h3>Không bao giờ nói</h3>${list(p.never_says)}</section></div>`;
  return layout(p.name, "/characters", body);
}

/** Want, fear, contradiction, life, comic engine and relationships, when the profile has them. */
function depth(c: CharacterView): string {
  const p = c.profile;
  if (!p.want && !p.contradiction && !p.comic_engine?.length) return "";
  const list = (items: string[]) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
  const kv = [["Muốn", p.want], ["Sợ", p.fear], ["Mâu thuẫn", p.contradiction]].filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
  return `<div class="grid2"><section class="card"><h2>Con người</h2>${kv ? `<dl class="kv">${kv}</dl>` : ""}${p.life?.length ? `<h3>Đời sống</h3>${list(p.life)}` : ""}</section>
<section class="card"><h2>Cơ chế gây cười</h2>${list(p.comic_engine ?? [])}${p.relationships?.length ? `<h3>Quan hệ</h3>${list(p.relationships.map((r) => r.dynamic))}` : ""}</section></div>`;
}

/** The locked sheet every panel is drawn against, or the button that locks the latest test sheet. */
function modelSheet(c: CharacterView): string {
  const p = c.profile;
  if (p.look.character_sheet)
    return `<section class="card"><div class="card-head"><h2>Model sheet đã khoá</h2>${c.run ? `<form method="post" action="/characters/${esc(p.slug)}/approve"><button class="btn" title="Thay bằng sheet của lần thử mới nhất">Khoá lại bằng sheet mới</button></form>` : ""}</div>
<img class="sheet" src="/sheet/${esc(p.slug)}/${esc(p.look.character_sheet)}" alt="Model sheet ${esc(p.name)}">${p.look.pose_sheet ? `<img class="sheet" src="/sheet/${esc(p.slug)}/${esc(p.look.pose_sheet)}" alt="Bộ tư thế ${esc(p.name)}">` : ""}<p class="muted small">Mỗi khung truyện gửi kèm ${p.look.pose_sheet ? "hai ảnh này" : "ảnh này"} cho Muse Image, và Muse Spark soát khung theo model sheet.</p></section>`;
  return c.run
    ? `<section class="card"><div class="card-head"><h2>Model sheet</h2><form method="post" action="/characters/${esc(p.slug)}/approve"><button class="btn on">Khoá model sheet</button></form></div><p class="muted">Ưng character sheet bên dưới thì khoá nó lại: từ đó mọi khung truyện đều vẽ theo sheet này.</p></section>`
    : "";
}

export function episodesPage(s: State): string {
  const rows = s.episodes
    .map((e: Episode) => {
      const n = s.comments.filter((c) => c.postId === e.postId).length;
      const st = s.stats.find((x) => x.episodeId === e.episodeId);
      return `<tr><td><b>${esc(e.episodeId)}</b></td><td>${esc(s.characters.find((c) => c.profile.slug === e.character)?.profile.name ?? e.character)}</td><td>${brandLink(s, e.brand)}</td><td><span class="tag ${e.platform}">${PLATFORM[e.platform]}</span></td><td>${esc(FORMAT[e.format] ?? e.format)}</td>
<td>${e.state === "published" ? '<span class="dot ok"></span>Đã đăng' : '<span class="dot warn"></span>Đang đăng'}</td><td>${time(e.at)}</td><td>${e.postId ? `<a href="/comments?episode=${esc(e.episodeId)}">${n}</a>` : "–"}</td><td title="${st ? esc(`${st.authors} người bình luận, ${st.shares} share, ${st.saves} save`) : ""}">${st ? st.score : "–"}</td><td>${e.permalink ? `<a href="${esc(e.permalink)}" target="_blank" rel="noopener">Mở ↗</a>` : ""}</td></tr>`;
    })
    .join("");
  const ids = [...new Set(s.episodes.map((e) => e.episodeId))];
  const cards = ids
    .map((id) => {
      const posts = s.episodes.filter((e) => e.episodeId === id);
      const comic = s.comics.get(id);
      const st = s.stats.find((x) => x.episodeId === id);
      const n = s.comments.filter((c) => s.byPost.get(c.postId)?.episodeId === id).length;
      const cast = comic ? [...new Set([comic.lead, ...comic.characters])] : [posts[0].character];
      const brands = [...new Set(posts.map((e) => e.brand))];
      return `<article class="card ep-card"><a class="ep-cover" href="${comic ? `/studio/${esc(id)}` : `/comments?episode=${esc(id)}`}">${comic?.cover ? `<img src="${esc(comic.cover)}" alt="${esc(comic.title)}" loading="lazy">` : `<div class="ph">${face(s, posts[0].character, "lg")}</div>`}${st ? `<span class="score" title="Điểm tương tác">${st.score}</span>` : ""}</a>
<div class="ep-body"><div class="faces">${cast.map((slug) => face(s, slug)).join("")}</div><h2>${esc(comic?.title ?? id)}</h2>
<div class="hero-tags">${[...new Set(posts.map((e) => e.platform))].map((pl) => {
        const live = posts.filter((e) => e.platform === pl && e.state === "published");
        return live.length ? `<a class="tag ${pl}" href="${esc(live[0].permalink ?? "#")}" target="_blank" rel="noopener">${esc(platformName(pl))}${live.length > 1 ? ` ×${live.length}` : ""}</a>` : `<span class="tag over">${esc(platformName(pl))} đang đăng</span>`;
      }).join("")}</div>
${brands.length > 1 ? `<p class="muted small">${brands.map((b) => esc(brandName(s, b))).join(" · ")}</p>` : ""}
<p class="muted small"><a href="/comments?episode=${esc(id)}">💬 ${n}</a> · ${time(posts[posts.length - 1].at)}</p></div></article>`;
    })
    .join("");
  const body = `<header class="page-head"><div><h1>Tập đã đăng</h1></div></header>
${s.episodes.length ? `<div class="ep-grid">${cards}</div>
<details class="card"><summary>Chi tiết từng bài</summary><div class="scroll"><table><thead><tr><th>Tập</th><th>Nhân vật</th><th>Kênh</th><th>Nền tảng</th><th>Định dạng</th><th>Trạng thái</th><th>Thời gian</th><th>Bình luận</th><th title="Điểm tương tác của tập (story coach), sau 24 giờ">Điểm</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></details>` : empty("Chưa đăng tập nào.", "npm run channel -- publish episode.json")}`;
  return layout("Tập đã đăng", "/episodes", body);
}

export interface CommentFilter {
  q?: string;
  platform?: string;
  episode?: string;
  brand?: string;
  picked?: boolean;
}

export function filterComments(s: State, f: CommentFilter): Comment[] {
  const picked = new Set(s.directions.map((d) => d.commentId));
  const q = f.q?.normalize("NFC").toLocaleLowerCase("vi");
  return s.comments.filter(
    (c) =>
      (!f.platform || c.platform === f.platform) &&
      (!f.episode || s.byPost.get(c.postId)?.episodeId === f.episode) &&
      (!f.brand || s.byPost.get(c.postId)?.brand === f.brand) &&
      (!f.picked || picked.has(c.id)) &&
      (!q || `${c.text} ${c.author.name}`.normalize("NFC").toLocaleLowerCase("vi").includes(q)),
  );
}

export function commentsPage(s: State, f: CommentFilter): string {
  const picked = new Set(s.directions.map((d) => d.commentId));
  const list = filterComments(s, f);
  const episodes = [...new Set(s.episodes.filter((e) => e.postId).map((e) => e.episodeId))];
  const opt = (v: string, label: string, cur?: string) => `<option value="${esc(v)}"${v === (cur ?? "") ? " selected" : ""}>${esc(label)}</option>`;
  const body = `<header class="page-head"><div><h1>Bình luận</h1><p class="muted">Bình luận của chính Page đã được lọc bỏ. Chọn những ý hay làm hướng cho tập sau; bước lọc và gom ý bằng Muse Spark sẽ có ở lịch 31/10.</p></div></header>
<form class="filters" method="get" action="/comments"><input type="search" name="q" value="${esc(f.q)}" placeholder="Tìm trong bình luận hoặc tên người viết">
<select name="platform">${opt("", "Mọi nền tảng", f.platform)}${opt("facebook", "Facebook", f.platform)}${opt("instagram", "Instagram", f.platform)}</select>
${s.brands.length > 1 ? `<select name="brand">${opt("", "Mọi kênh", f.brand)}${s.brands.map((b) => opt(b.brand.id, b.brand.name, f.brand)).join("")}</select>` : ""}
<select name="episode">${opt("", "Mọi tập", f.episode)}${episodes.map((e) => opt(e, e, f.episode)).join("")}</select>
<label class="check"><input type="checkbox" name="picked" value="1"${f.picked ? " checked" : ""}> Chỉ ý đã chọn</label><button class="btn">Lọc</button></form>
<p class="muted small">${list.length} / ${s.comments.length} bình luận · ${picked.size} hướng đã chọn</p>
<section class="card">${list.length ? `<ul class="comments">${list.map((c) => commentRow(c, s, picked)).join("")}</ul>` : empty(s.comments.length ? "Không có bình luận khớp bộ lọc." : "Chưa có bình luận.", s.comments.length ? undefined : "npm run channel -- comments")}</section>`;
  return layout("Bình luận", "/comments", body);
}

export function notFoundPage(): string {
  return layout("Không tìm thấy", "", `<h1>Không tìm thấy trang</h1><p><a href="/">Về tổng quan</a></p>`);
}

function remaining(c: Conversation, now: Date): string {
  const closes = windowClosesAt(c);
  if (!closes) return "Khách chưa nhắn";
  const ms = closes.getTime() - now.getTime();
  if (ms <= 0) return "Quá 24 giờ";
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return h ? `Còn ${h} giờ ${m} phút` : `Còn ${m} phút`;
}

const initial = (name: string) => esc(name.trim().charAt(0).toUpperCase() || "?");

export interface InboxView {
  selected?: string;
  error?: string;
  sent?: boolean;
  canPull: boolean;
  now?: Date;
}

export function inboxPage(s: State, v: InboxView): string {
  const now = v.now ?? new Date();
  const current = s.inbox.find((c) => c.id === v.selected) ?? s.inbox[0];
  const list = s.inbox
    .map((c) => {
      const last = c.messages[c.messages.length - 1];
      const open = canReply(c, now);
      const waiting = last?.from === "customer";
      return `<a class="conv${c === current ? " active" : ""}" href="/inbox?c=${encodeURIComponent(c.id)}"><div class="avatar">${initial(c.customer.name)}</div>
<div class="conv-body"><div class="conv-top"><b>${esc(c.customer.name)}</b><time>${time(c.updatedAt)}</time></div>
<p>${last ? `${last.from === "page" ? "Bạn: " : ""}${esc(last.text || (last.attachments ? "[Tệp đính kèm]" : ""))}` : ""}</p>
<div class="conv-tags"><span class="tag ${c.platform}">${PLATFORM[c.platform]}</span>${s.brands.length > 1 ? `<span class="tag">${esc(brandName(s, c.brand ?? "hoi-sau"))}</span>` : ""}${waiting && open ? '<span class="tag due">Chờ trả lời</span>' : ""}${open ? "" : '<span class="tag closed">Quá 24 giờ</span>'}</div></div></a>`;
    })
    .join("");

  let thread = empty("Chưa có tin nhắn nào.", "npm run channel -- inbox");
  if (current) {
    const open = canReply(current, now);
    const bubbles = current.messages
      .map((m) => `<div class="msg ${m.from}"><div class="bubble">${esc(m.text)}${m.attachments ? `<span class="att">📎 ${m.attachments} tệp đính kèm</span>` : ""}</div><time>${time(m.createdAt)}</time></div>`)
      .join("");
    thread = `<header class="thread-head"><div class="avatar">${initial(current.customer.name)}</div><div><b>${esc(current.customer.name)}</b><span class="muted small"> · ${PLATFORM[current.platform]}</span></div>
<span class="window ${open ? "open" : "closed"}">${remaining(current, now)}</span></header>
<div class="msgs" id="msgs">${bubbles}</div>
${v.error ? `<div class="warn small">${esc(v.error)}</div>` : ""}
${
  open
    ? `<form class="composer" method="post" action="/inbox/${encodeURIComponent(current.id)}/reply"><textarea name="text" rows="2" maxlength="2000" placeholder="Trả lời ${esc(current.customer.name)}…" required></textarea><button class="btn on">Gửi</button></form>`
    : `<p class="closed-note">Đã quá 24 giờ kể từ tin cuối của khách nên Meta không cho gửi tin thường. Khách nhắn lại thì cửa sổ mở lại.</p>`
}<script>var m=document.getElementById("msgs");if(m)m.scrollTop=m.scrollHeight;</script>`;
  }

  const waiting = s.inbox.filter((c) => canReply(c, now) && c.messages[c.messages.length - 1]?.from === "customer").length;
  const body = `<header class="page-head"><div><h1>Hộp thư</h1><p class="muted">Tin nhắn Messenger và Instagram của các Page. ${waiting} hội thoại đang chờ trả lời.</p></div>
${v.canPull ? `<form method="post" action="/inbox/refresh"><button class="btn">Kéo tin mới</button></form>` : ""}</header>
<div class="inbox"><section class="card conv-list">${list || empty("Hộp thư trống.")}</section><section class="card thread">${thread}</section></div>`;
  return layout("Hộp thư", "/inbox", body);
}

// Brands and channels: Hồi Sau is the main channel, each character a brand with its own accounts.

const STATUS: Record<string, [string, string]> = { live: ["ok", "Đang chạy"], paused: ["warn", "Tạm dừng"], planned: ["off", "Chưa tạo"] };
const brandName = (s: State, id: string) => s.brands.find((b) => b.brand.id === id)?.brand.name ?? id;
const brandLink = (s: State, id: string) => `<a href="/channels/${esc(id)}">${esc(brandName(s, id))}</a>`;

/** Live, ready to post, needs .env, paused or planned. */
function channelDot(c: BrandView["channels"][number]): [string, string] {
  if (c.status === "live") return c.missing.length ? ["bad", "Thiếu cấu hình"] : ["ok", "Đang chạy"];
  return STATUS[c.status];
}

const chips = (b: BrandView) =>
  `<ul class="ch-chips">${b.channels
    .map((c) => {
      const [cls, label] = channelDot(c);
      return `<li title="${esc(label)}"><span class="dot ${cls}"></span>${esc(platformName(c.platform))}</li>`;
    })
    .join("")}</ul>`;

function brandAvatar(b: BrandView): string {
  if (b.character) return `<img class="b-ava" src="${charSrc(b.character)}" alt="" style="background:${esc(b.character.profile.look.palette[0].hex)}44">`;
  return `<span class="b-ava${b.brand.kind === "series" ? " series" : ""}">${b.brand.kind === "series" ? "HS" : esc(b.brand.name.charAt(0))}</span>`;
}

const brandCounts = (b: BrandView) => `${b.episodes} tập · ${b.posts} bài · ${b.comments} bình luận${b.lastPostAt ? ` · đăng gần nhất ${time(b.lastPostAt)}` : ""}`;

function brandsCard(s: State, ch: ChannelStatus): string {
  const rows = s.brands
    .map((b) => {
      const live = b.channels.filter((c) => c.status === "live");
      const bad = live.filter((c) => c.missing.length).length;
      const note = !live.length ? "tạm dừng" : bad ? `${bad} kênh thiếu cấu hình` : `${live.length} kênh đang chạy`;
      return `<li title="${esc(note)}"><a href="/channels/${esc(b.brand.id)}">${brandAvatar(b)}<b>${esc(b.brand.name)}</b></a>${chips(b)}</li>`;
    })
    .join("");
  return `<section class="card"><div class="card-head"><h2>Kênh</h2><a href="/channels">Quản lý →</a></div><ul class="brand-list">${rows}</ul>
${ch.mock ? '<p class="muted small">Đang chạy với Graph API giả lập (META_GRAPH_MOCK=1).</p>' : ""}</section>`;
}

export function channelsPage(s: State): string {
  const main = s.brands.find((b) => b.brand.kind === "series");
  const chars = s.brands.filter((b) => b.brand.kind === "character");
  const covers = (b: BrandView) => {
    const ids = [...new Set(s.episodes.filter((e) => e.brand === b.brand.id && e.state === "published").map((e) => e.episodeId))].slice(0, 4);
    const imgs = ids.map((id) => thumb(s, id)).filter(Boolean).join("");
    return imgs ? `<div class="covers">${imgs}</div>` : "";
  };
  const card = (b: BrandView) => `<a class="card brand-card" href="/channels/${esc(b.brand.id)}">
<div class="b-cover" style="background:${esc(b.character?.profile.look.palette[0].hex ?? "#ccc")}55">${b.character ? `<img src="${charSrc(b.character)}" alt="${esc(b.brand.name)}" loading="lazy">` : ""}</div>
<div class="b-body"><h2>${esc(b.brand.name)}</h2><p class="muted small">${esc(b.brand.tagline ?? "")}</p>${chips(b)}${covers(b)}<p class="muted small">${b.episodes} tập · ${b.comments} bình luận</p></div></a>`;
  const hero = main
    ? `<a class="card brand-hero" href="/channels/${esc(main.brand.id)}"><div class="b-top">${brandAvatar(main)}<div><h2>${esc(main.brand.name)} <span class="tag">kênh tổng</span></h2><p class="muted">${esc(main.brand.tagline ?? "")}</p></div>
<div class="faces big">${s.characters.map((c) => face(s, c.profile.slug, "lg")).join("")}</div></div>
${covers(main)}<div class="hero-row">${chips(main)}<span class="muted small">${brandCounts(main)}</span></div></a>`
    : "";
  const body = `<header class="page-head"><div><h1>Kênh</h1><p class="muted small">Cấu hình ở <code>channels.yaml</code>, token trong <code>.env</code>.</p></div></header>
${s.brands.length ? `${hero}<h2 class="section-title">Kênh nhân vật</h2><div class="brands">${chars.map(card).join("")}</div>` : empty("Chưa có channels.yaml.")}`;
  return layout("Kênh", "/channels", body);
}

export function brandPage(s: State, id: string): string | undefined {
  const b = s.brands.find((x) => x.brand.id === id);
  if (!b) return undefined;
  const flag = b.brand.kind === "series" ? "" : ` --brand ${b.brand.id}`;
  const setup: Record<string, string> = { facebook: `setup <token>${flag}`, instagram: `setup <token>${flag}`, threads: `threads-setup <token>${flag}` };
  const rows = b.channels
    .map((c) => {
      const [cls, label] = channelDot(c);
      const names = Object.values(c.env).filter(Boolean) as string[];
      const vars = names.map((n) => `<code class="${c.missing.includes(n) ? "miss" : "set"}" title="${c.missing.includes(n) ? "chưa đặt" : "đã đặt"}">${esc(n)}</code>`).join(" ");
      return `<tr><td><span class="tag ${c.platform}">${esc(platformName(c.platform))}</span></td><td><span class="dot ${cls}"></span>${label}</td><td>${vars}</td><td>${c.status === "planned" ? '<span class="muted small">tạo tài khoản trước</span>' : c.missing.length ? `<code>npm run channel -- ${esc(setup[c.platform])}</code>` : '<span class="muted small">sẵn sàng</span>'}</td></tr>`;
    })
    .join("");
  const eps = s.episodes.filter((e) => e.brand === b.brand.id);
  const posts = eps
    .slice(0, 12)
    .map((e) => `<tr><td><b>${esc(e.episodeId)}</b></td><td><span class="tag ${e.platform}">${esc(platformName(e.platform))}</span></td><td>${esc(FORMAT[e.format] ?? e.format)}</td><td>${e.state === "published" ? '<span class="dot ok"></span>Đã đăng' : '<span class="dot warn"></span>Đang đăng'}</td><td>${time(e.at)}</td><td>${e.permalink ? `<a href="${esc(e.permalink)}" target="_blank" rel="noopener">Mở ↗</a>` : ""}</td></tr>`)
    .join("");
  const picked = new Set(s.directions.map((d) => d.commentId));
  const comments = filterComments(s, { brand: b.brand.id });
  const route = b.brand.posts === "all" ? "Nhận mọi tập." : b.brand.posts === "lead" ? `Nhận các tập ${esc(b.character?.profile.name ?? b.brand.name)} đóng chính.` : `Nhận các tập có ${esc(b.character?.profile.name ?? b.brand.name)}.`;
  const body = `<p><a href="/channels">← Kênh</a></p><header class="page-head"><div class="b-top">${brandAvatar(b)}<div><h1>${esc(b.brand.name)}</h1><p class="muted">${esc(b.brand.tagline ?? "")}${b.character ? ` · <a href="/characters/${esc(b.character.profile.slug)}">hồ sơ nhân vật</a>` : ""}</p></div></div></header>
<section class="stats">${stat("Tập đã đăng", b.episodes, `${b.posts} bài`)}${stat("Bình luận", b.comments)}${stat("Kênh đang chạy", b.channels.filter((c) => c.status === "live" && !c.missing.length).length, `trên ${b.channels.length} kênh`)}</section>
<section class="card"><div class="card-head"><h2>Tài khoản</h2><span class="muted small">${route}</span></div><div class="scroll"><table class="channels-table"><thead><tr><th>Nền tảng</th><th>Trạng thái</th><th>Biến trong .env</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="muted small">Đổi trạng thái (live, paused, planned) trong <code>channels.yaml</code>. Dashboard chỉ xem biến đã có giá trị hay chưa, không đọc token.</p></section>
<section class="card"><h2>Bài đã đăng</h2>${posts ? `<div class="scroll"><table><thead><tr><th>Tập</th><th>Nền tảng</th><th>Định dạng</th><th>Trạng thái</th><th>Thời gian</th><th></th></tr></thead><tbody>${posts}</tbody></table></div>` : empty("Kênh này chưa đăng bài nào.", `npm run channel -- publish episodes/<id>/post.json${flag}`)}</section>
<section class="card"><div class="card-head"><h2>Bình luận</h2>${comments.length ? `<a href="/comments?brand=${esc(b.brand.id)}">Xem tất cả →</a>` : ""}</div>${comments.length ? `<ul class="comments">${comments.slice(0, 6).map((c) => commentRow(c, s, picked)).join("")}</ul>` : empty("Chưa có bình luận.")}</section>`;
  return layout(b.brand.name, "/channels", body);
}
