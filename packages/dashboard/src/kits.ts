/**
 * Đồ làm sẵn: the pictures drawn once per character and reused in clips (packages/talk),
 * on one screen so the owner looks them over and approves or redraws with a tap instead of a command.
 *
 *   characters/<slug>/stock/      reaction pictures (talk stock), approved ones go into memes
 *   characters/<slug>/mouthkit/   mouth shapes (talk mouthkit), pasted in lip-sync clips
 *   series/backgrounds/           office rooms (talk backgrounds)
 *
 * A folder drawn for an older design of the character (designChanged) says so, with one button to draw it all again.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { designChanged } from "@hoi-sau/studio";
import { t } from "./i18n.js";
import type { Exec } from "./video.js";
import { esc, flash, layout } from "./views.js";

const TALK = "packages/talk/dist/cli.js";

export interface StockEntry { name: string; vi: string; approved: boolean; used: Array<{ clip: string; on: string }> }

export class ReadyMade {
  readonly jobs = new Map<string, { running: boolean; step?: string; error?: string }>();
  constructor(
    readonly opts: { charactersDir: () => string; seriesDir: () => string; exec: Exec; cast: () => Array<{ slug: string; name: string }> },
  ) {}

  stockDir = (slug: string) => join(this.opts.charactersDir(), slug, "stock");
  kitDir = (slug: string) => join(this.opts.charactersDir(), slug, "mouthkit");
  backgroundsDir = () => join(this.opts.seriesDir(), "backgrounds");

  stock(slug: string): StockEntry[] {
    try {
      return JSON.parse(readFileSync(join(this.stockDir(slug), "stock.json"), "utf8")) as StockEntry[];
    } catch {
      return [];
    }
  }

  /** The owner's word on reactions; `name` "all" means every one with a picture. */
  approve(slug: string, name: string, approved: boolean): number {
    const entries = this.stock(slug);
    let n = 0;
    for (const e of entries) if ((name === "all" || e.name === name) && existsSync(join(this.stockDir(slug), `${e.name}.png`))) { e.approved = approved; n++; }
    if (!n) throw new Error(t("Không có tranh nào tên này."));
    writeFileSync(join(this.stockDir(slug), "stock.json"), `${JSON.stringify(entries, null, 1)}\n`);
    return n;
  }

  running = () => [...this.jobs.values()].some((j) => j.running);

  /** Runs one talk command in the background under `key`; one at a time per key. */
  private run(key: string, args: string[]): void {
    if (this.jobs.get(key)?.running) throw new Error(t("Việc này đang chạy."));
    const job: { running: boolean; step?: string; error?: string } = { running: true, step: t("Đang bắt đầu…") };
    this.jobs.set(key, job);
    void this.opts
      .exec(TALK, args, (line) => (job.step = line.slice(0, 160)))
      .then(() => { job.running = false; job.step = undefined; })
      .catch((e: Error) => { job.running = false; job.error = e.message.slice(0, 300); });
  }

  /** Redraws reactions: one by name, "missing" (the ones without a picture) or "all". */
  redrawStock(slug: string, what: string): void {
    const names = what === "all" ? this.stock(slug).map((e) => e.name) : what === "missing" ? [] : [what];
    if (what === "all" && !names.length) return this.run(`stock:${slug}`, ["stock", slug]);
    this.run(`stock:${slug}`, ["stock", slug, ...(names.length ? ["--only", names.join(",")] : [])]);
  }

  /** Draws the missing mouth shapes, or (`all`) the whole kit again. */
  redrawKit(slug: string, all: boolean): void {
    this.run(`kit:${slug}`, ["mouthkit", slug, ...(all ? ["--only", "front,side"] : [])]);
  }

  /** Draws the missing office rooms, or one again by name. */
  redrawBackgrounds(name?: string): void {
    this.run("backgrounds", ["backgrounds", ...(name ? ["--only", name] : [])]);
  }

  backgrounds(): Array<{ name: string; vi: string; file: string }> {
    try {
      return (JSON.parse(readFileSync(join(this.backgroundsDir(), "backgrounds.json"), "utf8")) as Array<{ name: string; vi: string }>)
        .map((b) => ({ ...b, file: `${b.name}.png` }))
        .filter((b) => existsSync(join(this.backgroundsDir(), b.file)));
    } catch {
      return [];
    }
  }

  /** The file a /ready-media/ URL names, or undefined: only pictures inside the ready-made folders. */
  file(path: string): string | undefined {
    const m = path.match(/^([a-z0-9-]+)\/(stock|mouthkit)\/([a-z0-9-]+\.(?:png|jpg))$/) ?? path.match(/^(_bg)\/(backgrounds)\/([a-z0-9-]+\.(?:png|jpg))$/);
    if (!m) return undefined;
    const f = m[1] === "_bg" ? join(this.backgroundsDir(), m[3]) : join(m[2] === "stock" ? this.stockDir(m[1]) : this.kitDir(m[1]), m[3]);
    return existsSync(f) ? f : undefined;
  }
}

