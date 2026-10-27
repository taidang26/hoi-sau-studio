/**
 * Studio pages: create a character from an idea, lock its model sheet, and
 * build an episode step by step (premise → … → lettered pages), seeing what
 * every step saved. Runs happen in the background; the page refreshes itself
 * while a run is going.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  approveSheet,
  approveStyle,
  EPISODE_FORMATS,
  loadBrandList,
  loadProfile,
  loadStyle,
  makeBrandArt,
  MUSE_IMAGE_MODEL,
  runConsistency,
  runStyleTest,
  styleReference,
  styleText,
  type EpisodeFormat,
  type StyleRender,
  createCharacter,
  createEpisode,
  doneSteps,
  EPISODE_STEPS,
  listEpisodes,
  readStep,
  runEpisode,
  writeProfile,
  type Beats,
  type EpisodeSpec,
  type EpisodeStep,
  type PanelRender,
  type PanelReview,
  type Premise,
  type Script,
  type Storyboard,
  type StudioContext,
} from "@hoi-sau/studio";
import type { State } from "./data.js";
import { t } from "./i18n.js";
import { button, esc, flash, layout } from "./views.js";

export interface StudioOptions {
  /** Opened on each action, so a missing API key shows as an error, not a crash. */
  open(log: (s: string) => void): StudioContext;
  episodesDir: string;
  charactersDir: string;
  /** Character consistency runs: <runsDir>/<slug>/. */
  runsDir: string;
  /** series/: bible, style.yaml and the locked style-ref.*. */
  seriesDir?: string;
  /** Style test renders; defaults to output/style next to runsDir. */
  styleDir?: string;
  /** Page profile pictures and covers; defaults to output/brand-art next to runsDir. */
  brandArtDir?: string;
  /** channels.yaml, for the brand list. */
  brandsFile?: string;
  mock: boolean;
}

export const FORMAT_LABEL: Record<EpisodeFormat, string> = {
  strip3: "Truyện 3 khung, vuốt từng khung",
  carousel: "Truyện dài 4–6 khung",
};

export const STEP_LABEL: Record<EpisodeStep, string> = {
  premise: "Ý tưởng",
  beats: "Nhịp truyện",
  script: "Kịch bản",
  safety: "Soát an toàn",
  storyboard: "Phân cảnh",
  panels: "Vẽ khung",
  review: "Tự soát",
  letter: "Ghép chữ",
  canon: "Ghi nhớ",
};

interface Job {
  running: boolean;
  step?: string;
  error?: string;
  finishedAt?: string;
}

/** Library errors in words a person can act on. */
export function friendly(message: string): string {
  if (/API key|META_API_KEY|MODEL_API_KEY/i.test(message)) return t("Chưa có khoá AI Muse. Vào Cài đặt để thêm.");
  if (/already exists/i.test(message)) return t("Tên này đã có. Chọn tên khác.");
  if (/unknown style/i.test(message)) return t("Không thấy kiểu vẽ này.");
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)) return t("Không gọi được máy chủ AI. Kiểm tra mạng rồi thử lại.");
  if (/\b(429|rate limit)/i.test(message)) return t("AI đang quá tải. Đợi một phút rồi thử lại.");
  return message;
}

export class Studio {
  /** Background runs by key: an episode id, "style", "sheet:<slug>" or "art:<brand>". */
  readonly jobs = new Map<string, Job>();
  constructor(readonly opts: StudioOptions) {}

  get styleDir(): string {
    return this.opts.styleDir ?? join(this.opts.runsDir, "..", "style");
  }

  get brandArtDir(): string {
    return this.opts.brandArtDir ?? join(this.opts.runsDir, "..", "brand-art");
  }

  /** Whether the AI can run: the offline mock, or a key is set. */
  get ready(): boolean {
    return this.opts.mock || Boolean(process.env.META_API_KEY || process.env.MODEL_API_KEY);
  }

