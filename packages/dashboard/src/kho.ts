/**
 * Kho ý: a big batch of posts scraped from another page (JSON, one object per post)
 * turned into a production queue for short text memes. Videos (somebody else's
 * footage) are left out; pictures and text posts are kept, ranked by how much
 * people reacted, shared and commented, and spread over the days ahead, a few a
 * day, with no two of the same topic on one day. Dated posts (20/10, Tết...) wait
 * for their date.
 *
 * Each item becomes a drop-in of the "Làm từ chữ hoặc ảnh" box (data/video/_ideas/
 * y-<id>/): the pictures are downloaded while their links still work, then Muse
 * Spark reads the words exactly and proposes a two-beat meme with our cast in our
 * office (`talk idea --kind meme`). Nothing is made until the owner opens the
 * proposal and presses the button, and no caption names the page.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "./i18n.js";
import { MEME_MUSIC, type Videos } from "./video.js";
import { esc, flash, layout } from "./views.js";

/** One post as the scraper writes it. */
export interface ScrapedPost {
  source_id: string;
  item_type?: string;
  content?: string;
  item_timestamp?: string;
  url?: string;
  reactions_count?: number;
  share_count?: number;
  comment_count?: number;
  attachments_detail?: Array<{ type?: string; url?: string }> | null;
}

export interface StockItem {
  /** k-0001…; its drop-in folder is y-<id>. */
  id: string;
  sourceId: string;
  kind: "image" | "text";
  date: string;
  reactions: number;
  shares: number;
  comments: number;
  score: number;
  caption: string;
  topic: string;
  post: string;
  images: string[];
  /** The day to make it (Hanoi date), and its turn that day. */
  makeOn: string;
  slot: number;
  /** A dated post: kept for its day. */
  season?: string;
  skip?: boolean;
  /** Why the pictures did not download. */
  error?: string;
  /** The text clip made from it (data/video/<id>). */
  video?: string;
}

export interface Stock {
  perDay: number;
  items: StockItem[];
}

/** Not for an office comedy channel: politics, the page talking about itself, ads, death, crude words, real people. */
const OFF = /hoàng sa|trường sa|chính trị|biểu tình|block|kick|admin|fanpage|\bpage\b|thông báo|content|follow|inbox|giveaway|minigame|livestream|\blink\b|shopee|sex|địt|lồn|buồi|cặc|chịch|sao kê|ung thư|qua đời|tai nạn|vụ án|tử vong|\brip\b|chia buồn/i;

export const TOPICS: Array<[string, string, RegExp]> = [
  ["luong", "Lương, tiền", /lương|tiền|\b\d+\s?(tr|triệu|k)\b|nghèo|giàu|tiết kiệm|thuế|nợ|phong bì|xăng|chi tiêu|hết tháng/],
  ["sep", "Sếp", /sếp|giám đốc|boss|leader|quản lý/],
  ["xinviec", "Xin việc, nghỉ việc", /nghỉ việc|thất nghiệp|xin việc|apply|phỏng vấn|tuyển|\bcv\b|kinh nghiệm|\bhr\b|nhảy việc|thử việc/],
  ["viec", "Việc, họp, deadline", /tăng ca|deadline|\bot\b|thêm việc|họp|báo cáo|task|kpi|dự án/],
  ["dongnghiep", "Đồng nghiệp", /đồng nghiệp|team|hướng nội|trở mặt|nhân viên mới/],
  ["gio", "Giờ giấc, thứ Hai", /thứ hai|thứ 2|thứ bảy|thứ 7|thứ ba|tan làm|đi muộn|ngủ|chấm công|cuối tuần|năng lượng/],
  ["le", "Lễ, phép, thưởng", /lễ|tết|phép|team building|du lịch|về quê|thưởng/],
  ["yeu", "Yêu, ế", /(^|\s)ế(\s|$)|người yêu|\bny\b|vợ|chồng|crush|độc thân|cưới/],
  ["an", "Ăn uống", /cơm|trà sữa|cà phê|cafe|bún|phở|bánh|nhậu|ăn trưa/],
];
export const topicLabel = (key: string) => TOPICS.find(([k]) => k === key)?.[1] ?? "Khác";
export const topicOf = (caption: string): string => TOPICS.find(([, , re]) => re.test(caption.toLowerCase()))?.[0] ?? "khac";