const post = (action: string, label: string, on = false) =>
  `<form class="inline" method="post" action="${esc(action)}"><button class="btn small${on ? " on" : ""}">${esc(label)}</button></form>`;

export function readyPage(r: ReadyMade, view: { err?: string; ok?: string } = {}): string {
  const jobLine = (key: string) => {
    const j = r.jobs.get(key);
    return j?.running ? `<p class="small"><span class="spinner"></span> ${esc(j.step ?? "")}</p>` : j?.error ? `<p class="small err">${esc(j.error)}</p>` : "";
  };
  const people = r.opts.cast().map(({ slug, name }) => {
    const entries = r.stock(slug), sdir = r.stockDir(slug), kdir = r.kitDir(slug);
    const drawn = entries.filter((e) => existsSync(join(sdir, `${e.name}.png`)));
    const ok = drawn.filter((e) => e.approved).length;
    const stale = (existsSync(sdir) && designChanged(sdir, slug, r.opts.charactersDir())) || (existsSync(kdir) && designChanged(kdir, slug, r.opts.charactersDir()));
    const tiles = drawn.map((e) => {
      const b2 = existsSync(join(sdir, `${e.name}-b2.png`));
      return `<li class="ready-tile${e.approved ? " ok" : ""}"><img src="/ready-media/${esc(slug)}/stock/${esc(e.name)}.png" alt="${esc(e.vi)}" loading="lazy">
<p class="small"><b>${e.approved ? "✓ " : ""}${esc(e.vi)}</b>${b2 ? ` <span class="muted">· ${esc(t("2 dáng"))}</span>` : ""}${e.used.length ? ` <span class="muted">· ${esc(t("đã dùng {n}", { n: e.used.length }))}</span>` : ""}</p>
<p class="small">${post(`/video/san/${slug}/${e.approved ? "unapprove" : "approve"}/${e.name}`, t(e.approved ? "Bỏ duyệt" : "Duyệt"), !e.approved)} ${post(`/video/san/${slug}/redraw/${e.name}`, t("Vẽ lại"))}</p></li>`;
    }).join("");
    const kitSheet = existsSync(join(kdir, "sheet.jpg")) ? `<img class="ready-sheet" src="/ready-media/${esc(slug)}/mouthkit/sheet.jpg" alt="" loading="lazy">` : `<p class="muted small">${esc(t("Chưa có bộ mồm."))}</p>`;
    return `<section class="card" id="${esc(slug)}"><h2>${esc(name)}</h2>
${stale ? `<p class="flash err">${esc(t("Thiết kế nhân vật đã đổi từ lúc vẽ đồ làm sẵn: nên vẽ lại để khớp."))} ${post(`/video/san/${slug}/redraw/all`, t("Vẽ lại hết"), true)} ${post(`/video/san/${slug}/mouthkit/all`, t("Vẽ lại bộ mồm"), true)}</p>` : ""}
<h3>${esc(t("Phản ứng"))} <span class="muted small">${esc(t("{ok}/{n} đã duyệt", { ok, n: drawn.length }))}</span></h3>
<p class="small">${drawn.length && ok < drawn.length ? post(`/video/san/${slug}/approve/all`, t("Duyệt hết"), true) : ""} ${post(`/video/san/${slug}/redraw/missing`, t(drawn.length ? "Vẽ phần còn thiếu" : "Vẽ kho phản ứng"))}</p>
${jobLine(`stock:${slug}`)}<ul class="ready-grid">${tiles}</ul>
<h3>${esc(t("Bộ mồm"))}</h3>${kitSheet}
<p class="small">${post(`/video/san/${slug}/mouthkit/missing`, t(existsSync(join(kdir, "kit.json")) ? "Vẽ mồm còn thiếu" : "Làm bộ mồm"))} ${existsSync(join(kdir, "kit.json")) ? post(`/video/san/${slug}/mouthkit/all`, t("Vẽ lại bộ mồm")) : ""}</p>${jobLine(`kit:${slug}`)}</section>`;
  }).join("");
  const bgs = r.backgrounds();
  const rooms = `<section class="card" id="phong"><h2>${esc(t("Phông văn phòng"))}</h2>
<ul class="ready-grid">${bgs.map((b) => `<li class="ready-tile"><img src="/ready-media/_bg/backgrounds/${esc(b.file)}" alt="${esc(b.vi)}" loading="lazy"><p class="small"><b>${esc(b.vi)}</b></p><p class="small">${post(`/video/san/_bg/backgrounds/${b.name}`, t("Vẽ lại"))}</p></li>`).join("")}</ul>
<p class="small">${post("/video/san/_bg/backgrounds/missing", t(bgs.length ? "Vẽ phòng còn thiếu" : "Vẽ phông văn phòng"))}</p>${jobLine("backgrounds")}</section>`;
  const body = `${flash(view.ok, view.err)}<section class="card"><h1>${esc(t("Đồ làm sẵn"))}</h1>
<p class="muted">${esc(t("Tranh vẽ một lần rồi dùng lại trong clip: phản ứng cho meme (chỉ tranh đã duyệt), bộ mồm cho clip nhép, phông các phòng. Tranh mới vẽ lại phải duyệt lại."))}</p>
<p class="small">${r.opts.cast().map((c) => `<a href="#${esc(c.slug)}">${esc(c.name)}</a>`).join(" · ")} · <a href="#phong">${esc(t("Phông"))}</a></p></section>
${people}${rooms}
<style>.ready-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;list-style:none;padding:0}.ready-tile img{width:100%;aspect-ratio:9/16;object-fit:cover;border-radius:8px;border:2px solid transparent}.ready-tile.ok img{border-color:#3a9d5d}.ready-sheet{max-width:100%;border-radius:8px}</style>`;
  return layout(t("Đồ làm sẵn"), "/video", body);
}

/** One line on the Video screen. */
export function readyLink(r: ReadyMade): string {
  const cast = r.opts.cast();
  const waiting = cast.reduce((n, c) => n + r.stock(c.slug).filter((e) => !e.approved && existsSync(join(r.stockDir(c.slug), `${e.name}.png`))).length, 0);
  const stale = cast.filter((c) => [r.stockDir(c.slug), r.kitDir(c.slug)].some((d) => existsSync(d) && designChanged(d, c.slug, r.opts.charactersDir()))).length;
  const extra = [waiting ? t("{n} tranh chờ duyệt", { n: waiting }) : "", stale ? t("{n} nhân vật đổi thiết kế", { n: stale }) : ""].filter(Boolean).join(", ");
  return `<p class="small"><a href="/video/san">${esc(t("Đồ làm sẵn"))}${extra ? `: ${esc(extra)}` : ""}</a></p>`;
}