  /** One background run per key; a second start while it runs is refused. */
  private background(key: string, work: (log: (s: string) => void) => Promise<unknown>): void {
    if (this.jobs.get(key)?.running) throw new Error(t("Việc này đang chạy."));
    const job: Job = { running: true };
    this.jobs.set(key, job);
    void (async () => {
      try {
        await work((s) => (job.step = s));
      } catch (e) {
        job.error = friendly(e instanceof Error ? e.message : String(e));
      } finally {
        job.running = false;
        job.finishedAt = new Date().toISOString();
      }
    })();
  }

  /** Draw the style test scene in every variant of series/style.yaml. */
  drawStyle(): void {
    this.background("style", async (log) => {
      const ctx = this.opts.open(log);
      if (!ctx.style) throw new Error(t("Chưa có bộ phong cách."));
      await runStyleTest(ctx.image, ctx.style, this.styleDir, { mock: this.opts.mock, log });
    });
  }

  chooseStyle(id: string): void {
    approveStyle(id, this.styleDir, this.opts.seriesDir);
  }

  /** Model sheet, pose sheet and three test panels for one character, in the series style. */
  drawSheet(slug: string): void {
    const profile = loadProfile(slug, this.opts.charactersDir);
    this.background(`sheet:${slug}`, async (log) => {
      const ctx = this.opts.open(log);
      await runConsistency(ctx.image, profile, join(this.opts.runsDir, slug), {
        model: this.opts.mock ? "mock" : process.env.MUSE_IMAGE_MODEL || MUSE_IMAGE_MODEL,
        mock: this.opts.mock,
        log,
        style: ctx.style && styleText(ctx.style),
        styleRef: styleReference(ctx.style, ctx.seriesDir),
      });
    });
  }

  /** Profile picture and cover for one brand's page. */
  drawBrandArt(brandId: string): void {
    const brand = loadBrandList(this.opts.brandsFile).find((b) => b.id === brandId);
    if (!brand) throw new Error(t("Không thấy kênh này."));
    this.background(`art:${brandId}`, async (log) => {
      const ctx = this.opts.open(log);
      await makeBrandArt(ctx, [brand], this.brandArtDir, log);
    });
  }

  async newCharacter(idea: string): Promise<string> {
    if (!idea.trim()) throw new Error(t("Hãy viết ý tưởng nhân vật."));
    const ctx = this.opts.open(() => {});
    const profile = await createCharacter(ctx.spark, idea.trim(), { bible: ctx.bible, existing: [...ctx.profiles.values()] });
    writeProfile(profile, this.opts.charactersDir);
    return profile.slug;
  }

  approve(slug: string): void {
    approveSheet(slug, join(this.opts.runsDir, slug), this.opts.charactersDir);
  }

  /** Next free "<lead>-ep-NNN", the same ids the daily pipeline uses. */
  nextId(lead: string): string {
    const taken = new Set(listEpisodes(this.opts.episodesDir));
    let n = 1;
    while (taken.has(`${lead}-ep-${String(n).padStart(3, "0")}`)) n++;
    return `${lead}-ep-${String(n).padStart(3, "0")}`;
  }

  newEpisode(form: URLSearchParams): string {
    const credits = form.getAll("credit").map((c) => {
      const [name, ...rest] = c.split("::");
      return { name, comment: rest.join("::") };
    });
    const lead = form.get("lead") ?? "";
    const direction = (form.get("direction") ?? "").trim();
    if (!direction) throw new Error(t("Hãy viết hướng truyện."));
    const format = (form.get("format") || "strip3") as EpisodeFormat;
    const ep = createEpisode({ id: (form.get("id") ?? "").trim() || this.nextId(lead), lead, characters: form.getAll("with"), direction, credits, format }, this.opts.episodesDir);
    return ep.id;
  }

  /** Starts a run in the background; refuses a second run of the same episode. */
  run(id: string, opts: { from?: EpisodeStep; to?: EpisodeStep }): void {
    if (this.jobs.get(id)?.running) throw new Error(t("Tập này đang chạy."));
    this.background(id, async (log) => {
      const ctx = this.opts.open(log);
      ctx.dir = this.opts.episodesDir;
      await runEpisode(ctx, id, opts);
    });
  }

  /** Waits for a background run; for tests. */
  async settle(key: string): Promise<void> {
    while (this.jobs.get(key)?.running) await new Promise((r) => setTimeout(r, 20));
  }
}

