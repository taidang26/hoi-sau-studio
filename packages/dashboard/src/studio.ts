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
  loadProfile,
  loadStyle,
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
import { esc, layout } from "./views.js";

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
  mock: boolean;
}

export const FORMAT_LABEL: Record<EpisodeFormat, string> = {
  strip3: "Truyện 3 khung, vuốt từng khung",
  carousel: "Carousel 4–6 khung",
};

export const STEP_LABEL: Record<EpisodeStep, string> = {
  premise: "Ý tưởng",
  beats: "Nhịp truyện",
  script: "Kịch bản",
  safety: "Soát an toàn",
  storyboard: "Storyboard",
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

export class Studio {
  /** Background runs by key: an episode id, "style", or "sheet:<slug>". */
  readonly jobs = new Map<string, Job>();
  constructor(readonly opts: StudioOptions) {}

  get styleDir(): string {
    return this.opts.styleDir ?? join(this.opts.runsDir, "..", "style");
  }

  /** One background run per key; a second start while it runs is refused. */
  private background(key: string, work: (log: (s: string) => void) => Promise<unknown>): void {
    if (this.jobs.get(key)?.running) throw new Error("Việc này đang chạy.");
    const job: Job = { running: true };
    this.jobs.set(key, job);
    void (async () => {
      try {
        await work((s) => (job.step = s));
      } catch (e) {
        job.error = e instanceof Error ? e.message : String(e);
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
      if (!ctx.style) throw new Error("Chưa có series/style.yaml.");
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

  async newCharacter(idea: string): Promise<string> {
    if (!idea.trim()) throw new Error("Hãy viết ý tưởng nhân vật.");
    const ctx = this.opts.open(() => {});
    const profile = await createCharacter(ctx.spark, idea.trim(), { bible: ctx.bible, existing: [...ctx.profiles.values()] });
    writeProfile(profile, this.opts.charactersDir);
    return profile.slug;
  }

  approve(slug: string): void {
    approveSheet(slug, join(this.opts.runsDir, slug), this.opts.charactersDir);
  }

  newEpisode(form: URLSearchParams): string {
    const credits = form.getAll("credit").map((c) => {
      const [name, ...rest] = c.split("::");
      return { name, comment: rest.join("::") };
    });
    const format = (form.get("format") || "carousel") as EpisodeFormat;
    const ep = createEpisode(
      { id: (form.get("id") ?? "").trim(), lead: form.get("lead") ?? "", characters: form.getAll("with"), direction: (form.get("direction") ?? "").trim(), credits, format },
      this.opts.episodesDir,
    );
    return ep.id;
  }

  /** Starts a run in the background; refuses a second run of the same episode. */
  run(id: string, opts: { from?: EpisodeStep; to?: EpisodeStep }): void {
    if (this.jobs.get(id)?.running) throw new Error("Tập này đang chạy.");
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
  return `<ol class="steps">${EPISODE_STEPS.map((s) => `<li class="${done.includes(s) ? "done" : ""}">${STEP_LABEL[s]}</li>`).join("")}</ol>`;
};

export function newCharacterPage(mock: boolean, error?: string): string {
  const body = `<p><a href="/characters">← Nhân vật</a></p><header class="page-head"><div><h1>Tạo nhân vật</h1>
<p class="muted">Một câu ý tưởng là đủ. Muse Spark viết hồ sơ đầy đủ: ngoại hình (để vẽ), nét không được sai, bảng màu, biểu cảm, tính cách, giọng nói và những câu không bao giờ nói. Hồ sơ theo series bible và khác hẳn dàn nhân vật đang có.</p></div></header>
${error ? `<div class="warn small">${esc(error)}</div>` : ""}
<form class="card form" method="post" action="/characters/new">
<label>Ý tưởng<textarea name="idea" rows="3" required placeholder="Ví dụ: một con vượn đen má trắng làm thiết kế, luôn đến muộn đúng 5 phút nhưng lý do nào cũng thuyết phục"></textarea></label>
<button class="btn on">Tạo hồ sơ</button>${mock ? '<span class="muted small">Đang chạy giả lập: hồ sơ là mẫu cố định.</span>' : ""}</form>
<section class="card"><h2>Sau khi tạo</h2><ol class="howto"><li>Đọc lại và sửa <code>characters/&lt;slug&gt;/profile.yaml</code> nếu cần.</li><li>Trên trang nhân vật, bấm <b>Vẽ sheet</b>: Muse Image vẽ model sheet, bộ 6 tư thế và 3 khung thử theo phong cách series.</li><li>Ưng thì bấm <b>Khoá model sheet</b>. Từ đó mọi khung đều vẽ theo sheet và bộ tư thế này.</li></ol></section>`;
  return layout("Tạo nhân vật", "/characters", body);
}

export function studioPage(s: State, st: Studio, error?: string): string {
  const dir = st.opts.episodesDir;
  const rows = listEpisodes(dir)
    .reverse()
    .map((id) => {
      const ep = readStep<EpisodeSpec>(id, "episode", dir)!;
      const premise = readStep<Premise>(id, "premise", dir);
      const job = st.jobs.get(id);
      const pages = s.comics.get(id)?.pages ?? [];
      return `<a class="card ep-row" href="/studio/${esc(id)}">${pages.length ? `<div class="mini-strip">${pages.map((p) => `<img src="${esc(p)}" alt="" loading="lazy">`).join("")}</div>` : ""}<div><b>${esc(premise?.title ?? id)}</b><p class="muted small">${esc(id)} · ${esc(ep.characters.join(", "))}${job?.running ? " · đang chạy…" : ""}</p></div>${steps(id, dir)}</a>`;
    })
    .join("");

  const picked = new Set(s.directions.map((d) => d.commentId));
  const ideas = s.comments.filter((c) => picked.has(c.id));
  const nextId = `ep-${String(listEpisodes(dir).length + 1).padStart(3, "0")}`;
  const cast = s.characters.map((c) => c.profile);
  const form = `<form class="card form" method="post" action="/studio/new"><h2>Tập mới</h2>
<div class="row"><label>Mã tập<input name="id" value="${esc(nextId)}" pattern="[a-z0-9-]+" required></label>
<label>Nhân vật chính<select name="lead">${cast.map((p) => `<option value="${esc(p.slug)}">${esc(p.name)}</option>`).join("")}</select></label>
<label>Khuôn<select name="format">${EPISODE_FORMATS.map((f) => `<option value="${f}"${f === "strip3" ? " selected" : ""}>${esc(FORMAT_LABEL[f])}</option>`).join("")}</select></label></div>
<fieldset><legend>Cùng xuất hiện</legend>${cast.map((p) => `<label class="check"><input type="checkbox" name="with" value="${esc(p.slug)}"> ${esc(p.name)}</label>`).join("")}</fieldset>
<label>Hướng truyện<textarea name="direction" rows="3" required placeholder="Chuyện gì xảy ra trong tập này">${esc(ideas.map((c) => c.text).join("\n"))}</textarea></label>
${ideas.length ? `<fieldset><legend>Ghi công người bình luận (từ các ý đã chọn)</legend>${ideas.map((c) => `<label class="check"><input type="checkbox" name="credit" value="${esc(`${c.author.name}::${c.text}`)}" checked> ${esc(c.author.name)}: <span class="muted">${esc(c.text)}</span></label>`).join("")}</fieldset>` : `<p class="muted small">Mẹo: chọn bình luận hay ở trang <a href="/comments">Bình luận</a>, chúng sẽ hiện ở đây làm hướng truyện.</p>`}
<button class="btn on">Tạo tập</button></form>`;

  const body = `<header class="page-head"><div><h1>Studio</h1><p class="muted">Mỗi tập đi qua 8 bước. Bước nào cũng lưu kết quả, xem lại được và chạy lại riêng được. Muse Spark viết, Muse Image vẽ theo model sheet đã khoá, Muse Spark soát lại từng khung.</p></div></header>
${error ? `<div class="warn small">${esc(error)}</div>` : ""}
<div class="grid-studio"><div>${rows || `<div class="card empty"><p>Chưa có tập nào.</p></div>`}</div>${form}</div>`;
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
        .filter(([, t]) => t)
        .map(([p, t]) => `<div class="caption"><span class="tag ${esc(p)}">${esc(p === "facebook" ? "Facebook" : p === "instagram" ? "Instagram" : "Threads")}</span><p>${esc(t)}</p></div>`)
        .join("")
    : "";
  return `<section class="card"><h2>Motion comic và bài đăng</h2><div class="motion">${video}<div>${motion?.duration ? `<p class="muted small">Reels 9:16 · ${motion.duration.toFixed(1)} giây${has("motion/subs.srt") ? ` · <a href="${media(id, "motion/subs.srt")}">phụ đề .srt</a>` : ""}</p>` : ""}${caps || '<p class="muted">Chưa có caption.</p>'}</div></div></section>`;
}

const media = (id: string, file: string) => `/studio-media/${encodeURIComponent(id)}/${file.split("/").map(encodeURIComponent).join("/")}`;

export function episodeStudioPage(s: State, st: Studio, id: string, error?: string): string | undefined {
  const dir = st.opts.episodesDir;
  const ep = readStep<EpisodeSpec>(id, "episode", dir);
  if (!ep) return undefined;
  const get = <T>(step: string) => readStep<T>(id, step, dir);
  const name = (slug: string) => s.characters.find((c) => c.profile.slug === slug)?.profile.name ?? slug;
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
    `<section class="card step${done.includes(step) ? "" : " todo"}" id="${step}"><div class="card-head"><h2><span class="n">${EPISODE_STEPS.indexOf(step) + 1}</span>${STEP_LABEL[step]}</h2>${
      done.includes(step) && !job?.running ? `<form method="post" action="/studio/${esc(id)}/run"><input type="hidden" name="from" value="${step}"><button class="btn" title="Chạy lại bước này và các bước sau">Chạy lại từ đây</button></form>` : ""
    }</div>${done.includes(step) ? inner : '<p class="muted small">Chưa chạy.</p>'}</section>`;

  const runBar = job?.running
    ? `<div class="notice"><b>Đang chạy:</b> ${esc(job.step ?? "bắt đầu…")}</div><meta http-equiv="refresh" content="2">`
    : `${job?.error ? `<div class="warn small">Lần chạy trước dừng lại: ${esc(job.error)}</div>` : ""}${error ? `<div class="warn small">${esc(error)}</div>` : ""}
${next ? `<form class="run" method="post" action="/studio/${esc(id)}/run"><button class="btn on">Chạy hết các bước còn lại</button><button class="btn" name="to" value="${next}">Chỉ chạy bước ${STEP_LABEL[next]}</button>${st.opts.mock ? '<span class="muted small">Giả lập: không gọi Muse thật.</span>' : ""}</form>` : ""}`;

  const body = `<p><a href="/studio">← Studio</a></p><header class="page-head"><div><h1>${esc(premise?.title ?? id)}</h1><p class="muted">${esc(id)} · ${esc(FORMAT_LABEL[ep.format ?? "carousel"])} · chính: ${esc(name(ep.lead))}${ep.characters.length > 1 ? ` · cùng: ${esc(ep.characters.slice(1).map(name).join(", "))}` : ""}</p></div>${steps(id, dir)}</header>
${runBar}
<section class="card"><h2>Hướng từ khán giả</h2><p>${esc(ep.direction)}</p>${ep.credits.length ? `<p class="muted small">Ghi công: ${ep.credits.map((c) => esc(c.name)).join(", ")}</p>` : ""}</section>
${motionSection(st, id)}
${letter?.page ? `<section class="card"><h2>Trang đăng</h2><img class="strip-page" src="${media(id, letter.page)}" alt="Trang 3 khung"><p class="muted small">Bản ghép cũ. Từ 27/10 mỗi khung đăng thành một ảnh riêng để chữ đọc rõ trên điện thoại.</p></section>` : ""}
${letter ? `<section class="card"><h2>Bản hoàn chỉnh</h2><div class="pages">${letter.pages.map((p) => `<figure><img src="${media(id, p.file)}" alt="Trang ${p.n}" loading="lazy"><figcaption>${p.n}${p.overflow ? ` · <span class="tag over">${p.overflow} lời thoại tràn</span>` : ""}</figcaption></figure>`).join("")}</div></section>` : ""}
${section("premise", premise ? `<dl class="kv"><dt>Một câu</dt><dd>${esc(premise.logline)}</dd><dt>Mở</dt><dd>${esc(premise.setup)}</dd><dt>Bất ngờ</dt><dd>${esc(premise.twist)}</dd><dt>Móc hồi sau</dt><dd>${esc(premise.hook)}</dd>${premise.cameo ? `<dt>Khách mời</dt><dd>${esc(premise.cameo.name)}: ${esc(premise.cameo.description)}</dd>` : ""}</dl>` : "")}
${section("beats", beats ? `<ol class="beats">${beats.beats.map((b) => `<li><span class="tag">${esc(b.purpose)}</span> ${esc(b.what_happens)}</li>`).join("")}</ol>` : "")}
${section("script", script ? `<div class="scroll"><table><thead><tr><th>#</th><th>Bối cảnh</th><th>Hành động</th><th>Lời thoại</th></tr></thead><tbody>${script.panels.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.setting)}</td><td>${esc(p.action)}<br><span class="muted small">${p.expressions.map((e) => `${esc(name(e.character))}: ${esc(e.expression)}`).join(" · ")}</span></td><td>${p.dialogue.map((d) => `<b>${esc(name(d.speaker))}:</b> ${esc(d.text)}`).join("<br>") || '<span class="muted">(không thoại)</span>'}</td></tr>`).join("")}</tbody></table></div>` : "")}
${section("storyboard", board ? `<div class="scroll"><table><thead><tr><th>#</th><th>Cỡ cảnh</th><th>Góc</th><th>Bố cục</th><th>Vị trí</th></tr></thead><tbody>${board.panels.map((b, i) => `<tr><td>${i + 1}</td><td>${esc(b.shot)}</td><td>${esc(b.angle)}</td><td>${esc(b.composition)}</td><td>${b.staging.map((x) => `${esc(name(x.character))} ${esc(x.position)}`).join(", ")}</td></tr>`).join("")}</tbody></table></div>` : "")}
${section("panels", panels ? `<div class="shots">${panels.renders.map((r) => `<figure><img src="${media(id, r.file)}" alt="Khung ${r.n}" loading="lazy"><figcaption>Khung ${r.n}${r.history.length ? ` · vẽ lại ${r.history.length} lần` : ""}</figcaption><details><summary class="small muted">Prompt</summary><p class="small">${esc(r.prompt)}</p></details></figure>`).join("")}</div>` : "")}
${section("review", review ? `<ul class="reviews">${review.reviews.map((r) => {
    const before = panels?.renders.find((x) => x.n === r.n)?.history ?? [];
    return `<li><span class="dot ${r.pass ? "ok" : "warn"}"></span><b>Khung ${r.n}</b> ${r.pass ? "đạt" : "chưa đạt"}${r.redrawn ? " sau khi vẽ lại" : ""}${r.issues.length ? `: ${r.issues.map((x) => `${esc(name(x.character))}, ${esc(x.feature)}: ${esc(x.problem)}`).join("; ")}` : ""}${before.length ? `<div class="before">${before.map((f) => `<img src="${media(id, f)}" alt="Trước khi sửa" loading="lazy">`).join("")}<span class="muted small">bản trước khi sửa</span></div>` : ""}</li>`;
  }).join("")}</ul>` : "")}
${section("letter", letter ? `<p class="muted small">Lời thoại tiếng Việt ghép bằng lớp SVG riêng (Be Vietnam Pro), không để model vẽ chữ. File: <code>episodes/${esc(id)}/final/</code></p>` : "")}
${section("canon", canon ? (canon.facts.length ? `<ul>${canon.facts.map((f) => `<li>${esc(f.fact)} <span class="muted small">(${f.characters.map((c) => esc(name(c))).join(", ")})</span></li>`).join("")}</ul><p class="muted small">Đã ghi vào series bible và trí nhớ của từng nhân vật; các tập sau sẽ không viết ngược lại.</p>` : '<p class="muted">Tập này không thêm điều gì cần nhớ.</p>') : "")}`;
  return layout(premise?.title ?? id, "/studio", body);
}

/** Series style: draw the test scene in each variant, pick one, see the locked reference. */
export function stylePage(st: Studio, error?: string): string {
  const style = loadStyle(st.opts.seriesDir);
  const job = st.jobs.get("style");
  if (!style) return layout("Phong cách", "/style", `<header class="page-head"><div><h1>Phong cách</h1></div></header><div class="card empty"><p>Chưa có <code>series/style.yaml</code>.</p></div>`);
  const runFile = join(st.styleDir, "run.json");
  const renders: StyleRender[] = existsSync(runFile) ? (JSON.parse(readFileSync(runFile, "utf8")) as { renders: StyleRender[] }).renders : [];
  const cards = style.variants
    .map((v) => {
      const r = renders.find((x) => x.id === v.id);
      const chosen = style.chosen === v.id;
      return `<figure class="card style-card${chosen ? " chosen" : ""}">${r ? `<img src="/style-media/${encodeURIComponent(r.file)}" alt="${esc(v.label)}" loading="lazy">` : '<div class="empty small"><p>Chưa vẽ thử.</p></div>'}
<figcaption><b>${esc(v.label)}</b>${chosen ? ' <span class="tag ok">đang dùng</span>' : ""}<p class="muted small">${esc(v.prompt)}</p>${
        r && !job?.running ? `<form method="post" action="/style/${esc(v.id)}/approve"><button class="btn${chosen ? "" : " on"}">${chosen ? "Khoá lại bằng ảnh này" : "Chọn kiểu này"}</button></form>` : ""
      }</figcaption></figure>`;
    })
    .join("");
  const bar = job?.running
    ? `<div class="notice"><b>Đang vẽ:</b> ${esc(job.step ?? "bắt đầu…")}</div><meta http-equiv="refresh" content="2">`
    : `${job?.error ? `<div class="warn small">Lần vẽ trước dừng lại: ${esc(job.error)}</div>` : ""}${error ? `<div class="warn small">${esc(error)}</div>` : ""}
<form class="run" method="post" action="/style/draw"><button class="btn${renders.length ? "" : " on"}">${renders.length ? `Vẽ thử lại cả ${style.variants.length} kiểu` : `Vẽ thử ${style.variants.length} kiểu`}</button>${st.opts.mock ? '<span class="muted small">Giả lập: không gọi Muse thật.</span>' : ""}</form>`;
  const locked = style.reference
    ? `<section class="card"><h2>Ảnh neo đang dùng</h2><img class="sheet" src="/series-media/${encodeURIComponent(style.reference)}" alt="Ảnh neo phong cách"><p class="muted small">Ảnh này đi kèm mọi model sheet và khung đầu của mỗi tập. Đổi phong cách thì nên vẽ lại sheet của các nhân vật.</p></section>`
    : "";
  const body = `<header class="page-head"><div><h1>Phong cách</h1><p class="muted">Một kiểu vẽ cho cả series. Cùng một cảnh được vẽ theo từng kiểu; chọn kiểu đọc rõ nhất ở cỡ điện thoại. Kiểu đã chọn thay cho mô tả nét vẽ riêng của từng nhân vật trong mọi prompt.</p></div></header>
${bar}
<div class="styles">${cards}</div>
${locked}
<section class="card"><h2>Phần chung</h2><p>${esc(style.base)}</p>${style.avoid.length ? `<h3>Tránh</h3><ul>${style.avoid.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}<p class="muted small">Sửa trong <code>series/style.yaml</code>.</p></section>`;
  return layout("Phong cách", "/style", body);
}
