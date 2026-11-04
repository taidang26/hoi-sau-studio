/**
 * Lịch đăng: when each approved clip goes out. The clips post themselves through Windows
 * Task Scheduler (one task per clip under \HoiSau\, running the story checkout's post script),
 * so this page reads those tasks back, lets the owner move, drop or add clips, spread them
 * at random hours, and installs the new plan without opening PowerShell.
 *
 * Off Windows (tests, the cloud, sample data) the plan file stands in for the tasks.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { State } from "./data.js";
import { clipLabel } from "./performance.js";
import { esc, flash, layout } from "./views.js";
import { locale, t } from "./i18n.js";

const HANOI = 7 * 3600_000;
const ID = /^[a-z0-9][a-z0-9-]*$/;

export interface Slot {
  id: string;
  /** ISO time it posts. */
  at: string;
  /** Task name in Task Scheduler, when read from Windows. */
  task?: string;
}

export interface Listing {
  slots: Slot[];
  /** Tasks under \HoiSau\ whose clip could not be read: the page will not rewrite the plan around them. */
  unknown: string[];
  source: "windows" | "plan";
  error?: string;
}

export type Run = (script: string) => { code: number; out: string };

export interface ScheduleOptions {
  /** The checkout whose scripts\post-clip.ps1 posts the clips (hoi-sau-story next to this one, else this repo). */
  repo: string;
  /** Read and install Windows tasks; false: only the plan file. */
  windows: boolean;
  /** Runs one PowerShell script; replaced in tests. */
  run?: Run;
}

/** "yyyy-MM-dd HH:mm" in Hanoi time, the plan file's format. */
export const planTime = (iso: string) => new Date(Date.parse(iso) + HANOI).toISOString().slice(0, 16).replace("T", " ");
/** The plan file's "yyyy-MM-dd HH:mm" (Hanoi) as ISO. */
export const fromPlanTime = (s: string) => new Date(Date.parse(`${s.replace(" ", "T")}:00.000Z`) - HANOI).toISOString();

export function parsePlan(text: string): Slot[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(\S+)/))
    .filter((m): m is RegExpMatchArray => Boolean(m && ID.test(m[3])))
    .map((m) => ({ id: m[3], at: fromPlanTime(`${m[1]} ${m[2]}`) }));
}

export const planText = (slots: Slot[]) =>
  `# Lịch đăng, sửa từ dashboard. Mỗi dòng: ngày giờ (Hà Nội) rồi mã clip.\n${[...slots].sort((a, b) => a.at.localeCompare(b.at)).map((s) => `${planTime(s.at)} ${s.id}`).join("\n")}\n`;