// ── views ──────────────────────────────────────────────────────────────────

const steps = (id: string, dir: string) => {
  const done = doneSteps(id, dir);
  return `<ol class="steps">${EPISODE_STEPS.map((s) => `<li class="${done.includes(s) ? "done" : ""}">${esc(t(STEP_LABEL[s]))}</li>`).join("")}</ol>`;
};

const castName = (s: State, slug: string) => s.characters.find((c) => c.profile.slug === slug)?.profile.name ?? slug;
const aiNote = (st: Studio) => (st.opts.mock ? `<span class="muted small">${esc(t("Bản thử: AI không chạy thật."))}</span>` : st.ready ? "" : `<span class="muted small">${esc(t("Cần khoá AI Muse."))} <a href="/settings">${esc(t("Mở Cài đặt"))}</a></span>`);

export function studioPage(s: State, st: Studio, error?: string, inspiration = ""): string {
  const dir = st.opts.episodesDir;
  const rows = listEpisodes(dir)
    .reverse()
    .map((id) => {
      const ep = readStep<EpisodeSpec>(id, "episode", dir)!;
      const premise = readStep<Premise>(id, "premise", dir);
      const job = st.jobs.get(id);
      const comic = s.comics.get(id);
      const pages = comic?.pages ?? [];
      const faces = ep.characters
        .map((slug) => s.characters.find((c) => c.profile.slug === slug))
        .filter(Boolean)
        .map((c) => `<img class="face" src="${c!.run?.images.find((i) => i.id === "sheet") ? `/media/${esc(c!.profile.slug)}/${esc(c!.run!.images.find((i) => i.id === "sheet")!.file)}` : `/portrait/${esc(c!.profile.slug)}.svg`}" alt="${esc(c!.profile.name)}" title="${esc(c!.profile.name)}" style="background:${esc(c!.profile.look.palette[0].hex)}44">`)
        .join("");
      return `<a class="card ep-row" href="/studio/${esc(id)}">${pages.length ? `<div class="mini-strip">${pages.map((p) => `<img src="${esc(p)}" alt="" loading="lazy">`).join("")}</div>` : `<div class="mini-strip empty-strip">✎</div>`}<div class="ep-row-body"><b>${esc(premise?.title ?? ep.direction.slice(0, 60))}</b><div class="faces">${faces}</div>${job?.running ? `<span class="tag due"><span class="spinner"></span>${esc(t("đang chạy…"))}</span>` : ""}</div>${steps(id, dir)}</a>`;
    })
    .join("");

  const picked = new Set(s.directions.map((d) => d.commentId));
  const ideas = s.comments.filter((c) => picked.has(c.id));
  const cast = s.characters.map((c) => c);
  const pic = (slug: string) => {
    const c = s.characters.find((x) => x.profile.slug === slug)!;
    const sheet = c.run?.images.find((i) => i.id === "sheet");
    return sheet ? `/media/${esc(slug)}/${esc(sheet.file)}` : `/portrait/${esc(slug)}.svg`;
  };
  const form = `<form class="card form new-ep" method="post" action="/studio/new"><h2>${esc(t("Tập mới"))}</h2>
<fieldset class="pick-cast"><legend>${esc(t("Nhân vật chính"))}</legend>${cast.map((c, i) => `<label class="cast-pick"><input type="radio" name="lead" value="${esc(c.profile.slug)}"${i === 0 ? " checked" : ""}><img src="${pic(c.profile.slug)}" alt="" style="background:${esc(c.profile.look.palette[0].hex)}44"><span>${esc(c.profile.name)}</span></label>`).join("")}</fieldset>
<fieldset class="pick-cast small-pick"><legend>${esc(t("Cùng xuất hiện"))}</legend>${cast.map((c) => `<label class="cast-pick"><input type="checkbox" name="with" value="${esc(c.profile.slug)}"><img src="${pic(c.profile.slug)}" alt="" style="background:${esc(c.profile.look.palette[0].hex)}44"><span>${esc(c.profile.name)}</span></label>`).join("")}</fieldset>
<label>${esc(t("Hướng truyện"))}<textarea name="direction" rows="3" required placeholder="${esc(t("Chuyện gì xảy ra trong tập này"))}">${esc(ideas.map((c) => c.text).join("\n"))}</textarea></label>
<fieldset class="pick-format"><legend>${esc(t("Kiểu truyện"))}</legend>${EPISODE_FORMATS.map((f) => `<label class="format-pick"><input type="radio" name="format" value="${f}"${f === "strip3" ? " checked" : ""}><span class="fmt fmt-${f}">${f === "strip3" ? "<i></i><i></i><i></i>" : "<i></i><i></i><i></i><i></i><i></i>"}</span>${esc(t(FORMAT_LABEL[f]))}</label>`).join("")}</fieldset>
${ideas.length ? `<fieldset><legend>${esc(t("Ghi công người bình luận"))}</legend>${ideas.map((c) => `<label class="check"><input type="checkbox" name="credit" value="${esc(`${c.author.name}::${c.text}`)}" checked> <b>${esc(c.author.name)}</b>: <span class="muted">${esc(c.text)}</span></label>`).join("")}</fieldset>` : `<p class="muted small">${t('Mẹo: chọn bình luận hay ở trang <a href="/comments">Bình luận</a>, chúng sẽ hiện ở đây làm hướng truyện.')}</p>`}
${inspiration}
<div class="row-actions"><button class="btn on">${esc(t("Tạo tập"))}</button>${aiNote(st)}</div></form>`;

  const flow = `<ol class="flow">${EPISODE_STEPS.map((x, i) => `<li><b>${i + 1}</b>${esc(t(STEP_LABEL[x]))}</li>`).join("")}</ol>`;
  const body = `<header class="page-head"><div><h1>Studio</h1><p class="muted">${esc(t("Mỗi tập đi qua 8 bước. Muse Spark viết, Muse Image vẽ theo model sheet đã khoá, rồi tự soát lại từng khung. Bước nào cũng xem lại và chạy lại riêng được."))}</p></div></header>
${flow}
${flash(undefined, error)}
<div class="grid-studio">${form}<div>${rows || `<div class="card empty"><p>${esc(t("Chưa có tập nào. Tạo tập đầu tiên ở bên cạnh."))}</p></div>`}</div></div>`;
  return layout("Studio", "/studio", body);
}