/** Dated posts: month-day of the occasion. Tết moves each year, so it is given per year. */
const SEASONS: Array<[string, RegExp, (y: number) => string]> = [
  ["20/10", /20\/10|20-10/, (y) => `${y}-10-20`],
  ["8/3", /8\/3|8-3|quốc tế phụ nữ/, (y) => `${y}-03-08`],
  ["14/2", /14\/2|valentine/, (y) => `${y}-02-14`],
  ["Noel", /noel|giáng sinh/, (y) => `${y}-12-24`],
  ["Trung thu", /trung thu|bánh nướng|bánh dẻo|nhân thập cẩm/, (y) => ({ 2027: "2027-09-15", 2028: "2028-10-03" } as Record<number, string>)[y] ?? `${y}-09-20`],
  ["Tết", /\btết\b|thưởng tết|lì xì/, (y) => ({ 2027: "2027-02-06", 2028: "2028-01-26" } as Record<number, string>)[y] ?? `${y}-02-01`],
];

const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => day(new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000));

/** Dates of a dated post: a few days before the next occasion after `from`. */
function seasonDay(caption: string, from: string): { season: string; on: string } | undefined {
  const low = caption.toLowerCase();
  const hit = SEASONS.find(([, re]) => re.test(low));
  if (!hit) return undefined;
  const y = Number(from.slice(0, 4));
  const next = [y, y + 1].map(hit[2]).find((d) => addDays(d, -3) >= from)!;
  return { season: hit[0], on: addDays(next, -3) };
}

/** Two captions are the same post when their letters and digits match. */
export const captionKey = (caption: string) => caption.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** From scraped posts to new stock items (not yet given a day). Videos, off-topic posts and repeats are left out; `known` holds post ids and caption keys already in the stock. */
export function pickPosts(posts: ScrapedPost[], known = new Set<string>()): { items: Omit<StockItem, "id" | "makeOn" | "slot">[]; left: Record<string, number> } {
  const left: Record<string, number> = {};
  const drop = (why: string) => (left[why] = (left[why] ?? 0) + 1);
  const seen = new Set<string>();
  const items: Omit<StockItem, "id" | "makeOn" | "slot">[] = [];
  for (const p of posts) {
    const att = p.attachments_detail ?? [];
    const type = att[0]?.type ?? "none";
    const caption = (p.content ?? "").trim();
    const key = captionKey(caption);
    if (known.has(p.source_id) || (key && known.has(key))) {
      drop("đã có trong kho");
      continue;
    }
    if (!["photo", "album", "none"].includes(type)) {
      drop("video, clip của người khác");
      continue;
    }
    if (type === "none" && caption.length < 12) {
      drop("chữ quá ngắn");
      continue;
    }
    if (OFF.test(caption)) {
      drop("không hợp kênh");
      continue;
    }
    if (key && seen.has(key)) {
      drop("trùng");
      continue;
    }
    seen.add(key);
    const images = att.filter((a) => a.url && (a.type === "photo" || type === "album")).map((a) => a.url!).slice(0, 4);
    if (type !== "none" && !images.length) {
      drop("mất ảnh");
      continue;
    }
    const reactions = p.reactions_count ?? 0, shares = p.share_count ?? 0, comments = p.comment_count ?? 0;
    items.push({
      sourceId: p.source_id,
      kind: type === "none" ? "text" : "image",
      date: (p.item_timestamp ?? "").slice(0, 10),
      reactions,
      shares,
      comments,
      // A share or a comment says more than a like: people tag colleagues on the ones that hit.
      score: reactions + 5 * shares + 3 * comments,
      caption,
      topic: topicOf(caption),
      post: p.url ?? "",
      images,
    });
  }
  items.sort((a, b) => b.score - a.score);
  return { items, left };
}

