/**
 * Hiệu suất: how each posted clip or episode did on each platform, and which posting hour
 * gets the most views. Numbers come from `channel insights` (data/insights.json), pulled by
 * the "Cập nhật số liệu" button; TikTok only gets drafts, so it has no numbers here.
 */

import type { Exec } from "./video.js";
import type { Metrics, State } from "./data.js";
import { button, esc, flash, layout } from "./views.js";
import { locale, t } from "./i18n.js";

const HANOI = 7 * 3600_000;
const hourOf = (iso: string) => new Date(Date.parse(iso) + HANOI).getUTCHours();

export interface PostPerf {
  platform: string;
  permalink?: string;
  at: string;
  /** Plays or views; reach where the platform gives no views. */
  views?: number;
  reach?: number;
  engagement?: number;
  fetchedAt?: string;
}

export interface ClipPerf {
  id: string;
  label: string;
  /** First post of the clip. */
  at: string;
  /** Hanoi hour of the first post. */
  hour: number;
  posts: PostPerf[];
  /** Summed over the platforms that have numbers; undefined when none has. */
  views?: number;
  engagement?: number;
}

/** "pilot-chikhang-10" → "Clip 10 · chikhang"; episode ids stay as they are. */
export function clipLabel(id: string): string {
  const m = id.match(/^pilot-(.+?)-(\d+)$/);
  return m ? t("Clip {n} · {name}", { n: m[2], name: m[1] }) : id;
}

const engagementOf = (m: Metrics) => {
  const parts = [m.reactions, m.comments, m.shares, m.saves].filter((n): n is number => typeof n === "number");
  return parts.length ? parts.reduce((a, b) => a + b, 0) : undefined;
};

/** Published posts grouped per clip (a clip's Threads still is the same clip), newest first. */
export function clipPerformance(s: Pick<State, "episodes" | "metrics">): ClipPerf[] {
  const metric = new Map(s.metrics.map((m) => [m.postId, m]));
  const clips = new Map<string, ClipPerf>();
  for (const e of s.episodes) {
    if (e.state !== "published" || !e.postId) continue;
    const id = e.episodeId.replace(/-still$/, "");
    const m = metric.get(e.postId);
    const c = clips.get(id) ?? { id, label: clipLabel(id), at: e.at, hour: hourOf(e.at), posts: [] };
    if (e.at < c.at) Object.assign(c, { at: e.at, hour: hourOf(e.at) });
    c.posts.push({ platform: e.platform, permalink: e.permalink, at: e.at, views: m ? (m.views ?? m.reach) : undefined, reach: m?.reach, engagement: m ? engagementOf(m) : undefined, fetchedAt: m?.fetchedAt });
    clips.set(id, c);
  }
  for (const c of clips.values()) {
    const seen = c.posts.filter((p) => p.views !== undefined);
    c.views = seen.length ? seen.reduce((n, p) => n + p.views!, 0) : undefined;
    const eng = c.posts.filter((p) => p.engagement !== undefined);
    c.engagement = eng.length ? eng.reduce((n, p) => n + p.engagement!, 0) : undefined;
  }
  return [...clips.values()].sort((a, b) => b.at.localeCompare(a.at));
}

export interface HourBucket {
  hour: number;
  clips: number;
  /** Mean views of the clips posted in this hour that have numbers. */
  avg?: number;
}

export function viewsByHour(clips: ClipPerf[]): HourBucket[] {
  return Array.from({ length: 24 }, (_, hour) => {
    const mine = clips.filter((c) => c.hour === hour && c.views !== undefined);
    return { hour, clips: mine.length, avg: mine.length ? Math.round(mine.reduce((n, c) => n + c.views!, 0) / mine.length) : undefined };
  });
}

/** Pulls fresh numbers in the background with `channel insights`; one run at a time. */
export class Insights {
  running = false;
  error?: string;
  lastAt?: string;

  constructor(private readonly opts: { exec: Exec; script: string; env: Record<string, string> }) {}

  refresh(): void {
    if (this.running) return;
    this.running = true;
    this.error = undefined;
    this.opts
      .exec(this.opts.script, ["insights"], () => {}, this.opts.env)
      .then(() => (this.lastAt = new Date().toISOString()))
      .catch((e: Error) => (this.error = e.message))
      .finally(() => (this.running = false));
  }
}