interface PostFile {
  title?: string;
  captions?: Partial<Record<"facebook" | "instagram" | "threads", string>>;
}

/** Reels video, cover and captions written by packages/pipeline into episodes/<id>/motion and post.json. */
function motionSection(st: Studio, id: string): string {
  const dir = join(st.opts.episodesDir, id);
  const has = (f: string) => existsSync(join(dir, f));
  const post = has("post.json") ? (JSON.parse(readFileSync(join(dir, "post.json"), "utf8")) as PostFile) : undefined;
  const motion = has("motion/motion.json") ? (JSON.parse(readFileSync(join(dir, "motion/motion.json"), "utf8")) as { duration?: number }) : undefined;
  if (!has("motion/reel.mp4") && !post) return "";
  const video = has("motion/reel.mp4")
    ? `<video class="reel" controls preload="metadata" playsinline${has("motion/cover.jpg") ? ` poster="${media(id, "motion/cover.jpg")}"` : ""} src="${media(id, "motion/reel.mp4")}"></video>`
    : "";
  const caps = post?.captions
    ? Object.entries(post.captions)
        .filter(([, x]) => x)
        .map(([p, x]) => `<div class="caption"><span class="tag ${esc(p)}">${esc(p === "facebook" ? "Facebook" : p === "instagram" ? "Instagram" : "Threads")}</span><p>${esc(x)}</p></div>`)
        .join("")
    : "";
  return `<section class="card"><h2>${esc(t("Video và bài đăng"))}</h2><div class="motion">${video}<div>${motion?.duration ? `<p class="muted small">${esc(t("Video dọc · {s} giây", { s: motion.duration.toFixed(1) }))}${has("motion/subs.srt") ? ` · <a href="${media(id, "motion/subs.srt")}">${esc(t("phụ đề"))}</a>` : ""}</p>` : ""}${caps || `<p class="muted">${esc(t("Chưa có nội dung bài đăng."))}</p>`}</div></div></section>`;
}