/** Gives every item not yet read a day from `start`: best first, perDay a day, one topic per day when it can. Dated posts go before their date. */
export function planDays<T extends { score: number; topic: string; caption: string; makeOn?: string; slot?: number; season?: string }>(items: T[], start: string, perDay: number, keep: (i: T) => boolean = () => false): T[] {
  const taken = new Map<string, number>();
  const take = (d: string) => taken.set(d, (taken.get(d) ?? 0) + 1);
  for (const i of items) if (keep(i) && i.makeOn) take(i.makeOn);
  const queue: T[] = [];
  for (const i of items) {
    if (keep(i)) continue;
    const s = seasonDay(i.caption, start);
    if (s) {
      i.season = s.season;
      let d = s.on;
      while ((taken.get(d) ?? 0) >= perDay + 1) d = addDays(d, -1);
      i.makeOn = d;
      take(d);
      i.slot = taken.get(d)!;
    } else queue.push(i);
  }
  queue.sort((a, b) => b.score - a.score);
  // Topics already on a day (kept items, dated posts), so the day still gets a mix.
  const onDay = new Map<string, Set<string>>();
  for (const i of items) if (!queue.includes(i) && i.makeOn) (onDay.get(i.makeOn) ?? onDay.set(i.makeOn, new Set()).get(i.makeOn)!).add(i.topic);
  let d = start;
  while (queue.length) {
    const topics = onDay.get(d) ?? new Set<string>();
    while ((taken.get(d) ?? 0) < perDay && queue.length) {
      const at = queue.findIndex((i) => i.topic === "khac" || !topics.has(i.topic));
      const [i] = queue.splice(at >= 0 ? at : 0, 1);
      topics.add(i.topic);
      take(d);
      i.makeOn = d;
      i.slot = taken.get(d)!;
    }
    d = addDays(d, 1);
  }
  return items;
}

export type StockStatus = "skip" | "download" | "read" | "reading" | "ready" | "making" | "made" | "failed";
export const STATUS_LABEL: Record<StockStatus, string> = { skip: "Đã bỏ", download: "Chờ tải ảnh", read: "Chờ đọc", reading: "Đang đọc", ready: "Có đề xuất", making: "Đang làm clip", made: "Đã có clip", failed: "Lỗi" };

/** Hanoi date of today. */
export const hanoiToday = (now = new Date()) => day(new Date(now.getTime() + 7 * 3600000));