const num = (n?: number) => (n === undefined ? "–" : n.toLocaleString(locale()));
const when = (iso: string) =>
  new Date(iso).toLocaleString(locale(), { timeZone: "Asia/Ho_Chi_Minh", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const PLATFORMS = ["facebook", "instagram", "threads"] as const;
const NAME: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", threads: "Threads" };

/** One bar per hour from 6:00 to 23:00, the mean views of clips posted then; hover gives the numbers. */
export function hourChart(buckets: HourBucket[]): string {
  const hours = buckets.filter((b) => b.hour >= 6);
  const max = Math.max(1, ...hours.map((b) => b.avg ?? 0));
  const best = hours.reduce<HourBucket | undefined>((a, b) => ((b.avg ?? -1) > (a?.avg ?? -1) ? b : a), undefined);
  const W = 720, H = 220, left = 44, bottom = 28, top = 22, step = (W - left - 8) / hours.length, bar = Math.min(22, step - 6);
  const y = (v: number) => top + (H - top - bottom) * (1 - v / max);
  const ticks = [0, max / 2, max].map((v) => Math.round(v));
  const grid = ticks
    .map((v) => `<line x1="${left}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${left - 8}" y="${y(v) + 4}" class="axis" text-anchor="end">${num(v)}</text>`)
    .join("");
  const bars = hours
    .map((b, i) => {
      const x = left + i * step + (step - bar) / 2;
      const label = i % 3 === 0 ? `<text x="${x + bar / 2}" y="${H - 8}" class="axis" text-anchor="middle">${b.hour}h</text>` : "";
      if (b.avg === undefined) return label;
      const h = Math.max(2, H - bottom - y(b.avg));
      const tip = t("{h}:00–{h}:59 · {n} clip · trung bình {v} lượt xem", { h: b.hour, n: b.clips, v: num(b.avg) });
      const ty = H - bottom - h;
      const r = Math.min(4, bar / 2, h);
      // Rounded at the data end only, flat on the baseline.
      const path = `M${x},${H - bottom} V${ty + r} Q${x},${ty} ${x + r},${ty} H${x + bar - r} Q${x + bar},${ty} ${x + bar},${ty + r} V${H - bottom} Z`;
      const value = b === best ? `<text x="${x + bar / 2}" y="${ty - 6}" class="val" text-anchor="middle">${num(b.avg)}</text>` : "";
      return `<g class="bar"><rect x="${x - (step - bar) / 2}" y="${top}" width="${step}" height="${H - bottom - top}" class="hit"><title>${esc(tip)}</title></rect><path d="${path}"><title>${esc(tip)}</title></path>${value}</g>${label}`;
    })
    .join("");
  return `<svg class="hour-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t("Lượt xem trung bình theo giờ đăng"))}">${grid}<line x1="${left}" x2="${W - 4}" y1="${H - bottom}" y2="${H - bottom}" class="base"/>${bars}</svg>`;
}

export function performancePage(s: Pick<State, "episodes" | "metrics">, opts: { refreshing?: boolean; canRefresh: boolean; error?: string; ok?: string }): string {
  const clips = clipPerformance(s);
  const measured = clips.filter((c) => c.views !== undefined);
  const buckets = viewsByHour(clips);
  const best = buckets.filter((b) => b.avg !== undefined).sort((a, b) => b.avg! - a.avg!)[0];
  const fetched = s.metrics.map((m) => m.fetchedAt ?? "").sort().at(-1);
  const total = measured.reduce((n, c) => n + c.views!, 0);
  const eng = clips.reduce((n, c) => n + (c.engagement ?? 0), 0);
  const stat = (label: string, value: string, hint = "") => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ""}</div>`;
  const action = opts.refreshing
    ? `<div class="notice"><span class="spinner"></span>${esc(t("Đang lấy số liệu từ Facebook, Instagram, Threads…"))}</div><meta http-equiv="refresh" content="3">`
    : opts.canRefresh
      ? button("/performance/refresh", esc(t("Cập nhật số liệu")), "btn on")
      : "";
  const unmeasured = clips.length - measured.length;
  const rows = measured
    .map((c) => {
      const cell = (p: string) => {
        const post = c.posts.find((x) => x.platform === p);
        if (!post) return `<td class="muted">–</td>`;
        const v = num(post.views);
        return `<td class="num">${post.permalink ? `<a href="${esc(post.permalink)}" target="_blank" rel="noopener">${v}</a>` : v}</td>`;
      };
      return `<tr><td><b>${esc(c.label)}</b></td><td>${esc(when(c.at))}</td>${PLATFORMS.map(cell).join("")}<td class="num"><b>${num(c.views)}</b></td><td class="num">${num(c.engagement)}</td></tr>`;
    })
    .join("");
  const body = `<header class="page-head"><div><h1>${esc(t("Hiệu suất"))}</h1><p class="muted">${esc(t("Lượt xem và tương tác của từng clip trên Facebook, Instagram, Threads. TikTok chỉ nhận bản nháp nên chưa có số ở đây."))}</p></div><div>${action}</div></header>
${flash(opts.ok, opts.error)}
<section class="stats">${stat(t("Clip đã đăng"), String(clips.length), t("{n} clip có số liệu", { n: measured.length }))}${stat(t("Tổng lượt xem"), num(total))}${stat(t("Tương tác"), num(eng), t("thích, bình luận, chia sẻ, lưu"))}${stat(t("Giờ xem nhiều nhất"), best ? `${best.hour}h` : "–", best ? t("trung bình {v} lượt xem, {n} clip", { v: num(best.avg), n: best.clips }) : "")}</section>
${
  measured.length
    ? `<section class="card"><h2>${esc(t("Lượt xem trung bình theo giờ đăng"))}</h2><p class="muted small">${esc(t("Mỗi cột là trung bình lượt xem của các clip đăng trong giờ đó (giờ Hà Nội). Ít clip thì chưa kết luận được, cần đăng thêm vài ngày."))}</p>${hourChart(buckets)}</section>`
    : `<div class="empty"><p>${esc(t("Chưa có số liệu. Bấm Cập nhật số liệu để lấy từ các kênh."))}</p></div>`
}
${
  measured.length
    ? `<section class="card"><h2>${esc(t("Từng clip"))}</h2><div class="scroll"><table class="perf"><thead><tr><th>${esc(t("Clip"))}</th><th>${esc(t("Đăng lúc"))}</th>${PLATFORMS.map((p) => `<th class="num">${NAME[p]}</th>`).join("")}<th class="num">${esc(t("Tổng xem"))}</th><th class="num">${esc(t("Tương tác"))}</th></tr></thead><tbody>${rows}</tbody></table></div>${fetched ? `<p class="muted small">${esc(t("Số liệu lấy lúc {at}. Facebook và Instagram đếm lượt phát video; Threads đếm lượt xem.", { at: when(fetched) }))}</p>` : ""}${unmeasured ? `<p class="muted small">${esc(t("{n} bài đã đăng chưa có số liệu, chưa hiện ở bảng.", { n: unmeasured }))}</p>` : ""}</section>`
    : ""
}`;
  return layout(t("Hiệu suất"), "/performance", body);
}