/** The clip id a task runs, from its "…post-clip.ps1" <id>" arguments. */
export const taskClip = (args: string) => args.match(/post-clip\.ps1"?\s+([a-z0-9][a-z0-9-]*)/i)?.[1];

const powershell: Run = (script) => {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", timeout: 90_000, windowsHide: true });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? r.error.message : ""}`.trim() };
};

const LIST_TASKS =
  "$ErrorActionPreference='Stop'; $t = @(Get-ScheduledTask -TaskPath '\\HoiSau\\' -ErrorAction SilentlyContinue | ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; [pscustomobject]@{ name = $_.TaskName; args = (($_.Actions | ForEach-Object { $_.Arguments }) -join ' '); next = $(if ($i.NextRunTime) { $i.NextRunTime.ToUniversalTime().ToString('o') } else { '' }) } }); ConvertTo-Json -InputObject $t -Compress";

export class Schedule {
  private cache?: { at: number; value: Listing };
  constructor(readonly opts: ScheduleOptions) {}

  planFile = () => join(this.opts.repo, "data", "post-plan.txt");
  private run = (script: string) => (this.opts.run ?? powershell)(script);

  list(): Listing {
    if (this.cache && Date.now() - this.cache.at < 20_000) return this.cache.value;
    const value = this.opts.windows ? this.readTasks() : this.readPlan();
    this.cache = { at: Date.now(), value };
    return value;
  }

  private readPlan(): Listing {
    const f = this.planFile();
    const slots = existsSync(f) ? parsePlan(readFileSync(f, "utf8")) : [];
    return { slots: slots.filter((s) => Date.parse(s.at) > Date.now() - 60_000), unknown: [], source: "plan" };
  }

  private readTasks(): Listing {
    const r = this.run(LIST_TASKS);
    if (r.code !== 0) return { ...this.readPlan(), error: r.out.split("\n")[0] || t("Không đọc được lịch của Windows.") };
    let rows: Array<{ name: string; args: string; next: string }> = [];
    try {
      rows = JSON.parse(r.out || "[]");
    } catch {
      return { ...this.readPlan(), error: t("Không đọc được lịch của Windows.") };
    }
    const slots: Slot[] = [];
    const unknown: string[] = [];
    for (const row of rows) {
      const id = taskClip(row.args ?? "");
      if (!id) unknown.push(row.name);
      else if (row.next) slots.push({ id, at: new Date(row.next).toISOString(), task: row.name });
    }
    return { slots: slots.sort((a, b) => a.at.localeCompare(b.at)), unknown, source: "windows" };
  }

  /**
   * Writes the plan and, on Windows, installs it: every clip in it gets its task (made or moved),
   * then tasks of clips no longer in it are removed. Nothing is removed if installing fails.
   */
  save(slots: Slot[]): { installed: boolean; message?: string } {
    const clean = slots.filter((s) => ID.test(s.id) && Number.isFinite(Date.parse(s.at)));
    const f = this.planFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(`${f}.tmp`, planText(clean));
    renameSync(`${f}.tmp`, f);
    this.cache = undefined;
    if (!this.opts.windows) return { installed: false };
    const script = join(this.opts.repo, "scripts", "schedule-posts.ps1");
    if (!existsSync(script)) return { installed: false, message: t("Không thấy công cụ đặt lịch trên máy này.") };
    const keep = clean.map((s) => `'HoiSau post ${s.id}'`).join(",");
    const r = this.run(
      `$ErrorActionPreference='Stop'; Set-Location '${this.opts.repo.replace(/'/g, "''")}'; & '${script.replace(/'/g, "''")}' -Plan 'data\\post-plan.txt' | Out-Null; if (-not $?) { exit 1 }; $keep = @(${keep}); Get-ScheduledTask -TaskPath '\\HoiSau\\' -ErrorAction SilentlyContinue | Where-Object { $keep -notcontains $_.TaskName } | Unregister-ScheduledTask -Confirm:$false`,
    );
    this.cache = undefined;
    return r.code === 0 ? { installed: true } : { installed: false, message: r.out.split("\n").find((l) => l.trim()) ?? "" };
  }
}

/**
 * Random posting times for `count` clips: `perDay` a day (picked anew each day between its two
 * numbers), between 7:00 and 23:00 Hanoi, at least two hours apart, starting 30 minutes from now.
 */
export function randomTimes(count: number, now = new Date(), perDay: [number, number] = [3, 5], rand = Math.random): string[] {
  const out: string[] = [];
  const earliest = now.getTime() + 30 * 60_000;
  let day = Math.floor((now.getTime() + HANOI) / 86_400_000);
  for (let guard = 0; out.length < count && guard < 60; guard++, day++) {
    const want = Math.min(count - out.length, perDay[0] + Math.floor(rand() * (perDay[1] - perDay[0] + 1)));
    const start = Math.max(7 * 60, Math.ceil((earliest - day * 86_400_000 + HANOI) / 60_000));
    const end = 23 * 60;
    if (end - start < 0) continue;
    const fit = Math.min(want, Math.floor((end - start) / 120) + 1);
    let picks: number[] = [];
    for (let tries = 0; tries < 400; tries++) {
      picks = Array.from({ length: fit }, () => start + Math.floor(rand() * (end - start + 1))).sort((a, b) => a - b);
      if (picks.every((m, i) => i === 0 || m - picks[i - 1] >= 120)) break;
      picks = [];
    }
    if (!picks.length) picks = Array.from({ length: fit }, (_, i) => start + i * 120);
    for (const m of picks) out.push(new Date(day * 86_400_000 - HANOI + m * 60_000).toISOString());
  }
  return out;
}

/** Clips already on at least one platform. */
export const postedClips = (s: Pick<State, "episodes">) => new Set(s.episodes.filter((e) => e.state === "published").map((e) => e.episodeId.replace(/-still$/, "")));

/** Approved clips that have not gone out and are not on the schedule yet, oldest first. */
export function waitingClips(s: Pick<State, "episodes" | "clipFiles">, slots: Slot[]): string[] {
  const posted = postedClips(s);
  const planned = new Set(slots.map((x) => x.id));
  return [...s.clipFiles.keys()].filter((id) => !posted.has(id) && !planned.has(id) && s.clipFiles.get(id)?.video).sort(byClipNumber);
}

const clipNumber = (id: string) => Number(id.match(/-(\d+)$/)?.[1] ?? 0);
const byClipNumber = (a: string, b: string) => clipNumber(a) - clipNumber(b) || a.localeCompare(b);

const local = (iso: string) => new Date(Date.parse(iso) + HANOI).toISOString().slice(0, 16);
const dayName = (iso: string) => new Date(iso).toLocaleDateString(locale(), { timeZone: "Asia/Ho_Chi_Minh", weekday: "long", day: "2-digit", month: "2-digit" });
const when = (iso: string) => new Date(iso).toLocaleString(locale(), { timeZone: "Asia/Ho_Chi_Minh", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
/** The value of a datetime-local field, read as Hanoi time. */
export const fromLocalField = (v: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? fromPlanTime(v.replace("T", " ")) : undefined);

const cover = (s: Pick<State, "clipFiles">, id: string) => {
  const c = s.clipFiles.get(id);
  return c?.still ? `<img src="${esc(c.still)}" alt="" loading="lazy">` : c?.video ? `<video src="${esc(c.video)}#t=1" muted preload="metadata"></video>` : `<span class="ph"></span>`;
};
const caption = (s: Pick<State, "clipFiles">, id: string) => esc((s.clipFiles.get(id)?.caption ?? "").split("\n")[0].slice(0, 90));

/** A clip made in the dashboard's Video screen with a set time: the dashboard posts it itself while it is open. */
export interface DashClip {
  id: string;
  title: string;
  at: string;
  caption?: string;
  cover?: string;
}

export function schedulePage(s: Pick<State, "episodes" | "clipFiles">, l: Listing, ok?: string, err?: string, dash: DashClip[] = []): string {
  const waiting = waitingClips(s, l.slots);
  const days = new Map<string, Slot[]>();
  for (const x of l.slots) days.set(planTime(x.at).slice(0, 10), [...(days.get(planTime(x.at).slice(0, 10)) ?? []), x]);
  const row = (x: Slot) => `<li class="slot"><span class="slot-cover">${cover(s, x.id)}</span><div class="slot-body"><b>${esc(clipLabel(x.id))}</b><small class="muted">${caption(s, x.id)}</small></div>
<label class="slot-time"><span class="sr">${esc(t("Giờ đăng"))}</span><input type="datetime-local" name="at:${esc(x.id)}" value="${local(x.at)}"></label>
<label class="slot-drop"><input type="checkbox" name="drop" value="${esc(x.id)}"> ${esc(t("Bỏ"))}</label></li>`;
  const list = l.slots.length
    ? [...days.entries()].map(([d, xs]) => `<h3 class="day">${esc(dayName(xs[0].at))} <span class="muted small">${esc(t("{n} bài", { n: xs.length }))}</span></h3><ul class="slots">${xs.map(row).join("")}</ul>`).join("")
    : `<div class="empty"><p>${esc(t("Chưa có bài nào hẹn giờ."))}</p></div>`;
  const wait = waiting.length
    ? `<section class="card"><h2>${esc(t("Đã duyệt, chưa xếp lịch"))} <span class="muted">${waiting.length}</span></h2><ul class="slots">${waiting
        .map((id) => `<li class="slot"><span class="slot-cover">${cover(s, id)}</span><div class="slot-body"><b>${esc(clipLabel(id))}</b><small class="muted">${caption(s, id)}</small></div><label class="slot-drop"><input type="checkbox" name="add" value="${esc(id)}" checked> ${esc(t("Xếp vào lịch"))}</label></li>`)
        .join("")}</ul></section>`
    : "";
  const stock = l.slots.length ? t("Còn {n} bài trong lịch, đủ tới {d}.", { n: l.slots.length, d: when(l.slots[l.slots.length - 1].at) }) : "";
  const warnUnknown = l.unknown.length ? `<div class="warn small">${esc(t("Có {n} lịch không đọc được trên máy, nên trang này chỉ xem, không sửa được.", { n: l.unknown.length }))}</div>` : "";
  const body = `<header class="page-head"><div><h1>${esc(t("Lịch đăng"))}</h1><p class="muted">${esc(t("Máy tự đăng đúng giờ lên Facebook, Instagram, Threads và gửi bản nháp TikTok. Cho máy ngủ được, chỉ đừng tắt hẳn."))}</p></div></header>
${flash(ok, err ?? l.error)}${warnUnknown}
${stock ? `<p class="notice">${esc(stock)}</p>` : ""}
<form method="post" action="/schedule" class="schedule">
<section class="card">${list}</section>
${wait}
${dash.length ? `<section class="card"><h2>${esc(t("Clip làm trong dashboard"))} <span class="muted">${dash.length}</span></h2><p class="muted small">${esc(t("Mấy clip này do dashboard tự đăng đúng giờ, nên để dashboard mở (máy ngủ được, đừng tắt)."))}</p><ul class="slots">${dash
    .map((d) => `<li class="slot"><span class="slot-cover">${d.cover ? `<img src="${esc(d.cover)}" alt="" loading="lazy">` : `<span class="ph"></span>`}</span><div class="slot-body"><b><a href="/video/${esc(d.id)}">${esc(d.title)}</a></b><small class="muted">${esc((d.caption ?? "").split("\n")[0].slice(0, 90))}</small></div>
<label class="slot-time"><span class="sr">${esc(t("Giờ đăng"))}</span><input type="datetime-local" name="vat:${esc(d.id)}" value="${local(d.at)}"></label>
<label class="slot-drop"><input type="checkbox" name="vdrop" value="${esc(d.id)}"> ${esc(t("Bỏ hẹn"))}</label></li>`)
    .join("")}</ul></section>` : ""}
<div class="vactions"><button class="btn on" name="do" value="save"${l.unknown.length && !dash.length ? " disabled" : ""}>${esc(t("Lưu lịch"))}</button>
<button class="btn" name="do" value="shuffle"${l.unknown.length ? " disabled" : ""}>${esc(t("Xếp lại giờ ngẫu nhiên"))}</button>
<label class="small">${esc(t("Mỗi ngày"))} <select name="perday"><option value="2-3">2–3</option><option value="3-5" selected>3–5</option><option value="4-4">4</option><option value="5-6">5–6</option></select> ${esc(t("bài, 7:00–23:00, cách nhau ít nhất 2 tiếng"))}</label></div>
</form>`;
  return layout(t("Lịch đăng"), "/schedule", body);
}

/** Reads the form: moved times, dropped clips, added clips, and whether to spread them at random. */
export function planFromForm(form: URLSearchParams, current: Slot[], now = new Date()): Slot[] {
  const drop = new Set(form.getAll("drop"));
  const kept = current.filter((x) => !drop.has(x.id)).map((x) => ({ id: x.id, at: fromLocalField(form.get(`at:${x.id}`) ?? "") ?? x.at }));
  const added = form.getAll("add").filter((id) => ID.test(id) && !kept.some((x) => x.id === id));
  if (form.get("do") === "shuffle") {
    const [lo, hi] = (form.get("perday") ?? "3-5").split("-").map(Number);
    const ids = [...kept.map((x) => x.id), ...added];
    const times = randomTimes(ids.length, now, [lo || 3, hi || lo || 5]);
    return ids.map((id, i) => ({ id, at: times[i] }));
  }
  const last = kept.map((x) => Date.parse(x.at)).sort((a, b) => b - a)[0];
  const tail = randomTimes(added.length, new Date(Math.max(now.getTime(), last ? last + 90 * 60_000 : 0)));
  return [...kept, ...added.map((id, i) => ({ id, at: tail[i] }))];
}