export class IdeaStock {
  readonly jobs = new Map<string, { running: boolean; step?: string; error?: string }>();
  constructor(
    readonly videos: Videos,
    get?: (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>,
  ) {
    this.get = get ?? ((url) => fetch(url));
  }
  private readonly get: (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

  private file = () => join(this.videos.ideasDir(), "kho.json");
  dirOf = (i: StockItem) => this.videos.ideaDir(`y-${i.id}`);

  load(): Stock {
    return existsSync(this.file()) ? (JSON.parse(readFileSync(this.file(), "utf8")) as Stock) : { perDay: 4, items: [] };
  }

  private save(s: Stock): void {
    mkdirSync(this.videos.ideasDir(), { recursive: true });
    writeFileSync(this.file(), `${JSON.stringify(s, null, 1)}\n`);
  }

  status(i: StockItem): StockStatus {
    if (i.skip) return "skip";
    if (i.video) return this.videos.jobs.get(i.video)?.running || this.jobs.get(`make:${i.id}`)?.running ? "making" : "made";
    if (this.jobs.get(`make:${i.id}`)?.running) return "making";
    const dir = this.dirOf(i);
    if (existsSync(join(dir, "idea.json"))) return "ready";
    if (this.jobs.get(`read:${i.id}`)?.running) return "reading";
    if (i.kind === "image" && !(existsSync(dir) && readdirSync(dir).some((f) => /^img-\d+\./.test(f)))) return i.error ? "failed" : "download";
    return this.jobs.get(`read:${i.id}`)?.error ? "failed" : "read";
  }

  /** Adds scraped posts; days are given again to everything not read yet. Returns how many were added and why the rest were left. */
  add(posts: ScrapedPost[], opts: { perDay?: number; start?: string } = {}): { added: number; left: Record<string, number> } {
    const s = this.load();
    if (opts.perDay) s.perDay = opts.perDay;
    const { items, left } = pickPosts(posts, new Set(s.items.flatMap((i) => [i.sourceId, captionKey(i.caption)]).filter(Boolean)));
    let n = s.items.reduce((m, i) => Math.max(m, Number(i.id.slice(2)) || 0), 0);
    for (const i of items) s.items.push({ ...i, id: `k-${String(++n).padStart(4, "0")}`, makeOn: "", slot: 0 });
    const start = opts.start ?? addDays(hanoiToday(), 1);
    // What is already read or dropped keeps its day; the rest is planned again around the new posts.
    planDays(s.items, start, s.perDay, (i) => i.skip === true || this.status(i) === "ready");
    s.items.sort((a, b) => a.makeOn.localeCompare(b.makeOn) || a.slot - b.slot);
    for (const i of s.items) this.writeInput(i);
    this.save(s);
    return { added: items.length, left };
  }

  private writeInput(i: StockItem): void {
    const dir = this.dirOf(i);
    mkdirSync(dir, { recursive: true });
    // A text post is the joke itself; a picture's caption is only a teaser, so the picture is read alone.
    if (!existsSync(join(dir, "input.txt"))) writeFileSync(join(dir, "input.txt"), i.kind === "text" ? i.caption : "");
  }

  setSkip(id: string, skip: boolean): void {
    const s = this.load();
    const i = s.items.find((x) => x.id === id);
    if (!i) throw new Error(t("Không thấy mục này."));
    i.skip = skip;
    this.save(s);
  }

  running = () => [...this.jobs.values()].some((j) => j.running);

  private background(key: string, work: (log: (s: string) => void) => Promise<void>): void {
    if (this.jobs.get(key)?.running) throw new Error(t("Việc này đang chạy."));
    const job: { running: boolean; step?: string; error?: string } = { running: true };
    this.jobs.set(key, job);
    void (async () => {
      try {
        await work((x) => (job.step = x));
      } catch (e) {
        job.error = e instanceof Error ? e.message : String(e);
      } finally {
        job.running = false;
      }
    })();
  }

  /** Downloads the pictures still missing, best first: the scraped links stop working after a few days. */
  download(): number {
    const todo = this.load().items.filter((i) => this.status(i) === "download" || (this.status(i) === "failed" && i.kind === "image"));
    if (!todo.length) return 0;
    this.background("download", async (log) => {
      for (const [n, i] of todo.entries()) {
        log(t("Tải ảnh {i}/{n}", { i: n + 1, n: todo.length }));
        let error: string | undefined;
        for (const [k, url] of i.images.entries()) {
          try {
            const res = await this.get(url);
            if (!res.ok) throw new Error(t("link hết hạn hoặc bị chặn ({status})", { status: res.status }));
            writeFileSync(join(this.dirOf(i), `img-${k + 1}.jpg`), Buffer.from(await res.arrayBuffer()));
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
        }
        const s = this.load();
        const it = s.items.find((x) => x.id === i.id);
        if (it) {
          it.error = existsSync(join(this.dirOf(i), "img-1.jpg")) ? undefined : error;
          this.save(s);
        }
      }
    });
    return todo.length;
  }

  /** Muse Spark reads the items of the next `days` days that are ready to read, a few at a time. */
  readDays(days: number, from = hanoiToday(), parallel = 4): number {
    const until = addDays(from, days - 1);
    const todo = this.load().items.filter((i) => i.makeOn <= until && this.status(i) === "read");
    const count = todo.length;
    if (!count) return 0;
    this.background("read", async (log) => {
      let done = 0;
      const next = async (): Promise<void> => {
        const i = todo.shift();
        if (!i) return;
        const key = `read:${i.id}`;
        this.jobs.set(key, { running: true });
        try {
          await this.videos.opts.exec("packages/talk/dist/cli.js", ["idea", "--out", this.dirOf(i), "--kind", "meme"], () => {});
          this.jobs.set(key, { running: false });
        } catch (e) {
          this.jobs.set(key, { running: false, error: e instanceof Error ? e.message : String(e) });
        }
        log(t("Đã đọc {i} mục", { i: ++done }));
        return next();
      };
      await Promise.all(Array.from({ length: parallel }, next));
    });
    return count;
  }

  /**
   * The week's batch in one go: every proposal of the next `days` days becomes a text clip
   * (planned, drawn, second poses, rendered), a few at a time, so the owner reviews the whole
   * week once on the Video screen. Nothing is approved or posted here.
   */
  makeDays(days: number, from = hanoiToday(), parallel = 3): number {
    const until = addDays(from, days - 1);
    const todo = this.load().items.filter((i) => i.makeOn >= from && i.makeOn <= until && this.status(i) === "ready");
    const count = todo.length;
    if (!count) return 0;
    const cast = new Set(this.videos.opts.cast().map((c) => c.slug));
    this.background("make", async (log) => {
      let done = 0;
      const next = async (): Promise<void> => {
        const i = todo.shift();
        if (!i) return;
        const key = `make:${i.id}`;
        this.jobs.set(key, { running: true });
        try {
          const plan = JSON.parse(readFileSync(join(this.dirOf(i), "idea.json"), "utf8")) as { lead: string; title: string; caption?: string; meme: { top: string; punch: string; scenes: string[] } };
          const slug = cast.has(plan.lead) ? plan.lead : cast.has("cu-li") ? "cu-li" : [...cast][0];
          const id = this.videos.create({ kind: "meme", slug, mouth: false, title: plan.title, meme: { top: plan.meme.top, punch: plan.meme.punch, scenes: plan.meme.scenes, music: MEME_MUSIC, seconds: 0, ...(i.season ? { season: i.season } : {}) }, caption: plan.caption });
          const s = this.load();
          const it = s.items.find((x) => x.id === i.id);
          if (it) {
            it.video = id;
            this.save(s);
          }
          await this.videos.settle(id);
          const drawn = this.videos.jobs.get(id)?.error;
          if (drawn) throw new Error(drawn);
          this.videos.render(id);
          await this.videos.settle(id);
          const rendered = this.videos.jobs.get(id)?.error;
          this.jobs.set(key, { running: false, ...(rendered ? { error: rendered } : {}) });
        } catch (e) {
          this.jobs.set(key, { running: false, error: e instanceof Error ? e.message : String(e) });
        }
        log(t("Đã làm {i}/{n} clip", { i: ++done, n: count }));
        return next();
      };
      await Promise.all(Array.from({ length: Math.min(parallel, count) }, next));
    });
    return count;
  }

  /** Waits for the background runs; for tests. */
  async settle(): Promise<void> {
    while (this.running()) await new Promise((r) => setTimeout(r, 20));
  }
}

/** The queue, a day at a time: what is planned, its numbers, and where each one stands. */
export function stockPage(k: IdeaStock, view: { all?: boolean; err?: string; ok?: string } = {}): string {
  const s = k.load();
  const items = s.items;
  const today = hanoiToday();
  const counts = new Map<StockStatus, number>();
  for (const i of items) counts.set(k.status(i), (counts.get(k.status(i)) ?? 0) + 1);
  const chips = (Object.keys(STATUS_LABEL) as StockStatus[]).filter((x) => counts.get(x)).map((x) => `<span class="chip">${esc(t(STATUS_LABEL[x]))} <b>${counts.get(x)}</b></span>`).join(" ");
  const jobs = ["download", "read", "make"].map((key) => k.jobs.get(key)).filter((j) => j?.running).map((j) => `<p class="small"><span class="spinner"></span> ${esc(j!.step ?? "")}</p>`).join("");
  const shown = items.filter((i) => view.all || (i.makeOn >= today && i.makeOn <= addDays(today, 13)) || (i.makeOn < today && k.status(i) !== "skip"));
  const days = [...new Set(shown.map((i) => i.makeOn))].sort();
  const row = (i: StockItem) => {
    const st = k.status(i);
    const dir = `y-${i.id}`;
    const pic = existsSync(join(k.dirOf(i), "img-1.jpg")) ? `<img src="/video-media/_ideas/${esc(dir)}/img-1.jpg" alt="" loading="lazy">` : `<div class="vthumb-empty">${i.kind === "text" ? "Aa" : "🖼"}</div>`;
    let title = i.caption || t("(ảnh không có chú thích)");
    if (st === "ready") {
      try {
        title = (JSON.parse(readFileSync(join(k.dirOf(i), "idea.json"), "utf8")) as { title?: string }).title || title;
      } catch {
        /* keep the caption */
      }
    }
    const open = i.video
      ? `<a class="btn small on" href="/video/${esc(i.video)}">${esc(t("Xem clip"))}</a>`
      : st === "ready" ? `<a class="btn small on" href="/video/idea/${esc(dir)}">${esc(t("Xem đề xuất"))}</a>` : "";
    const skip = `<form class="inline" method="post" action="/video/kho/${esc(i.id)}/${i.skip ? "keep" : "skip"}"><button class="btn small">${esc(t(i.skip ? "Lấy lại" : "Bỏ"))}</button></form>`;
    return `<li class="kho-item s-${st}">${pic}<div><b>${esc(title)}</b>${i.season ? ` <span class="tag">${esc(i.season)}</span>` : ""}
<p class="muted small">${esc(t(topicLabel(i.topic)))} · ❤ ${i.reactions.toLocaleString("vi-VN")} · ↗ ${i.shares.toLocaleString("vi-VN")} · 💬 ${i.comments.toLocaleString("vi-VN")}${i.error ? ` · ${esc(i.error)}` : ""}</p>
<p class="small"><span class="chip">${esc(t(STATUS_LABEL[st]))}</span> ${open} ${skip} <a class="small muted" href="${esc(i.post)}" target="_blank" rel="noreferrer">${esc(t("bài gốc"))}</a></p></div></li>`;
  };
  const list = days.map((d) => `<section class="card"><h2>${esc(d === today ? t("Hôm nay") : d)}</h2><ul class="kho-list">${shown.filter((i) => i.makeOn === d).map(row).join("")}</ul></section>`).join("");
  const body = `<header class="head"><h1>${esc(t("Kho ý"))}</h1><p class="muted">${esc(t("Bài lấy về từ trang khác, xếp theo lượt tương tác, mỗi ngày {n} ý. Máy chỉ đọc chữ và đề xuất clip chữ vài cảnh với nhân vật mình; chưa làm gì khi anh chưa bấm. Không ghi nguồn.", { n: s.perDay }))}</p></header>
${flash(view.ok, view.err)}
<section class="card"><p>${chips || esc(t("Kho đang trống."))}</p>${jobs}
<div class="actions">
<form class="inline" method="post" action="/video/kho/download"><button class="btn on"${k.running() ? " disabled" : ""}>${esc(t("Tải ảnh còn thiếu"))}</button></form>
<form class="inline" method="post" action="/video/kho/read"><select name="days"><option value="1">${esc(t("hôm nay"))}</option><option value="3">${esc(t("3 ngày tới"))}</option><option value="7" selected>${esc(t("7 ngày tới"))}</option><option value="30">${esc(t("30 ngày tới"))}</option></select> <button class="btn"${k.running() ? " disabled" : ""}>${esc(t("Cho máy đọc"))}</button></form>
<form class="inline" method="post" action="/video/kho/make"><input type="hidden" name="days" value="7"><button class="btn on"${k.running() ? " disabled" : ""}>${esc(t("Làm clip cả tuần tới"))}</button></form>
</div>
<p class="muted small">${esc(t("Làm cả tuần: mọi đề xuất của 7 ngày tới thành clip chữ (vẽ, ghép, xuất video) trong một lượt. Anh duyệt cả tuần một lần ở màn Video; chưa đăng gì."))}</p>
<details class="small"><summary>${esc(t("Thêm bài từ file JSON đã lấy về"))}</summary>
<form class="form" method="post" action="/video/kho/import" enctype="multipart/form-data"><input type="file" name="file" accept=".json,application/json" required> <label>${esc(t("Mỗi ngày"))} <input type="number" name="perday" min="1" max="12" value="${s.perDay}"></label> <button class="btn">${esc(t("Thêm vào kho"))}</button></form></details>
<p class="small">${view.all ? `<a href="/video/kho">${esc(t("Chỉ 14 ngày tới"))}</a>` : `<a href="/video/kho?all=1">${esc(t("Xem cả kho ({n})", { n: items.length }))}</a>`}</p></section>
${list}`;
  return layout(t("Kho ý"), "/video", body);
}

/** One line on the Video screen: how much is waiting in the stock. */
export function stockLink(k: IdeaStock): string {
  const items = k.load().items;
  if (!items.length) return "";
  const today = hanoiToday();
  const due = items.filter((i) => i.makeOn <= today && k.status(i) !== "skip").length;
  return `<p class="small"><a href="/video/kho">${esc(t("Kho ý: {n} ý, hôm nay {d}", { n: items.length, d: due }))}</a></p>`;
}