const media = (id: string, file: string) => `/studio-media/${encodeURIComponent(id)}/${file.split("/").map(encodeURIComponent).join("/")}`;

export function episodeStudioPage(s: State, st: Studio, id: string, error?: string, extra = ""): string | undefined {
  const dir = st.opts.episodesDir;
  const ep = readStep<EpisodeSpec>(id, "episode", dir);
  if (!ep) return undefined;
  const get = <T>(step: string) => readStep<T>(id, step, dir);
  const name = (slug: string) => castName(s, slug);
  const job = st.jobs.get(id);
  const done = doneSteps(id, dir);
  const next = EPISODE_STEPS.find((x) => !done.includes(x));

  const premise = get<Premise>("premise");
  const beats = get<Beats>("beats");
  const script = get<Script>("script");
  const board = get<Storyboard>("storyboard");
  const panels = get<{ renders: PanelRender[] }>("panels");
  const review = get<{ reviews: PanelReview[] }>("review");
  const letter = get<{ pages: Array<{ n: number; file: string; overflow: number }>; page?: string }>("letter");
  const canon = get<{ facts: Array<{ fact: string; characters: string[] }> }>("canon");

  const section = (step: EpisodeStep, inner: string) =>
    `<section class="card step${done.includes(step) ? "" : " todo"}" id="${step}"><div class="card-head"><h2><span class="n">${done.includes(step) ? "✓" : EPISODE_STEPS.indexOf(step) + 1}</span>${esc(t(STEP_LABEL[step]))}</h2>${
      done.includes(step) && !job?.running ? button(`/studio/${id}/run`, esc(t("Làm lại từ bước này")), "btn ghost", { from: step }) : ""
    }</div>${done.includes(step) ? inner : `<p class="muted small">${esc(t("Chưa chạy."))}</p>`}</section>`;

  const runBar = job?.running
    ? `<div class="notice"><span class="spinner"></span><b>${esc(t("Đang chạy"))}:</b> ${esc(job.step ?? t("bắt đầu…"))}</div><meta http-equiv="refresh" content="2">`
    : `${job?.error ? `<div class="warn small">${esc(t("Lần chạy trước dừng lại"))}: ${esc(job.error)}</div>` : ""}${flash(undefined, error)}
${next ? `<form class="run" method="post" action="/studio/${esc(id)}/run"><button class="btn on">▶ ${esc(t(done.length ? "Chạy tiếp đến hết" : "Bắt đầu làm tập"))}</button><button class="btn" name="to" value="${next}">${esc(t("Chỉ chạy bước {step}", { step: t(STEP_LABEL[next]) }))}</button>${aiNote(st)}</form>` : ""}`;

  const dl = (rows: Array<[string, string | undefined]>) => `<dl class="kv">${rows.filter(([, v]) => v).map(([k, v]) => `<dt>${esc(t(k))}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
  const body = `<p><a href="/studio">← Studio</a></p><header class="page-head"><div><h1>${esc(premise?.title ?? t("Tập mới"))}</h1><p class="muted">${esc(t(FORMAT_LABEL[ep.format ?? "carousel"]))} · ${esc(t("vai chính"))}: ${esc(name(ep.lead))}${ep.characters.length > 1 ? ` · ${esc(t("cùng"))}: ${esc(ep.characters.slice(1).map(name).join(", "))}` : ""}</p></div>${steps(id, dir)}</header>
${runBar}
<section class="card"><h2>${esc(t("Hướng từ khán giả"))}</h2><p class="pre">${esc(ep.direction)}</p>${ep.credits.length ? `<p class="muted small">${esc(t("Ghi công"))}: ${ep.credits.map((c) => esc(c.name)).join(", ")}</p>` : ""}</section>
${motionSection(st, id)}
${letter?.page ? `<section class="card"><h2>${esc(t("Trang ghép"))}</h2><img class="strip-page" src="${media(id, letter.page)}" alt=""></section>` : ""}
${letter ? `<section class="card"><h2>${esc(t("Bản hoàn chỉnh"))}</h2><div class="pages">${letter.pages.map((p) => `<figure><img src="${media(id, p.file)}" alt="${esc(t("Khung {n}", { n: p.n }))}" loading="lazy"><figcaption>${p.n}${p.overflow ? ` · <span class="tag over">${esc(t("{n} lời thoại tràn", { n: p.overflow }))}</span>` : ""}</figcaption></figure>`).join("")}</div></section>` : ""}
${extra}
${section("premise", premise ? dl([["Một câu", premise.logline], ["Mở đầu", premise.setup], ["Bất ngờ", premise.twist], ["Móc hồi sau", premise.hook], ["Khách mời", premise.cameo ? `${premise.cameo.name}: ${premise.cameo.description}` : undefined]]) : "")}
${section("beats", beats ? `<ol class="beats">${beats.beats.map((b) => `<li><span class="tag">${esc(b.purpose)}</span> ${esc(b.what_happens)}</li>`).join("")}</ol>` : "")}
${section("script", script ? `<div class="scroll"><table><thead><tr><th>#</th><th>${esc(t("Bối cảnh"))}</th><th>${esc(t("Hành động"))}</th><th>${esc(t("Lời thoại"))}</th></tr></thead><tbody>${script.panels.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.setting)}</td><td>${esc(p.action)}<br><span class="muted small">${p.expressions.map((e) => `${esc(name(e.character))}: ${esc(e.expression)}`).join(" · ")}</span></td><td>${p.dialogue.map((d) => `<b>${esc(name(d.speaker))}:</b> ${esc(d.text)}`).join("<br>") || `<span class="muted">(${esc(t("không thoại"))})</span>`}</td></tr>`).join("")}</tbody></table></div>` : "")}
${section("storyboard", board ? `<div class="scroll"><table><thead><tr><th>#</th><th>${esc(t("Cỡ cảnh"))}</th><th>${esc(t("Góc máy"))}</th><th>${esc(t("Bố cục"))}</th><th>${esc(t("Vị trí"))}</th></tr></thead><tbody>${board.panels.map((b, i) => `<tr><td>${i + 1}</td><td>${esc(b.shot)}</td><td>${esc(b.angle)}</td><td>${esc(b.composition)}</td><td>${b.staging.map((x) => `${esc(name(x.character))} ${esc(x.position)}`).join(", ")}</td></tr>`).join("")}</tbody></table></div>` : "")}
${section("panels", panels ? `<div class="shots">${panels.renders.map((r) => `<figure><img src="${media(id, r.file)}" alt="${esc(t("Khung {n}", { n: r.n }))}" loading="lazy"><figcaption>${esc(t("Khung {n}", { n: r.n }))}${r.history.length ? ` · ${esc(t("vẽ lại {n} lần", { n: r.history.length }))}` : ""}</figcaption><details><summary class="small muted">${esc(t("Mô tả gửi AI"))}</summary><p class="small">${esc(r.prompt)}</p></details></figure>`).join("")}</div>` : "")}
${section("review", review ? `<ul class="reviews">${review.reviews.map((r) => {
    const before = panels?.renders.find((x) => x.n === r.n)?.history ?? [];
    return `<li><span class="dot ${r.pass ? "ok" : "warn"}"></span><b>${esc(t("Khung {n}", { n: r.n }))}</b> ${esc(t(r.pass ? "đạt" : "chưa đạt"))}${r.redrawn ? ` ${esc(t("sau khi vẽ lại"))}` : ""}${r.issues.length ? `: ${r.issues.map((x) => `${esc(name(x.character))}, ${esc(x.feature)}: ${esc(x.problem)}`).join("; ")}` : ""}${before.length ? `<div class="before">${before.map((f) => `<img src="${media(id, f)}" alt="${esc(t("Trước khi sửa"))}" loading="lazy">`).join("")}<span class="muted small">${esc(t("bản trước khi sửa"))}</span></div>` : ""}</li>`;
  }).join("")}</ul>` : "")}
${section("letter", letter ? `<p class="muted small">${esc(t("Lời thoại ghép bằng lớp chữ riêng, không để AI vẽ chữ, nên đọc rõ và dịch được."))}</p>` : "")}
${section("canon", canon ? (canon.facts.length ? `<ul>${canon.facts.map((f) => `<li>${esc(f.fact)} <span class="muted small">(${f.characters.map((c) => esc(name(c))).join(", ")})</span></li>`).join("")}</ul><p class="muted small">${esc(t("Đã ghi vào trí nhớ của series và từng nhân vật; các tập sau sẽ không viết ngược lại."))}</p>` : `<p class="muted">${esc(t("Tập này không thêm điều gì cần nhớ."))}</p>`) : "")}`;
  return layout(premise?.title ?? t("Tập mới"), "/studio", body);
}

/** Series style: draw the test scene in each variant, pick one, see the locked reference. */
export function stylePage(st: Studio, error?: string): string {
  const style = loadStyle(st.opts.seriesDir);
  const job = st.jobs.get("style");
  if (!style) return layout(t("Phong cách"), "/style", `<header class="page-head"><div><h1>${esc(t("Phong cách"))}</h1></div></header><div class="card empty"><p>${esc(t("Chưa có bộ phong cách."))}</p></div>`);
  const runFile = join(st.styleDir, "run.json");
  const renders: StyleRender[] = existsSync(runFile) ? (JSON.parse(readFileSync(runFile, "utf8")) as { renders: StyleRender[] }).renders : [];
  const cards = style.variants
    .map((v) => {
      const r = renders.find((x) => x.id === v.id);
      const chosen = style.chosen === v.id;
      return `<figure class="card style-card${chosen ? " chosen" : ""}">${r ? `<img src="/style-media/${encodeURIComponent(r.file)}" alt="${esc(v.label)}" loading="lazy">` : `<div class="empty small"><p>${esc(t("Chưa vẽ thử."))}</p></div>`}
<figcaption><b>${esc(v.label)}</b>${chosen ? ` <span class="tag ok">✓ ${esc(t("đang dùng"))}</span>` : ""}<details><summary class="muted small">${esc(t("Mô tả gửi AI"))}</summary><p class="muted small">${esc(v.prompt)}</p></details>${
        r && !job?.running ? button(`/style/${v.id}/approve`, esc(t(chosen ? "Khoá lại bằng ảnh này" : "Chọn kiểu này")), `btn${chosen ? "" : " on"}`) : ""
      }</figcaption></figure>`;
    })
    .join("");
  const bar = job?.running
    ? `<div class="notice"><span class="spinner"></span><b>${esc(t("Đang vẽ"))}:</b> ${esc(job.step ?? t("bắt đầu…"))}</div><meta http-equiv="refresh" content="2">`
    : `${job?.error ? `<div class="warn small">${esc(t("Lần vẽ trước dừng lại"))}: ${esc(job.error)}</div>` : ""}${flash(undefined, error)}
<form class="run" method="post" action="/style/draw"><button class="btn${renders.length ? "" : " on"}">${esc(renders.length ? t("Vẽ thử lại cả {n} kiểu", { n: style.variants.length }) : t("Vẽ thử {n} kiểu", { n: style.variants.length }))}</button>${aiNote(st)}</form>`;
  const locked = style.reference
    ? `<section class="card"><h2>${esc(t("Ảnh mẫu đang dùng"))}</h2><img class="sheet" src="/series-media/${encodeURIComponent(style.reference)}" alt=""><p class="muted small">${esc(t("Ảnh này đi kèm mọi model sheet và khung đầu của mỗi tập. Đổi phong cách thì nên vẽ lại model sheet của các nhân vật."))}</p></section>`
    : "";
  const body = `<header class="page-head"><div><h1>${esc(t("Phong cách"))}</h1><p class="muted">${esc(t("Một kiểu vẽ cho cả series. Cùng một cảnh được vẽ theo từng kiểu; chọn kiểu đọc rõ nhất trên điện thoại."))}</p></div></header>
${bar}
<div class="styles">${cards}</div>
${locked}
<section class="card"><h2>${esc(t("Phần chung"))}</h2><p>${esc(style.base)}</p>${style.avoid.length ? `<h3>${esc(t("Tránh"))}</h3><ul>${style.avoid.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}</section>`;
  return layout(t("Phong cách"), "/style", body);
}
