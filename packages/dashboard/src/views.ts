/**
 * Server-rendered pages. Plain HTML strings, one stylesheet, no client
 * framework: the dashboard is a window onto files, not an app of its own.
 *
 * Written for the person running the channels, not for a developer: no
 * commands, file names or setting names on screen. Every action is a button.
 * Interface text goes through t() (Vietnamese and English).
 */

import { canReply, windowClosesAt, type Comment, type Conversation } from "@hoi-sau/channel";
import type { BrandView, CharacterView, Episode, Run, State } from "./data.js";
import { lang, locale, t } from "./i18n.js";

export const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface ChannelStatus {
  facebook: boolean;
  instagram: boolean;
  mock: boolean;
}

/** What the pages can offer as buttons, depending on what is set up. */
export interface Abilities {
  /** Comments and messages can be pulled (a Page is connected). */
  canPull: boolean;
  /** Accounts can be connected from here (not sample data). */
  canConnect: boolean;
  /** Studio (Muse) is wired up. */
  studio: boolean;
}

const time = (iso: string) =>
  new Date(iso).toLocaleString(locale(), { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const PLATFORM = { facebook: "Facebook", instagram: "Instagram", threads: "Threads" } as const;
const platformName = (p: string) => (PLATFORM as Record<string, string>)[p] ?? p;
const FORMAT: Record<string, string> = { "carousel-4x5": "Nhiều ảnh, vuốt ngang", "image-4x5": "Một ảnh", "reels-9x16": "Video dọc (Reels)" };
const formatName = (f: string) => (FORMAT[f] ? t(FORMAT[f]) : f);

// Line icons, 24px grid, stroke follows currentColor.
const icon = (d: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const NAV = [
  ["/", "Tổng quan", icon('<rect x="3" y="3" width="7.5" height="9" rx="2"/><rect x="13.5" y="3" width="7.5" height="5" rx="2"/><rect x="13.5" y="11" width="7.5" height="10" rx="2"/><rect x="3" y="15" width="7.5" height="6" rx="2"/>')],
  ["/studio", "Studio", icon('<path d="M4 20l4-1 11-11a2.1 2.1 0 0 0-3-3L5 16z"/><path d="M14 7l3 3"/>')],
  ["/characters", "Nhân vật", icon('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>')],
  ["/style", "Phong cách", icon('<circle cx="12" cy="12" r="9"/><circle cx="8.5" cy="10" r="1.3"/><circle cx="12" cy="7.5" r="1.3"/><circle cx="15.5" cy="10" r="1.3"/><path d="M12 21a2.5 2.5 0 0 1 0-5h2.5a2.5 2.5 0 0 0 2.5-2.5"/>')],
  ["/research", "Tư liệu", icon('<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 9"/>')],
  ["/comments", "Bình luận", icon('<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1z"/>')],
  ["/inbox", "Hộp thư", icon('<path d="M3 13l3-8h12l3 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>')],
  ["/episodes", "Tập đã đăng", icon('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M8 4v5M16 4v5"/>')],
  ["/channels", "Kênh", icon('<circle cx="12" cy="12" r="2.5"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2"/>')],
  ["/automation", "Tự động", icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>')],
  ["/settings", "Cài đặt", icon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>')],
] as const;

export function layout(title: string, path: string, body: string): string {
  const nav = NAV.map(([href, label, svg]) => {
    const active = href === "/" ? path === "/" : path.startsWith(href);
    return `<a href="${href}"${active ? ' class="active" aria-current="page"' : ""} title="${esc(t(label))}">${svg}<span>${esc(t(label))}</span></a>`;
  }).join("");
  const back = encodeURIComponent(path || "/");
  const langs = `<div class="lang" role="group" aria-label="${esc(t("Ngôn ngữ"))}"><a href="/lang/vi?back=${back}"${lang() === "vi" ? ' class="on" aria-current="true"' : ""}>VI</a><a href="/lang/en?back=${back}"${lang() === "en" ? ' class="on" aria-current="true"' : ""}>EN</a></div>`;
  return `<!doctype html><html lang="${lang()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#fff7ee">
<title>${esc(title)} · Hồi Sau</title><link rel="stylesheet" href="/static/app.css"></head>
<body><div class="shell"><input type="checkbox" id="menu" class="menu-toggle" aria-hidden="true"><aside class="side"><div class="side-top"><a class="brand" href="/"><span class="mark">HS</span><span class="brand-name">Hồi Sau<small>${esc(t("Studio truyện tranh"))}</small></span></a>
<label for="menu" class="menu-btn" aria-label="${esc(t("Mở menu"))}">${icon('<path d="M4 7h16M4 12h16M4 17h16"/>')}</label></div><nav>${nav}</nav>
<div class="side-foot">${langs}<p>${esc(t("Khán giả viết tiếp. Xem hồi sau sẽ rõ."))}</p></div></aside>
<main>${body}</main></div></body></html>`;
}

const swatches = (c: CharacterView) =>
  `<span class="swatches">${c.profile.look.palette.map((s) => `<i style="background:${esc(s.hex)}" title="${esc(s.name)} ${esc(s.hex)}"></i>`).join("")}</span>`;

/** The character's picture: the latest Muse Image sheet, else the placeholder portrait. */
export const charSrc = (c: CharacterView) => {
  const sheet = c.run?.images.find((i) => i.id === "sheet");
  return sheet ? `/media/${esc(c.profile.slug)}/${esc(sheet.file)}` : `/portrait/${esc(c.profile.slug)}.svg`;
};

const sheetImg = (c: CharacterView) =>
  c.run?.images.some((i) => i.id === "sheet")
    ? `<img src="${charSrc(c)}" alt="${esc(c.profile.name)}" loading="lazy">`
    : `<div class="ph portrait" style="background:${esc(c.profile.look.palette[0].hex)}33"><img src="${charSrc(c)}" alt="${esc(c.profile.name)}" loading="lazy"><span class="badge" title="${esc(t("Chân dung tạm, thay bằng model sheet khi vẽ bằng AI"))}">${esc(t("tạm"))}</span></div>`;

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

/** An episode by the name people know it by: its title, else a short "Tập N". */
export const episodeName = (s: State, id: string) => s.comics.get(id)?.title ?? id.replace(/^.*?ep-0*(\d+)$/, (_, n) => t("Tập {n}", { n }));

const mini = (label: string, value: string | number, hint = "", href = "") =>
  `<${href ? `a href="${href}"` : "div"} class="mini"><b>${esc(value)}</b><span>${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ""}</${href ? "a" : "div"}>`;

function stat(label: string, value: string | number, hint = ""): string {
  return `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ""}</div>`;
}

/** A small form posting to `action`: the only way pages change anything. */
export const button = (action: string, label: string, cls = "btn", hidden: Record<string, string> = {}) =>
  `<form class="inline" method="post" action="${esc(action)}">${Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("")}<button class="${cls}">${label}</button></form>`;

/** One-line result of the last action, from ?ok= or ?err=. */
export const flash = (ok?: string, err?: string) => `${ok ? `<div class="notice ok-note">${esc(ok)}</div>` : ""}${err ? `<div class="warn small">${esc(err)}</div>` : ""}`;

const pullComments = (a?: Abilities) => (a?.canPull ? button("/comments/refresh", `↻ ${esc(t("Lấy bình luận mới"))}`) : "");
const connectLink = (a?: Abilities) => (a?.canConnect ? `<a class="btn on" href="/channels/hoi-sau">${esc(t("Kết nối Facebook"))}</a>` : "");

function commentRow(c: Comment, s: State, picked: Set<string>): string {
  const ep = s.byPost.get(c.postId);
  const isPicked = picked.has(c.id);
  return `<li class="comment${isPicked ? " picked" : ""}">
<div class="avatar">${c.author.avatarUrl ? `<img src="${esc(c.author.avatarUrl)}" alt="">` : esc(c.author.name.trim().charAt(0).toUpperCase())}</div>
<div class="c-body"><div class="c-meta"><b>${esc(c.author.name)}</b><span class="tag ${c.platform}">${PLATFORM[c.platform]}</span>${ep && s.brands.length > 1 ? `<span class="muted small">${esc(brandName(s, ep.brand))}</span>` : ""}${ep ? `<a href="/comments?episode=${esc(ep.episodeId)}">${esc(episodeName(s, ep.episodeId))}</a>` : ""}<time>${time(c.createdAt)}</time>${c.parentId ? `<span class="muted">${esc(t("trả lời"))}</span>` : ""}</div>
<p>${esc(c.text)}</p></div>
${ep ? `<a class="c-thumb" href="/comments?episode=${esc(ep.episodeId)}">${thumb(s, ep.episodeId)}</a>` : ""}
<form method="post" action="/comments/${encodeURIComponent(c.id)}/pick"><button class="${isPicked ? "btn on" : "btn"}" title="${esc(t("Dùng làm hướng cho tập sau"))}">${isPicked ? `✓ ${esc(t("Đã chọn"))}` : esc(t("Chọn làm ý tập sau"))}</button></form></li>`;
}

/** Today's loop as checkable steps, each with the one button that moves it on. */
function todayCard(s: State, ch: ChannelStatus, a: Abilities): string {
  const picked = new Set(s.directions.map((d) => d.commentId));
  const dayAgo = Date.now() - 24 * 3600_000;
  const waiting = s.inbox.filter((c) => canReply(c) && c.messages[c.messages.length - 1]?.from === "customer").length;
  const madeToday = [...s.comics.values()].length > 0;
  const postedToday = s.episodes.some((e) => e.state === "published" && Date.parse(e.at) > dayAgo);
  const steps: Array<[boolean, string, string, string]> = [
    [ch.facebook, "Kết nối Facebook và Instagram", ch.facebook ? t("Đã kết nối") : t("Đăng nhập Facebook một lần"), ch.facebook ? "" : a.canConnect ? `<a class="btn on" href="/channels/hoi-sau">${esc(t("Kết nối"))}</a>` : ""],
    [s.comments.some((c) => Date.parse(c.createdAt) > dayAgo), "Đọc bình luận mới", t("{n} bình luận trong 24 giờ", { n: s.comments.filter((c) => Date.parse(c.createdAt) > dayAgo).length }), a.canPull ? button("/comments/refresh", esc(t("Lấy mới"))) : `<a class="btn" href="/comments">${esc(t("Xem"))}</a>`],
    [picked.size > 0, "Chọn ý cho tập sau", t("{n} ý đã chọn", { n: picked.size }), `<a class="btn${picked.size ? "" : " on"}" href="/comments">${esc(t("Chọn ý"))}</a>`],
    [madeToday && picked.size > 0, "Làm tập trong Studio", t("Viết, vẽ, tự soát, ghép chữ"), `<a class="btn${picked.size ? " on" : ""}" href="/studio">${esc(t("Mở Studio"))}</a>`],
    [postedToday, "Đăng tập", postedToday ? t("Đã đăng hôm nay") : t("Chưa đăng hôm nay"), `<a class="btn" href="/automation">${esc(t("Xem lịch"))}</a>`],
    [waiting === 0, "Trả lời tin nhắn", waiting ? t("{n} người đang chờ", { n: waiting }) : t("Không ai đang chờ"), waiting ? `<a class="btn on" href="/inbox">${esc(t("Trả lời"))}</a>` : ""],
  ];
  const done = steps.filter(([ok]) => ok).length;
  return `<section class="card today"><div class="card-head"><h2>${esc(t("Việc hôm nay"))}</h2><span class="progress" style="--p:${Math.round((done / steps.length) * 100)}%"><b>${done}/${steps.length}</b></span></div>
<ol class="todo-list">${steps.map(([ok, title, hint, action], i) => `<li class="${ok ? "done" : ""}"><span class="tick">${ok ? "✓" : i + 1}</span><div><b>${esc(t(title))}</b><small>${esc(hint)}</small></div>${action}</li>`).join("")}</ol></section>`;
}

export function overviewPage(s: State, ch: ChannelStatus, a: Abilities = { canPull: false, canConnect: false, studio: false }, ok?: string, err?: string): string {
  const published = s.episodes.filter((e) => e.state === "published");
  const stuck = s.episodes.filter((e) => e.state === "publishing");
  const picked = new Set(s.directions.map((d) => d.commentId));
  const dayAgo = Date.now() - 24 * 3600_000;
  const fresh = s.comments.filter((c) => Date.parse(c.createdAt) > dayAgo).length;

  // Newest published episode that Studio has pages for, else the newest Studio episode.
  const latestId = published.find((e) => s.comics.get(e.episodeId)?.pages.length)?.episodeId ?? [...s.comics.values()].pop()?.id;
  const latest = latestId ? s.comics.get(latestId) : undefined;
  const latestPosts = published.filter((e) => e.episodeId === latestId);
  const latestComments = s.comments.filter((c) => s.byPost.get(c.postId)?.episodeId === latestId).length;
  const hero = latest
    ? `<section class="card hero-comic"><div class="hero-meta"><span class="tag due">${esc(t("Tập mới nhất"))}</span><h2>${esc(latest.title)}</h2>${latest.logline ? `<p class="muted">${esc(latest.logline)}</p>` : ""}
<div class="faces">${[...new Set([latest.lead, ...latest.characters])].map((slug) => face(s, slug)).join("")}</div>
<div class="hero-tags">${latestPosts.map((e) => (e.permalink ? `<a class="tag ${e.platform}" href="${esc(e.permalink)}" target="_blank" rel="noopener">${esc(platformName(e.platform))} ↗</a>` : `<span class="tag ${e.platform}">${esc(platformName(e.platform))}</span>`)).join("")}</div>
<p class="muted small">${esc(t("{n} bình luận", { n: latestComments }))} · <a href="/studio/${esc(latest.id)}">${esc(t("mở trong Studio"))}</a></p></div>
<a class="strip" href="/studio/${esc(latest.id)}">${latest.reel ? `<video src="${esc(latest.reel)}" muted loop playsinline autoplay poster="${esc(latest.cover ?? "")}"></video>` : ""}${latest.pages.map((p, i) => `<img src="${esc(p)}" alt="${esc(t("Khung {n}", { n: i + 1 }))}" loading="lazy">`).join("")}</a></section>`
    : `<section class="card hero-empty"><div><h2>${esc(t("Chưa có tập nào"))}</h2><p class="muted">${esc(t("Tạo tập đầu tiên trong Studio: chọn nhân vật, viết một câu hướng truyện, AI làm phần còn lại."))}</p></div><a class="btn on" href="/studio">${esc(t("Mở Studio"))}</a></section>`;

  const max = Math.max(1, ...s.characters.map((x) => x.comments));
  const cast =
    s.characters
      .map(
        (c) => `<a class="cast-card" href="/characters/${esc(c.profile.slug)}"><img src="${charSrc(c)}" alt="" style="background:${esc(c.profile.look.palette[0].hex)}44" loading="lazy"><b>${esc(c.profile.name)}</b>
<span class="bar"><i style="width:${Math.round((c.comments / max) * 100)}%;background:${esc(c.profile.look.palette[0].hex)}"></i></span><small class="muted">${esc(t("{c} bình luận · {e} tập", { c: c.comments, e: c.episodes }))}</small></a>`,
      )
      .join("") + `<a class="cast-card add" href="/characters/new"><span class="plus">+</span><b>${esc(t("Thêm nhân vật"))}</b></a>`;

  const body = `<header class="page-head"><div><h1>${esc(t("Tổng quan"))}</h1></div>
<div class="minis">${mini(t("Tập"), new Set(published.map((e) => e.episodeId)).size, "", "/episodes")}${mini(t("Bình luận"), s.comments.length, fresh ? t("+{n} hôm nay", { n: fresh }) : "", "/comments")}${mini(t("Ngày đăng liên tiếp"), s.streak)}${mini(t("Ý đã chọn"), picked.size, "", "/comments?picked=1")}${mini(t("Tin chờ"), s.inbox.filter((c) => canReply(c) && c.messages[c.messages.length - 1]?.from === "customer").length, "", "/inbox")}</div></header>
${flash(ok, err)}
${stuck.length ? `<div class="warn"><b>${esc(t("{n} bài đang đăng dở.", { n: stuck.length }))}</b> ${esc(t("Có thể đã lên trang: mở trang kiểm tra trước khi đăng lại."))} ${stuck.map((e) => `<span class="tag ${e.platform}">${esc(episodeName(s, e.episodeId))} · ${esc(platformName(e.platform))}</span>`).join(" ")}</div>` : ""}
<div class="overview">
<div class="ov-main">${hero}<section class="cast">${cast}</section></div>
<div class="ov-side">${todayCard(s, ch, a)}${lastRun(s.runs[0])}</div>
</div>
<div class="grid2">
${s.brands.length ? brandsCard(s, ch) : `<section class="card"><h2>${esc(t("Kênh"))}</h2><ul class="channels"><li><span class="dot ${ch.facebook ? "ok" : "off"}"></span>Facebook<span class="muted">${esc(t(ch.facebook ? "đã kết nối" : "chưa kết nối"))}</span></li><li><span class="dot ${ch.instagram ? "ok" : "off"}"></span>Instagram<span class="muted">${esc(t(ch.instagram ? "đã kết nối" : "chưa kết nối"))}</span></li></ul></section>`}
${lessonsCard(s)}
</div>
<section class="card"><div class="card-head"><h2>${esc(t("Bình luận mới nhất"))}</h2><div class="actions">${pullComments(a)}<a href="/comments">${esc(t("Xem tất cả"))} →</a></div></div>
${s.comments.length ? `<ul class="comments">${s.comments.slice(0, 5).map((c) => commentRow(c, s, picked)).join("")}</ul>` : empty("Chưa có bình luận.", pullComments(a) || connectLink(a))}</section>`;
  return layout(t("Tổng quan"), "/", body);
}

const RUN_STATUS: Record<Run["status"], [string, string]> = {
  running: ["warn", "Đang chạy"],
  done: ["ok", "Xong"],
  partial: ["warn", "Xong một phần"],
  failed: ["bad", "Lỗi"],
};
const STAGE: Record<string, string> = { listen: "Đọc bình luận", direction: "Chọn hướng", studio: "Studio", motion: "Motion comic", package: "Đóng gói", upload: "Tải lên", publish: "Đăng bài" };
const stageName = (n: string) => (STAGE[n] ? t(STAGE[n]) : n);

const LESSON: Record<string, [string, string]> = { do: ["ok", "Nên"], avoid: ["bad", "Tránh"], test: ["warn", "Thử"] };

/** What the story coach learned from published episodes; the writer reads the same list. */
function lessonsCard(s: State): string {
  if (!s.lessons.length) return "";
  const rows = s.lessons
    .map((l) => {
      const [cls, label] = LESSON[l.kind] ?? ["off", l.kind];
      return `<li><span class="lesson ${cls}">${esc(t(label))}</span><span>${esc(l.text)}${l.evidence.length ? ` <span class="muted small">(${l.evidence.map((e) => esc(episodeName(s, e))).join(", ")})</span>` : ""}</span></li>`;
    })
    .join("");
  return `<section class="card"><div class="card-head"><h2>${esc(t("Bài học từ khán giả"))}</h2>${s.lessonsAt ? `<span class="muted small">${time(s.lessonsAt)}</span>` : ""}</div><ul class="lessons">${rows}</ul><p class="muted small">${esc(t("Rút ra từ số liệu các tập đã đăng. AI viết kịch bản đọc đúng danh sách này."))}</p></section>`;
}

function lastRun(r?: Run): string {
  if (!r) return "";
  const [cls, label] = RUN_STATUS[r.status];
  return `<a class="card run-card" href="/automation"><div class="card-head"><h2>${esc(t("Lần chạy tự động gần nhất"))}</h2><span><span class="dot ${cls}"></span>${esc(t(label))}</span></div>
<p class="muted small">${esc(r.date)} · ${time(r.startedAt)}${r.mode === "mock" ? ` · ${esc(t("chạy thử"))}` : ""}</p>${stageChips(r)}</a>`;
}

const stageChips = (r: Run) =>
  `<ol class="stages">${r.stages.map((g) => `<li class="${esc(g.status)}" title="${esc(g.error ?? g.note ?? "")}">${esc(stageName(g.name))}</li>`).join("")}</ol>`;

export function automationPage(s: State, studio: boolean): string {
  const rows = s.runs
    .map((r) => {
      const [cls, label] = RUN_STATUS[r.status];
      const ep = r.episodeId ? (studio ? `<a href="/studio/${esc(r.episodeId)}">${esc(episodeName(s, r.episodeId))}</a>` : esc(episodeName(s, r.episodeId))) : "–";
      const posts = r.posts.length
        ? `<ul class="posts">${r.posts
            .map(
              (p) =>
                `<li><span class="tag ${esc(p.platform)}">${esc(platformName(p.platform))}</span> ${esc(formatName(p.format))} · ${
                  p.status === "published" ? (p.permalink ? `<a href="${esc(p.permalink)}" target="_blank" rel="noopener">${esc(t("đã đăng"))} ↗</a>` : esc(t("đã đăng"))) : p.status === "failed" ? `<span class="bad-text">${esc(t("lỗi"))}: ${esc(p.error ?? "")}</span>` : `<span class="muted">${esc(t("bỏ qua"))}</span>`
                }</li>`,
            )
            .join("")}</ul>`
        : "";
      const notes = r.stages.filter((g) => g.error || g.note).map((g) => `<li><b>${esc(stageName(g.name))}:</b> ${esc(g.error ?? g.note)}</li>`).join("");
      return `<section class="card run"><div class="card-head"><h2>${esc(r.date)} ${r.mode === "mock" ? `<span class="tag">${esc(t("chạy thử"))}</span>` : ""}</h2><span><span class="dot ${cls}"></span>${esc(t(label))}</span></div>
<div class="run-body">${r.cover && studio ? `<a href="/studio-media/${r.cover.split("/").map(encodeURIComponent).join("/")}" class="cover"><img src="/studio-media/${r.cover.split("/").map(encodeURIComponent).join("/")}" alt="${esc(t("Ảnh bìa"))}" loading="lazy"></a>` : ""}
<div><p class="muted small">${esc(t("Tập"))} ${ep} · ${esc(t("bắt đầu"))} ${time(r.startedAt)}${r.finishedAt ? ` · ${esc(t("xong"))} ${time(r.finishedAt)}` : ""}</p>${stageChips(r)}
${r.direction ? `<p><b>${esc(t("Hướng truyện"))}</b>: ${esc(r.direction.text)}</p>${r.direction.credits.length ? `<p class="muted small">${esc(t("Ghi công"))}: ${r.direction.credits.map((c) => esc(c.name)).join(", ")}</p>` : ""}` : ""}
${posts}${notes ? `<ul class="notes small">${notes}</ul>` : ""}${r.error ? `<div class="warn small">${esc(r.error)}</div>` : ""}</div></div></section>`;
    })
    .join("");
  const flow = `<ol class="flow">${["listen", "direction", "studio", "motion", "publish"].map((n, i) => `<li><b>${i + 1}</b>${esc(stageName(n))}</li>`).join("")}</ol>`;
  const body = `<header class="page-head"><div><h1>${esc(t("Tự động"))}</h1><p class="muted">${esc(t("Mỗi sáng hệ thống tự làm một tập từ bình luận và đăng lên các kênh đang bật."))}</p></div>${flow}</header>
${rows || empty("Chưa có lần chạy tự động nào. Trong lúc chờ, bạn có thể làm tập bằng tay trong Studio.", studio ? `<a class="btn on" href="/studio">${esc(t("Mở Studio"))}</a>` : "")}${s.runs.some((r) => r.status === "running") ? '<meta http-equiv="refresh" content="5">' : ""}`;
  return layout(t("Tự động"), "/automation", body);
}

/** An empty state: what is missing, and the button that fills it. `action` is HTML. */
export function empty(text: string, action = ""): string {
  return `<div class="empty"><p>${esc(t(text))}</p>${action}</div>`;
}

export function charactersPage(s: State, ok?: string): string {
  const cards = s.characters
    .map(
      (c) => `<a class="card char" href="/characters/${esc(c.profile.slug)}">${sheetImg(c)}<div class="char-body"><h2>${esc(c.profile.name)} <span class="muted">${esc(c.profile.species)}</span></h2>
<p class="type">${esc(c.profile.office_type)}</p><p>${esc(c.profile.core_gag)}</p>${swatches(c)}<p class="muted small">${esc(t("{e} tập · {c} bình luận", { e: c.episodes, c: c.comments }))}${c.profile.look.character_sheet ? ` · <span class="ok-text">✓ ${esc(t("đã khoá sheet"))}</span>` : ""}</p></div></a>`,
    )
    .join("");
  const add = `<a class="card char add-card" href="/characters/new"><span class="plus">+</span><b>${esc(t("Tạo nhân vật mới"))}</b><small class="muted">${esc(t("AI viết hồ sơ từ một câu, hoặc tự điền"))}</small></a>`;
  return layout(
    t("Nhân vật"),
    "/characters",
    `<header class="page-head"><div><h1>${esc(t("Nhân vật"))}</h1><p class="muted">${esc(t("Các nhân vật chạy cùng kịch bản; nhân vật nào được khán giả thích nhất sẽ thành kênh chính."))}</p></div><a class="btn on" href="/characters/new">+ ${esc(t("Tạo nhân vật"))}</a></header>${flash(ok)}<div class="chars">${cards}${add}</div>`,
  );
}

export interface SheetControls {
  /** The dashboard can start a Muse Image run (Studio is wired up). */
  canDraw: boolean;
  /** Step of a running sheet job, if one is running. */
  drawing?: string;
  error?: string;
  ok?: string;
  /** More cards for the page, e.g. notes pinned from Tư liệu. */
  extra?: string;
}

const SHOT: Record<string, string> = { sheet: "Model sheet", poses: "Bộ tư thế", desk: "Thử: bàn làm việc", meeting: "Thử: phòng họp", gag: "Thử: miếng hài" };

export function characterPage(c: CharacterView, draw?: SheetControls): string {
  const p = c.profile;
  const list = (items: string[]) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
  const drawBtn = (primary: boolean) => button(`/characters/${p.slug}/sheet`, esc(t(c.run ? "Vẽ lại bằng AI" : "Vẽ model sheet bằng AI")), primary ? "btn on" : "btn");
  const images = c.run
    ? `<div class="shots">${c.run.images
        .map((i) => `<figure><img src="/media/${esc(p.slug)}/${esc(i.file)}" alt="${esc(t(SHOT[i.id] ?? i.id))}" loading="lazy"><figcaption>${esc(t(SHOT[i.id] ?? i.id))}</figcaption></figure>`)
        .join("")}</div><p class="muted small">${c.run.mock ? `${esc(t("Ảnh vẽ thử, không phải AI thật."))} ` : ""}${time(c.run.startedAt)} · <a href="/media/${esc(p.slug)}/review.html">${esc(t("trang soát nét nhận diện"))}</a></p>`
    : empty("Chưa vẽ lần nào. AI sẽ vẽ model sheet, 6 tư thế và 3 khung thử theo phong cách series.", draw?.canDraw && !draw.drawing ? drawBtn(true) : "");
  const drawBar = !draw?.canDraw
    ? ""
    : draw.drawing
      ? `<div class="notice"><span class="spinner"></span><b>${esc(t("Đang vẽ"))}:</b> ${esc(draw.drawing)}</div><meta http-equiv="refresh" content="2">`
      : c.run
        ? drawBtn(false)
        : "";
  const body = `<p><a href="/characters">← ${esc(t("Nhân vật"))}</a></p><header class="page-head"><div class="b-top"><img class="b-ava big" src="${charSrc(c)}" alt="" style="background:${esc(p.look.palette[0].hex)}44"><div><h1>${esc(p.name)}</h1><p class="muted">${esc(p.species)} · ${esc(p.role)}</p>${swatches(c)}</div></div><a class="btn on" href="/characters/${esc(p.slug)}/edit">✎ ${esc(t("Sửa hồ sơ"))}</a></header>
${flash(draw?.ok, draw?.error)}
${modelSheet(c)}
<section class="card"><div class="card-head"><h2>${esc(t("Thử độ nhất quán"))}</h2>${drawBar}</div>${images}</section>
${depth(c)}
${draw?.extra ?? ""}
<div class="grid2"><section class="card"><h2>${esc(t("Ngoại hình"))}</h2><p>${esc(p.look.description)}</p>${p.look.icon ? `<h3>${esc(t("Đồ nhận diện"))}</h3><p>${esc(p.look.icon)}</p>` : ""}<h3>${esc(t("Không được vẽ sai"))}</h3>${list(p.look.signature)}<h3>${esc(t("Biểu cảm"))}</h3>${list(Object.entries(p.look.expressions).map(([k, v]) => `${k}: ${v}`))}</section>
<section class="card"><h2>${esc(t("Tính cách và giọng"))}</h2>${list(p.personality)}<h3>${esc(t("Câu cửa miệng"))}</h3>${list(p.voice.catchphrases)}<h3>${esc(t("Không bao giờ nói"))}</h3>${list(p.never_says)}</section></div>`;
  return layout(p.name, "/characters", body);
}

/** Want, fear, contradiction, life, comic engine and relationships, when the profile has them. */
function depth(c: CharacterView): string {
  const p = c.profile;
  if (!p.want && !p.contradiction && !p.comic_engine?.length) return "";
  const list = (items: string[]) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
  const kv = [["Muốn", p.want], ["Sợ", p.fear], ["Mâu thuẫn", p.contradiction]].filter(([, v]) => v).map(([k, v]) => `<dt>${esc(t(k!))}</dt><dd>${esc(v)}</dd>`).join("");
  return `<div class="grid2"><section class="card"><h2>${esc(t("Con người"))}</h2>${kv ? `<dl class="kv">${kv}</dl>` : ""}${p.life?.length ? `<h3>${esc(t("Đời sống"))}</h3>${list(p.life)}` : ""}</section>
<section class="card"><h2>${esc(t("Tình huống gây cười"))}</h2>${list(p.comic_engine ?? [])}${p.relationships?.length ? `<h3>${esc(t("Quan hệ"))}</h3>${list(p.relationships.map((r) => r.dynamic))}` : ""}</section></div>`;
}

/** The locked sheet every panel is drawn against, or the button that locks the latest test sheet. */
function modelSheet(c: CharacterView): string {
  const p = c.profile;
  if (p.look.character_sheet)
    return `<section class="card"><div class="card-head"><h2>✓ ${esc(t("Model sheet đã khoá"))}</h2>${c.run ? button(`/characters/${p.slug}/approve`, esc(t("Khoá lại bằng bản vẽ mới"))) : ""}</div>
<div class="sheets"><img class="sheet" src="/sheet/${esc(p.slug)}/${esc(p.look.character_sheet)}" alt="Model sheet ${esc(p.name)}">${p.look.pose_sheet ? `<img class="sheet" src="/sheet/${esc(p.slug)}/${esc(p.look.pose_sheet)}" alt="${esc(t("Bộ tư thế"))} ${esc(p.name)}">` : ""}</div><p class="muted small">${esc(t("Mọi khung truyện đều vẽ theo bản này, và AI soát lại từng khung theo nó."))}</p></section>`;
  return c.run
    ? `<section class="card next-step"><div class="card-head"><h2>${esc(t("Bước tiếp: khoá model sheet"))}</h2>${button(`/characters/${p.slug}/approve`, esc(t("Khoá model sheet")), "btn on")}</div><p class="muted">${esc(t("Ưng bản vẽ bên dưới thì khoá lại: từ đó mọi khung truyện đều vẽ theo bản này."))}</p></section>`
    : "";
}

export function episodesPage(s: State): string {
  const rows = s.episodes
    .map((e: Episode) => {
      const n = s.comments.filter((c) => c.postId === e.postId).length;
      const st = s.stats.find((x) => x.episodeId === e.episodeId);
      return `<tr><td><b>${esc(episodeName(s, e.episodeId))}</b></td><td>${esc(s.characters.find((c) => c.profile.slug === e.character)?.profile.name ?? e.character)}</td><td>${brandLink(s, e.brand)}</td><td><span class="tag ${e.platform}">${PLATFORM[e.platform]}</span></td><td>${esc(formatName(e.format))}</td>
<td>${e.state === "published" ? `<span class="dot ok"></span>${esc(t("Đã đăng"))}` : `<span class="dot warn"></span>${esc(t("Đang đăng"))}`}</td><td>${time(e.at)}</td><td>${e.postId ? `<a href="/comments?episode=${esc(e.episodeId)}">${n}</a>` : "–"}</td><td title="${st ? esc(t("{a} người bình luận, {s} chia sẻ, {v} lưu", { a: st.authors, s: st.shares, v: st.saves })) : ""}">${st ? st.score : "–"}</td><td>${e.permalink ? `<a href="${esc(e.permalink)}" target="_blank" rel="noopener">${esc(t("Mở"))} ↗</a>` : ""}</td></tr>`;
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
      return `<article class="card ep-card"><a class="ep-cover" href="${comic ? `/studio/${esc(id)}` : `/comments?episode=${esc(id)}`}">${comic?.cover ? `<img src="${esc(comic.cover)}" alt="${esc(comic.title)}" loading="lazy">` : `<div class="ph">${face(s, posts[0].character, "lg")}</div>`}${st ? `<span class="score" title="${esc(t("Điểm tương tác"))}">${st.score}</span>` : ""}</a>
<div class="ep-body"><div class="faces">${cast.map((slug) => face(s, slug)).join("")}</div><h2>${esc(episodeName(s, id))}</h2>
<div class="hero-tags">${[...new Set(posts.map((e) => e.platform))].map((pl) => {
        const live = posts.filter((e) => e.platform === pl && e.state === "published");
        return live.length ? `<a class="tag ${pl}" href="${esc(live[0].permalink ?? "#")}" target="_blank" rel="noopener">${esc(platformName(pl))}${live.length > 1 ? ` ×${live.length}` : ""}</a>` : `<span class="tag over">${esc(platformName(pl))} ${esc(t("đang đăng"))}</span>`;
      }).join("")}</div>
${brands.length > 1 ? `<p class="muted small">${brands.map((b) => esc(brandName(s, b))).join(" · ")}</p>` : ""}
<p class="muted small"><a href="/comments?episode=${esc(id)}">💬 ${n}</a> · ${time(posts[posts.length - 1].at)}</p></div></article>`;
    })
    .join("");
  const body = `<header class="page-head"><div><h1>${esc(t("Tập đã đăng"))}</h1></div></header>
${s.episodes.length ? `<div class="ep-grid">${cards}</div>
<details class="card"><summary>${esc(t("Chi tiết từng bài"))}</summary><div class="scroll"><table><thead><tr><th>${esc(t("Tập"))}</th><th>${esc(t("Nhân vật"))}</th><th>${esc(t("Kênh"))}</th><th>${esc(t("Nền tảng"))}</th><th>${esc(t("Kiểu bài"))}</th><th>${esc(t("Trạng thái"))}</th><th>${esc(t("Thời gian"))}</th><th>${esc(t("Bình luận"))}</th><th title="${esc(t("Điểm tương tác của tập, sau 24 giờ"))}">${esc(t("Điểm"))}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></details>` : empty("Chưa đăng tập nào. Làm tập trong Studio, hệ thống tự động sẽ đăng lên các kênh đang bật.", `<a class="btn on" href="/studio">${esc(t("Mở Studio"))}</a>`)}`;
  return layout(t("Tập đã đăng"), "/episodes", body);
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

export function commentsPage(s: State, f: CommentFilter, a?: Abilities, ok?: string, err?: string): string {
  const picked = new Set(s.directions.map((d) => d.commentId));
  const list = filterComments(s, f);
  const episodes = [...new Set(s.episodes.filter((e) => e.postId).map((e) => e.episodeId))];
  const opt = (v: string, label: string, cur?: string) => `<option value="${esc(v)}"${v === (cur ?? "") ? " selected" : ""}>${esc(label)}</option>`;
  const body = `<header class="page-head"><div><h1>${esc(t("Bình luận"))}</h1><p class="muted">${esc(t("Chọn những ý hay làm hướng cho tập sau. Người viết ý được ghi tên trong tập."))}</p></div>${pullComments(a)}</header>
${flash(ok, err)}
<form class="filters" method="get" action="/comments"><input type="search" name="q" value="${esc(f.q)}" placeholder="${esc(t("Tìm trong bình luận hoặc tên người viết"))}">
<select name="platform">${opt("", t("Mọi nền tảng"), f.platform)}${opt("facebook", "Facebook", f.platform)}${opt("instagram", "Instagram", f.platform)}${opt("threads", "Threads", f.platform)}</select>
${s.brands.length > 1 ? `<select name="brand">${opt("", t("Mọi kênh"), f.brand)}${s.brands.map((b) => opt(b.brand.id, b.brand.name, f.brand)).join("")}</select>` : ""}
<select name="episode">${opt("", t("Mọi tập"), f.episode)}${episodes.map((e) => opt(e, episodeName(s, e), f.episode)).join("")}</select>
<label class="check"><input type="checkbox" name="picked" value="1"${f.picked ? " checked" : ""}> ${esc(t("Chỉ ý đã chọn"))}</label><button class="btn">${esc(t("Lọc"))}</button></form>
<p class="muted small">${esc(t("{a} / {b} bình luận · {c} ý đã chọn", { a: list.length, b: s.comments.length, c: picked.size }))}${picked.size ? ` · <a href="/studio">${esc(t("Làm tập từ các ý này"))} →</a>` : ""}</p>
<section class="card">${list.length ? `<ul class="comments">${list.map((c) => commentRow(c, s, picked)).join("")}</ul>` : empty(s.comments.length ? "Không có bình luận khớp bộ lọc." : "Chưa có bình luận.", s.comments.length ? "" : pullComments(a) || connectLink(a))}</section>`;
  return layout(t("Bình luận"), "/comments", body);
}

export function notFoundPage(): string {
  return layout(t("Không tìm thấy"), "", `<div class="empty big"><h1>${esc(t("Không tìm thấy trang"))}</h1><p><a class="btn on" href="/">${esc(t("Về tổng quan"))}</a></p></div>`);
}

function remaining(c: Conversation, now: Date): string {
  const closes = windowClosesAt(c);
  if (!closes) return t("Khách chưa nhắn");
  const ms = closes.getTime() - now.getTime();
  if (ms <= 0) return t("Quá 24 giờ");
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return h ? t("Còn {h} giờ {m} phút", { h, m }) : t("Còn {m} phút", { m });
}

const initial = (name: string) => esc(name.trim().charAt(0).toUpperCase() || "?");

export interface InboxView {
  selected?: string;
  error?: string;
  ok?: string;
  sent?: boolean;
  canPull: boolean;
  canConnect?: boolean;
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
<p>${last ? `${last.from === "page" ? `${esc(t("Bạn"))}: ` : ""}${esc(last.text || (last.attachments ? t("[Tệp đính kèm]") : ""))}` : ""}</p>
<div class="conv-tags"><span class="tag ${c.platform}">${PLATFORM[c.platform]}</span>${s.brands.length > 1 ? `<span class="tag">${esc(brandName(s, c.brand ?? "hoi-sau"))}</span>` : ""}${waiting && open ? `<span class="tag due">${esc(t("Chờ trả lời"))}</span>` : ""}${open ? "" : `<span class="tag closed">${esc(t("Quá 24 giờ"))}</span>`}</div></div></a>`;
    })
    .join("");

  const pull = v.canPull ? button("/inbox/refresh", `↻ ${esc(t("Lấy tin nhắn mới"))}`) : "";
  let thread = empty("Chưa có tin nhắn nào.", pull || (v.canConnect ? `<a class="btn on" href="/channels/hoi-sau">${esc(t("Kết nối Facebook"))}</a>` : ""));
  if (current) {
    const open = canReply(current, now);
    const bubbles = current.messages
      .map((m) => `<div class="msg ${m.from}"><div class="bubble">${esc(m.text)}${m.attachments ? `<span class="att">📎 ${esc(t("{n} tệp đính kèm", { n: m.attachments }))}</span>` : ""}</div><time>${time(m.createdAt)}</time></div>`)
      .join("");
    thread = `<header class="thread-head"><div class="avatar">${initial(current.customer.name)}</div><div><b>${esc(current.customer.name)}</b><span class="muted small"> · ${PLATFORM[current.platform]}</span></div>
<span class="window ${open ? "open" : "closed"}">${esc(remaining(current, now))}</span></header>
<div class="msgs" id="msgs">${bubbles}</div>
${v.error ? `<div class="warn small">${esc(v.error)}</div>` : ""}
${
  open
    ? `<form class="composer" method="post" action="/inbox/${encodeURIComponent(current.id)}/reply"><textarea name="text" rows="2" maxlength="2000" placeholder="${esc(t("Trả lời {name}…", { name: current.customer.name }))}" required></textarea><button class="btn on">${esc(t("Gửi"))}</button></form>`
    : `<p class="closed-note">${esc(t("Đã quá 24 giờ kể từ tin cuối của khách nên Meta không cho gửi tin thường. Khách nhắn lại thì cửa sổ mở lại."))}</p>`
}<script>var m=document.getElementById("msgs");if(m)m.scrollTop=m.scrollHeight;</script>`;
  }

  const waiting = s.inbox.filter((c) => canReply(c, now) && c.messages[c.messages.length - 1]?.from === "customer").length;
  const body = `<header class="page-head"><div><h1>${esc(t("Hộp thư"))}</h1><p class="muted">${esc(t("Tin nhắn Messenger và Instagram của các Trang. {n} hội thoại đang chờ trả lời.", { n: waiting }))}</p></div>${pull}</header>
${current ? "" : flash(v.ok, v.error)}${current && v.ok ? flash(v.ok) : ""}
<div class="inbox"><section class="card conv-list">${list || empty("Hộp thư trống.")}</section><section class="card thread">${thread}</section></div>`;
  return layout(t("Hộp thư"), "/inbox", body);
}

// Brands and channels: Hồi Sau is the main channel, each character a brand with its own accounts.

const STATUS: Record<string, [string, string]> = { live: ["ok", "Đang bật"], paused: ["warn", "Đang tạm dừng"], planned: ["off", "Chưa có tài khoản"] };
const brandName = (s: State, id: string) => s.brands.find((b) => b.brand.id === id)?.brand.name ?? id;
const brandLink = (s: State, id: string) => `<a href="/channels/${esc(id)}">${esc(brandName(s, id))}</a>`;

/** Connected and on, needs connecting, paused or not created yet. */
function channelDot(c: BrandView["channels"][number]): [string, string] {
  if (c.status === "live") return c.missing.length ? ["bad", "Chưa kết nối"] : ["ok", "Đang bật"];
  return STATUS[c.status];
}

const chips = (b: BrandView) =>
  `<ul class="ch-chips">${b.channels
    .map((c) => {
      const [cls, label] = channelDot(c);
      return `<li title="${esc(t(label))}"><span class="dot ${cls}"></span>${esc(platformName(c.platform))}</li>`;
    })
    .join("")}</ul>`;

function brandAvatar(b: BrandView): string {
  if (b.art?.avatar) return `<img class="b-ava" src="${esc(b.art.avatar)}" alt="">`;
  if (b.character) return `<img class="b-ava" src="${charSrc(b.character)}" alt="" style="background:${esc(b.character.profile.look.palette[0].hex)}44">`;
  return `<span class="b-ava${b.brand.kind === "series" ? " series" : ""}">${b.brand.kind === "series" ? "HS" : esc(b.brand.name.charAt(0))}</span>`;
}

const brandCounts = (b: BrandView) => `${t("{e} tập · {p} bài · {c} bình luận", { e: b.episodes, p: b.posts, c: b.comments })}${b.lastPostAt ? ` · ${t("đăng gần nhất {t}", { t: time(b.lastPostAt) })}` : ""}`;

function brandsCard(s: State, ch: ChannelStatus): string {
  const rows = s.brands
    .map((b) => {
      const live = b.channels.filter((c) => c.status === "live");
      const bad = live.filter((c) => c.missing.length).length;
      const note = !live.length ? t("tạm dừng") : bad ? t("{n} kênh chưa kết nối", { n: bad }) : t("{n} kênh đang bật", { n: live.length });
      return `<li title="${esc(note)}"><a href="/channels/${esc(b.brand.id)}">${brandAvatar(b)}<b>${esc(b.brand.name)}</b></a>${chips(b)}</li>`;
    })
    .join("");
  return `<section class="card"><div class="card-head"><h2>${esc(t("Kênh"))}</h2><a href="/channels">${esc(t("Quản lý"))} →</a></div><ul class="brand-list">${rows}</ul>
${ch.mock ? `<p class="muted small">${esc(t("Đang chạy thử: không đăng thật lên Facebook."))}</p>` : ""}</section>`;
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
<div class="b-cover" style="background:${esc(b.character?.profile.look.palette[0].hex ?? "#ccc")}55">${b.art?.cover ? `<img class="art" src="${esc(b.art.cover)}" alt="${esc(b.brand.name)}" loading="lazy">` : b.character ? `<img src="${charSrc(b.character)}" alt="${esc(b.brand.name)}" loading="lazy">` : ""}</div>
<div class="b-body"><h2>${esc(b.brand.name)}</h2><p class="muted small">${esc(b.brand.tagline ?? "")}</p>${chips(b)}${covers(b)}<p class="muted small">${esc(t("{e} tập · {c} bình luận", { e: b.episodes, c: b.comments }))}</p></div></a>`;
  const hero = main
    ? `<a class="card brand-hero" href="/channels/${esc(main.brand.id)}">${main.art?.cover ? `<img class="hero-cover" src="${esc(main.art.cover)}" alt="" loading="lazy">` : ""}<div class="b-top">${brandAvatar(main)}<div><h2>${esc(main.brand.name)} <span class="tag">${esc(t("kênh tổng"))}</span></h2><p class="muted">${esc(main.brand.tagline ?? "")}</p></div>
<div class="faces big">${s.characters.map((c) => face(s, c.profile.slug, "lg")).join("")}</div></div>
${covers(main)}<div class="hero-row">${chips(main)}<span class="muted small">${esc(brandCounts(main))}</span></div></a>`
    : "";
  const legend = `<p class="legend muted small"><span><span class="dot ok"></span>${esc(t("Đang bật"))}</span><span><span class="dot bad"></span>${esc(t("Chưa kết nối"))}</span><span><span class="dot warn"></span>${esc(t("Đang tạm dừng"))}</span><span><span class="dot off"></span>${esc(t("Chưa có tài khoản"))}</span></p>`;
  const body = `<header class="page-head"><div><h1>${esc(t("Kênh"))}</h1><p class="muted">${esc(t("Hồi Sau là kênh tổng; mỗi nhân vật có thể có kênh riêng. Bấm vào một kênh để kết nối hoặc bật, tắt."))}</p></div>${legend}</header>
${s.brands.length ? `${hero}<h2 class="section-title">${esc(t("Kênh nhân vật"))}</h2><div class="brands">${chars.map(card).join("")}</div>` : empty("Chưa có kênh nào.")}`;
  return layout(t("Kênh"), "/channels", body);
}

export interface BrandControls {
  /** Accounts can be connected and statuses changed from here. */
  canConnect: boolean;
  /** Settings needed before Facebook Login works. */
  needsAppKeys: boolean;
  /** Studio can draw the page's profile picture and cover. */
  canDrawArt: boolean;
  drawingArt?: string;
  ok?: string;
  error?: string;
  /** Several Pages came back from login: pick one. */
  choose?: { id: string; pages: Array<{ id: string; name: string; instagram?: string }> };
}

const PLATFORM_ICON: Record<string, string> = { facebook: "f", instagram: "◎", threads: "@" };

export function brandPage(s: State, id: string, ctl: BrandControls = { canConnect: false, needsAppKeys: false, canDrawArt: false }): string | undefined {
  const b = s.brands.find((x) => x.brand.id === id);
  if (!b) return undefined;
  const fbConnected = !b.channels.find((c) => c.platform === "facebook")?.missing.length;
  const rows = b.channels
    .map((c) => {
      const [cls, label] = channelDot(c);
      const connected = !c.missing.length;
      const toggle = !ctl.canConnect || c.status === "planned" ? "" : button(`/channels/${b.brand.id}/${c.platform}/status`, esc(t(c.status === "live" ? "Tạm dừng" : "Bật lại")), "btn ghost", { status: c.status === "live" ? "paused" : "live" });
      let action = "";
      if (c.status === "planned") action = ctl.canConnect ? button(`/channels/${b.brand.id}/${c.platform}/status`, esc(t("Đã tạo tài khoản, bật kênh")), "btn", { status: "paused" }) : "";
      else if (!ctl.canConnect) action = "";
      else if (c.platform === "threads")
        action = `<details class="threads-connect"><summary class="btn${connected ? "" : " on"}">${esc(t(connected ? "Kết nối lại" : "Kết nối Threads"))}</summary><form method="post" action="/channels/${esc(b.brand.id)}/threads"><ol class="howto small"><li>${t('Mở <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener">ứng dụng Threads</a> → Dùng thử → Tạo mã người dùng.')}</li><li>${esc(t("Bấm Sao chép cạnh mã, dán vào ô dưới."))}</li></ol><input name="token" placeholder="${esc(t("Dán mã Threads"))}" required autocomplete="off"><button class="btn on">${esc(t("Lưu"))}</button></form></details>`;
      else if (c.platform === "instagram") action = fbConnected ? (connected ? `<span class="muted small">${esc(t("Đi kèm Trang Facebook"))}</span>` : `<span class="muted small">${esc(t("Liên kết Instagram với Trang trong ứng dụng Instagram, rồi kết nối Facebook lại."))}</span>`) : `<span class="muted small">${esc(t("Kết nối Facebook trước"))}</span>`;
      else action = `<a class="btn${connected ? "" : " on"}" href="/connect/facebook?brand=${esc(b.brand.id)}">${esc(t(connected ? "Kết nối lại" : "Kết nối Facebook"))}</a>`;
      return `<li class="acct ${c.platform}"><span class="p-ico">${PLATFORM_ICON[c.platform] ?? ""}</span><div class="acct-name"><b>${esc(platformName(c.platform))}</b><span><span class="dot ${cls}"></span>${esc(t(label))}</span></div><div class="acct-actions">${action}${toggle}</div></li>`;
    })
    .join("");
  const eps = s.episodes.filter((e) => e.brand === b.brand.id);
  const posts = eps
    .slice(0, 12)
    .map((e) => `<tr><td><b>${esc(episodeName(s, e.episodeId))}</b></td><td><span class="tag ${e.platform}">${esc(platformName(e.platform))}</span></td><td>${esc(formatName(e.format))}</td><td>${e.state === "published" ? `<span class="dot ok"></span>${esc(t("Đã đăng"))}` : `<span class="dot warn"></span>${esc(t("Đang đăng"))}`}</td><td>${time(e.at)}</td><td>${e.permalink ? `<a href="${esc(e.permalink)}" target="_blank" rel="noopener">${esc(t("Mở"))} ↗</a>` : ""}</td></tr>`)
    .join("");
  const picked = new Set(s.directions.map((d) => d.commentId));
  const comments = filterComments(s, { brand: b.brand.id });
  const who = b.character?.profile.name ?? b.brand.name;
  const route = b.brand.posts === "all" ? t("Nhận mọi tập.") : b.brand.posts === "lead" ? t("Nhận các tập {name} đóng chính.", { name: who }) : t("Nhận các tập có {name}.", { name: who });
  const choose = ctl.choose
    ? `<section class="card next-step"><h2>${esc(t("Chọn Trang cho {name}", { name: b.brand.name }))}</h2><div class="page-pick">${ctl.choose.pages
        .map((p) => button("/connect/facebook/choose", `<b>${esc(p.name)}</b>${p.instagram ? `<small>Instagram @${esc(p.instagram)}</small>` : ""}`, "btn page-btn", { choice: ctl.choose!.id, page: p.id }))
        .join("")}</div></section>`
    : "";
  const art = b.art?.cover
    ? `<img class="brand-cover" src="${esc(b.art.cover)}" alt="${esc(t("Ảnh bìa"))}">`
    : "";
  const artBar = !ctl.canDrawArt
    ? ""
    : ctl.drawingArt
      ? `<div class="notice"><span class="spinner"></span><b>${esc(t("Đang vẽ ảnh đại diện và ảnh bìa"))}:</b> ${esc(ctl.drawingArt)}</div><meta http-equiv="refresh" content="2">`
      : button(`/channels/${b.brand.id}/art`, esc(t(b.art?.cover ? "Vẽ lại ảnh bìa" : "Vẽ ảnh đại diện và ảnh bìa")), b.art?.cover ? "btn" : "btn on");
  const body = `<p><a href="/channels">← ${esc(t("Kênh"))}</a></p>${art}<header class="page-head"><div class="b-top">${brandAvatar(b)}<div><h1>${esc(b.brand.name)}</h1><p class="muted">${esc(b.brand.tagline ?? "")}${b.character ? ` · <a href="/characters/${esc(b.character.profile.slug)}">${esc(t("hồ sơ nhân vật"))}</a>` : ""}</p></div></div>${artBar}</header>
${flash(ctl.ok, ctl.error)}
${ctl.canConnect && ctl.needsAppKeys && !fbConnected ? `<div class="notice">${esc(t("Để kết nối Facebook, cần nhập Mã ứng dụng Meta và Khoá bí mật một lần."))} <a class="btn on" href="/settings">${esc(t("Mở Cài đặt"))}</a></div>` : ""}
${choose}
<section class="stats">${stat(t("Tập đã đăng"), b.episodes, t("{n} bài", { n: b.posts }))}${stat(t("Bình luận"), b.comments)}${stat(t("Kênh đang bật"), b.channels.filter((c) => c.status === "live" && !c.missing.length).length, t("trên {n} kênh", { n: b.channels.length }))}</section>
<section class="card"><div class="card-head"><h2>${esc(t("Tài khoản"))}</h2><span class="muted small">${esc(route)}</span></div><ul class="accounts">${rows}</ul>
<p class="muted small">${esc(t("Mã truy cập được lưu trên máy này và không bao giờ hiện ra màn hình."))}</p></section>
<section class="card"><h2>${esc(t("Bài đã đăng"))}</h2>${posts ? `<div class="scroll"><table><thead><tr><th>${esc(t("Tập"))}</th><th>${esc(t("Nền tảng"))}</th><th>${esc(t("Kiểu bài"))}</th><th>${esc(t("Trạng thái"))}</th><th>${esc(t("Thời gian"))}</th><th></th></tr></thead><tbody>${posts}</tbody></table></div>` : empty("Kênh này chưa đăng bài nào.", `<a class="btn" href="/studio">${esc(t("Mở Studio"))}</a>`)}</section>
<section class="card"><div class="card-head"><h2>${esc(t("Bình luận"))}</h2>${comments.length ? `<a href="/comments?brand=${esc(b.brand.id)}">${esc(t("Xem tất cả"))} →</a>` : ""}</div>${comments.length ? `<ul class="comments">${comments.slice(0, 6).map((c) => commentRow(c, s, picked)).join("")}</ul>` : empty("Chưa có bình luận.")}</section>`;
  return layout(b.brand.name, "/channels", body);
}

export interface SettingView {
  name: string;
  label: string;
  help: string;
  secret: boolean;
  set: boolean;
}

export function settingsPage(settings: SettingView[], opts: { demo: boolean; mock: boolean; ok?: string; error?: string }): string {
  const rows = settings
    .map(
      (s) => `<label class="setting"><span class="s-head"><b>${esc(t(s.label))}</b><span class="pill ${s.set ? "ok" : "off"}">${esc(t(s.set ? "Đã có" : "Chưa có"))}</span></span><small class="muted">${esc(t(s.help))}</small>
<input name="${esc(s.name)}" type="${s.secret ? "password" : "text"}" autocomplete="off" placeholder="${esc(t(s.set ? "Để trống nếu không đổi" : "Dán vào đây"))}"${opts.demo ? " disabled" : ""}></label>`,
    )
    .join("");
  const body = `<header class="page-head"><div><h1>${esc(t("Cài đặt"))}</h1><p class="muted">${esc(t("Nhập một lần. Các khoá được lưu trên máy này, không hiện lại ra màn hình."))}</p></div></header>
${flash(opts.ok, opts.error)}
${opts.demo ? `<div class="notice">${esc(t("Đang xem dữ liệu mẫu nên không lưu cài đặt."))}</div>` : ""}
<div class="settings-grid"><form class="card form" method="post" action="/settings"><h2>${esc(t("Khoá kết nối"))}</h2>${rows}<button class="btn on"${opts.demo ? " disabled" : ""}>${esc(t("Lưu"))}</button></form>
<section class="card"><h2>${esc(t("Thứ tự thiết lập"))}</h2><ol class="flow vertical"><li><b>1</b><span>${esc(t("Nhập Mã ứng dụng Meta và Khoá bí mật"))}</span></li><li><b>2</b><span>${t('Vào <a href="/channels">Kênh</a>, bấm Kết nối Facebook, chọn Trang')}</span></li><li><b>3</b><span>${esc(t("Nhập khoá AI Muse để AI viết và vẽ"))}</span></li><li><b>4</b><span>${t('Vào <a href="/style">Phong cách</a> chọn kiểu vẽ, rồi vẽ model sheet cho nhân vật')}</span></li></ol>
${opts.mock ? `<p class="muted small">${esc(t("AI đang ở chế độ vẽ thử: ảnh là mẫu, không tốn lượt."))}</p>` : ""}</section></div>`;
  return layout(t("Cài đặt"), "/settings", body);
}

export function loginPage(error?: string): string {
  return `<!doctype html><html lang="${lang()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t("Đăng nhập")} · Hồi Sau</title><link rel="stylesheet" href="/static/app.css"></head>
<body><main class="login"><h1>Hồi Sau</h1><p class="muted">Studio dashboard</p>
${error ? `<div class="warn small">${esc(error)}</div>` : ""}
<form method="post" action="/login"><input type="password" name="password" placeholder="${t("Mật khẩu")}" autocomplete="current-password" required autofocus><button class="btn on">${t("Vào")}</button></form></main></body></html>`;
}
