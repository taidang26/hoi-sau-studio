/**
 * One day of Hồi Sau, end to end:
 *
 *   listen     pull new comments on published episodes
 *   direction  pick what the episode is about and who leads (direction.ts)
 *   studio     premise → script → panels → self-review → lettering (Studio)
 *   motion     9:16 motion comic, cover, subtitles (motion package)
 *   package    captions per platform, JPEG carousel, post.json
 *   upload     public URLs for every file (Meta fetches media itself)
 *   publish    Reels and carousel to Facebook, Instagram, Threads
 *
 * Every stage is safe to repeat: Studio resumes from its first unsaved step,
 * motion clips are cached, and the channel's publish journal never posts the
 * same episode twice. A failed day is resumed by running again; a finished
 * day is skipped unless forced.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Brand,
  type Comment,
  type EpisodePost,
  fetchFacebookComments,
  fetchInstagramComments,
  fetchThreadsReplies,
  FileJournal,
  type Format,
  journalPath,
  loadComments,
  MAIN_BRAND,
  mergeComments,
  type Platform,
  publishEpisode,
  replyOnThreads,
  routeEpisode,
  saveComments,
  type Targets,
} from "@hoi-sau/channel";
import { ffmpeg, probeVideo, reelsProblems, renderMotionComic, specFromEpisode } from "@hoi-sau/motion";
import {
  createEpisode,
  type EpisodeSpec,
  episodeDir,
  listEpisodes,
  type PanelReview,
  type Premise,
  readStep,
  runEpisode,
  type StudioContext,
} from "@hoi-sau/studio";
import { type Captions, captions } from "./caption.js";
import { type PickedByHand, pickDirection } from "./direction.js";
import type { MediaHost } from "./host.js";
import { acquireLock, loadRuns, type PostRecord, type Run, saveRun, type Stage, type StageStatus, usedComments } from "./runs.js";
import { hanoiDate } from "./schedule.js";

export interface PostPlan {
  format: Format;
  platforms: Platform[];
}

/** Reels everywhere; the carousel where people swipe images (not Threads, to post once a day there). */
export const DEFAULT_PLAN: PostPlan[] = [
  { format: "reels-9x16", platforms: ["facebook", "instagram", "threads"] },
  { format: "carousel-4x5", platforms: ["facebook", "instagram"] },
];

/** "reels:facebook,instagram;carousel:instagram" → plan. */
export function parsePlan(s: string): PostPlan[] {
  return s
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [f, list = ""] = part.split(":");
      const format: Format = f.trim().startsWith("carousel") ? "carousel-4x5" : "reels-9x16";
      const platforms = list.split(",").map((p) => p.trim()).filter((p): p is Platform => ["facebook", "instagram", "threads"].includes(p));
      return { format, platforms };
    });
}

/** One brand from channels.yaml with the accounts .env gives it. */
export interface BrandSetup {
  brand: Brand;
  /** Undefined when the brand's Page is not connected yet. */
  targets?: Targets;
  /** Platforms ready to post: live and every variable set. */
  platforms: Platform[];
  /** Live platforms that cannot post yet, and why. */
  skipped: { platform: Platform; reason: string }[];
  /** The brand's Threads handle, so its own replies are not read as comments. */
  threadsUsername?: string;
}

export interface ChannelSetup {
  brands: BrandSetup[];
}

export interface PipelineDeps {
  mode: "mock" | "live";
  studio: StudioContext;
  episodesDir: string;
  /** CHANNEL_DATA_DIR: comments.json, publish-journal.json, directions.json, pipeline/. */
  dataDir: string;
  channel?: ChannelSetup;
  host?: MediaHost;
  plan?: PostPlan[];
  motion?: { quality?: "draft" | "final"; audio?: string };
  /** Force the lead character. */
  lead?: string;
  /** A direction typed by a person; skips comment picking. */
  direction?: string;
  /** false: make the episode but stop before upload and publish. */
  publish?: boolean;
  /** Publish even when self-review left a panel failing. Off by default. */
  publishFailedReview?: boolean;
  now?: () => Date;
  log?: (s: string) => void;
  pollIntervalMs?: number;
}

export interface PostFile {
  episodeId: string;
  number: number;
  title: string;
  /** Route the post to the lead's brand (and cast brands) in channels.yaml. */
  lead: string;
  characters: string[];
  captions: Captions;
  /** Paths relative to the episode folder. */
  media: Partial<Record<Format, string[]>>;
  cover?: string;
  urls?: Partial<Record<Format, string[]>>;
  createdAt: string;
}

const pad = (n: number) => String(n).padStart(3, "0");

export async function runDaily(deps: PipelineDeps, opts: { force?: boolean } = {}): Promise<Run> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const date = hanoiDate(now());
  const runs = loadRuns(deps.dataDir);
  const today = runs.filter((r) => r.date === date);
  const finished = today.find((r) => r.status === "done" || r.status === "partial");
  if (finished && !opts.force) {
    log(`${date}: already ran (${finished.status}, ${finished.episodeId}). Use --force for another episode today.`);
    return finished;
  }

  const release = acquireLock(deps.dataDir, now());
  // Resume an unfinished run of today, or start a new one.
  const resume = opts.force ? undefined : today.find((r) => r.status === "failed" || r.status === "running");
  const run: Run = resume
    ? { ...resume, status: "running", error: undefined, finishedAt: undefined }
    : { id: today.length ? `${date}-${today.length + 1}` : date, date, mode: deps.mode, status: "running", startedAt: now().toISOString(), stages: [], posts: [] };
  const save = () => saveRun(deps.dataDir, run);
  save();

  const stage = async (name: Stage, fn: () => Promise<{ status?: StageStatus; note?: string } | void>) => {
    const rec = { name, status: "running" as StageStatus, startedAt: now().toISOString() };
    run.stages = [...run.stages.filter((s) => s.name !== name), rec];
    save();
    log(`${run.id}: ${name}`);
    try {
      const out = (await fn()) ?? {};
      Object.assign(rec, { status: out.status ?? "done", note: out.note, finishedAt: now().toISOString() });
    } catch (e) {
      Object.assign(rec, { status: "failed", error: e instanceof Error ? e.message : String(e), finishedAt: now().toISOString() });
      throw e;
    } finally {
      save();
    }
  };

  let withheld: string | undefined;
  try {
    await stage("listen", () => listen(deps));
    await stage("direction", async () => {
      if (run.episodeId && readStep(run.episodeId, "episode", deps.episodesDir)) return { status: "skipped", note: `Tiếp tục ${run.episodeId}` };
      return chooseDirection(deps, run, runs);
    });
    const id = run.episodeId!;
    const dir = episodeDir(id, deps.episodesDir);

    await stage("studio", async () => {
      const ran = await runEpisode(deps.studio, id);
      const review = readStep<{ reviews: PanelReview[] }>(id, "review", deps.episodesDir);
      const failing = review?.reviews.filter((r) => !r.pass) ?? [];
      const letter = readStep<{ pages: { overflow: number }[] }>(id, "letter", deps.episodesDir);
      const overflow = letter?.pages.filter((p) => p.overflow > 0).length ?? 0;
      const notes = [ran.length ? `Chạy ${ran.join(" → ")}` : "Đã có sẵn"];
      if (failing.length) {
        notes.push(`Tự soát chưa đạt: khung ${failing.map((r) => r.n).join(", ")}`);
        if (!deps.publishFailedReview) withheld = `Khung ${failing.map((r) => r.n).join(", ")} chưa qua tự soát, cần người duyệt trước khi đăng.`;
      }
      if (overflow) notes.push(`${overflow} trang có lời thoại tràn bong bóng`);
      return { status: failing.length || overflow ? "warn" : "done", note: notes.join(". ") };
    });

    await stage("motion", async () => {
      const names = Object.fromEntries([...deps.studio.profiles.values()].map((p) => [p.slug, p.name]));
      const spec = specFromEpisode(dir, { names, quality: deps.motion?.quality, audio: deps.motion?.audio ? { file: deps.motion.audio } : undefined });
      const res = await renderMotionComic(spec, join(dir, "motion"));
      const problems = reelsProblems(await probeVideo(res.video));
      // Draft renders are half size on purpose; only real renders must pass the Reels check.
      if (problems.length && deps.motion?.quality !== "draft") throw new Error(`Video chưa đạt chuẩn Reels: ${problems.join("; ")}`);
      run.video = `${id}/motion/reel.mp4`;
      run.cover = `${id}/motion/cover.jpg`;
      return { note: `${res.duration.toFixed(1)} giây, ${res.width}x${res.height}` };
    });

    await stage("package", async () => {
      const post = await packageEpisode(deps, id, dir);
      return { note: `${Object.values(post.media).flat().length} tệp, chú thích cho ${Object.keys(post.captions).length} nền tảng` };
    });

    if (deps.publish === false) {
      await stage("upload", async () => ({ status: "skipped", note: "Tắt đăng bài (--no-publish)" }));
      await stage("publish", async () => ({ status: "skipped", note: "Tắt đăng bài (--no-publish)" }));
    } else if (withheld) {
      await stage("upload", async () => ({ status: "skipped", note: withheld }));
      await stage("publish", async () => ({ status: "skipped", note: withheld }));
    } else {
      await stage("upload", () => upload(deps, id, dir));
      await stage("publish", () => publish(deps, run, id, dir));
    }

    const failedPosts = run.posts.filter((p) => p.status === "failed").length;
    run.status = withheld || failedPosts ? "partial" : "done";
    if (withheld) run.error = withheld;
  } catch (e) {
    run.status = "failed";
    run.error = e instanceof Error ? e.message : String(e);
  } finally {
    run.finishedAt = now().toISOString();
    save();
    release();
  }
  log(`${run.id}: ${run.status}${run.error ? ` (${run.error})` : ""}`);
  return run;
}

async function listen(deps: PipelineDeps): Promise<{ status?: StageStatus; note: string }> {
  if (!deps.channel?.brands.some((b) => b.targets)) return { status: "skipped", note: "Chưa nối kênh nào (xem npm run channel -- brands)" };
  const brands = deps.channel.brands;
  const published = (await new FileJournal(journalPath(deps.dataDir)).published())
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, 20);
  const fetched: Comment[] = [];
  const errors: string[] = [];
  for (const p of published) {
    const setup = brands.find((b) => b.brand.id === (p.brand ?? MAIN_BRAND));
    const targets = setup?.targets;
    if (!targets) continue;
    const threadsUsername = setup.threadsUsername;
    try {
      if (p.platform === "facebook") fetched.push(...(await fetchFacebookComments(targets.page, targets.pageId, p.postId)));
      else if (p.platform === "instagram" && targets.igUserId) fetched.push(...(await fetchInstagramComments(targets.page, targets.igUserId, p.postId)));
      else if (p.platform === "threads" && targets.threads && threadsUsername) fetched.push(...(await fetchThreadsReplies(targets.threads.client, threadsUsername, p.postId)));
    } catch (e) {
      errors.push(`${p.platform} ${p.postId}: ${e instanceof Error ? e.message : e}`);
    }
  }
  const { all, added } = mergeComments(await loadComments(deps.dataDir), fetched);
  await saveComments(deps.dataDir, all);
  const note = `${added.length} bình luận mới từ ${published.length} bài, tổng ${all.length}`;
  return errors.length ? { status: "warn", note: `${note}. Lỗi: ${errors.join("; ")}` } : { note };
}

function chooseDirection(deps: PipelineDeps, run: Run, runs: Run[]) {
  const directionsFile = join(deps.dataDir, "directions.json");
  const picked: PickedByHand[] = existsSync(directionsFile) ? JSON.parse(readFileSync(directionsFile, "utf8")) : [];
  const comments: Comment[] = existsSync(join(deps.dataDir, "comments.json")) ? JSON.parse(readFileSync(join(deps.dataDir, "comments.json"), "utf8")) : [];
  let number = listEpisodes(deps.episodesDir).length + 1;
  const d = pickDirection({
    comments,
    picked,
    used: usedComments(runs),
    profiles: deps.studio.profiles,
    bible: deps.studio.bible,
    number,
    lead: deps.lead,
    manual: deps.direction,
  });
  while (readStep(`${d.lead}-ep-${pad(number)}`, "episode", deps.episodesDir)) number++;
  const id = `${d.lead}-ep-${pad(number)}`;
  createEpisode({ id, lead: d.lead, characters: d.characters, direction: d.text, credits: d.credits }, deps.episodesDir);
  run.episodeId = id;
  run.direction = d;
  const from = { dashboard: "ý đã chọn trên dashboard", comments: "bình luận được ủng hộ nhất", fallback: "chưa có bình luận, dùng hướng mặc định", manual: "hướng nhập tay" }[d.source];
  return { note: `${id}: ${from}. Chính: ${d.lead}${d.credits.length ? `. Ghi công: ${d.credits.map((c) => c.name).join(", ")}` : ""}` };
}

async function packageEpisode(deps: PipelineDeps, id: string, dir: string): Promise<PostFile> {
  const premise = readStep<Premise>(id, "premise", deps.episodesDir)!;
  const ep = readStep<EpisodeSpec>(id, "episode", deps.episodesDir)!;
  const letter = readStep<{ pages: { n: number; file: string }[] }>(id, "letter", deps.episodesDir)!;
  const number = listEpisodes(deps.episodesDir).indexOf(id) + 1;
  const n = Number(/-ep-(\d+)$/.exec(id)?.[1]) || number;

  // Instagram only takes JPEG for images; 1080x1350 is the 4:5 feed size.
  const out = join(dir, "motion", "carousel");
  mkdirSync(out, { recursive: true });
  const carousel: string[] = [];
  for (const page of [...letter.pages].sort((a, b) => a.n - b.n)) {
    const name = `${String(page.n).padStart(2, "0")}.jpg`;
    await ffmpeg(["-i", join(dir, page.file), "-vf", "scale=1080:1350:flags=lanczos,format=yuvj420p", "-q:v", "2", join(out, name)]);
    carousel.push(`motion/carousel/${name}`);
  }

  const post: PostFile = {
    episodeId: id,
    number: n,
    title: premise.title,
    lead: ep.lead,
    characters: ep.characters,
    captions: captions(premise, ep, { number: n, leadName: deps.studio.profiles.get(ep.lead)?.name }),
    media: { "reels-9x16": ["motion/reel.mp4"], "carousel-4x5": carousel },
    cover: "motion/cover.jpg",
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  writeFileSync(join(dir, "post.json"), JSON.stringify(post, null, 2) + "\n");
  return post;
}

const readPost = (dir: string) => JSON.parse(readFileSync(join(dir, "post.json"), "utf8")) as PostFile;

async function upload(deps: PipelineDeps, id: string, dir: string) {
  if (!deps.host) throw new Error("Chưa có chỗ để công khai video/ảnh: đặt MEDIA_DIR và MEDIA_BASE_URL (https) trong .env.");
  const post = readPost(dir);
  const plan = deps.plan ?? DEFAULT_PLAN;
  const urls: PostFile["urls"] = {};
  for (const { format } of plan) {
    urls[format] = [];
    for (const f of post.media[format] ?? []) {
      urls[format]!.push(await deps.host.put(join(dir, f), id, f.split("/").at(-1)));
    }
  }
  post.urls = urls;
  writeFileSync(join(dir, "post.json"), JSON.stringify(post, null, 2) + "\n");
  return { note: `${Object.values(urls).flat().length} tệp công khai` };
}

async function publish(deps: PipelineDeps, run: Run, id: string, dir: string): Promise<{ status?: StageStatus; note: string }> {
  if (!deps.channel?.brands.length) return { status: "skipped", note: "Chưa nối kênh nào (xem npm run channel -- brands)" };
  const post = readPost(dir);
  const journal = new FileJournal(journalPath(deps.dataDir));
  const setups = deps.channel.brands;
  // Hồi Sau gets every episode; a character's brand gets the episodes it leads (channels.yaml).
  const routes = routeEpisode(setups.map((b) => b.brand), { lead: post.lead, characters: post.characters });
  const results: PostRecord[] = [];
  const record = (r: PostRecord) => {
    results.push(r);
    const same = (p: PostRecord) => p.platform === r.platform && p.format === r.format && (p.brand ?? MAIN_BRAND) === (r.brand ?? MAIN_BRAND);
    run.posts = [...run.posts.filter((p) => !same(p)), r];
    saveRun(deps.dataDir, run);
  };

  for (const route of routes) {
    const setup = setups.find((b) => b.brand.id === route.brand.id)!;
    const brand = route.brand.id === MAIN_BRAND ? {} : { brand: route.brand.id };
    for (const { format, platforms } of deps.plan ?? DEFAULT_PLAN) {
      for (const platform of platforms.filter((p) => route.platforms.includes(p))) {
        const reason = setup.skipped.find((x) => x.platform === platform)?.reason;
        if (!setup.targets || !setup.platforms.includes(platform)) {
          record({ platform, format, ...brand, status: "skipped", error: reason ?? "chưa nối tài khoản" });
          continue;
        }
        const ep: EpisodePost = { episodeId: id, format, caption: post.captions.facebook, captions: post.captions, mediaUrls: post.urls?.[format] ?? [], lead: post.lead, characters: post.characters };
        try {
          const done = await publishEpisode(platform, ep, setup.targets, journal, { pollIntervalMs: deps.pollIntervalMs, brand: route.brand.id });
          record({ platform, format, ...brand, status: "published", postId: done.postId, permalink: done.permalink });
        } catch (e) {
          record({ platform, format, ...brand, status: "failed", error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
  }

  // The question as each brand's own first reply under its Threads post, once per run.
  const replyNotes: string[] = [];
  for (const r of results.filter((x) => x.platform === "threads" && x.status === "published" && x.postId)) {
    const brandId = r.brand ?? MAIN_BRAND;
    const setup = setups.find((b) => b.brand.id === brandId);
    const threads = setup?.targets?.threads;
    if (!threads || !post.captions.threadsReply || run.replies?.some((x) => x.brand === brandId)) continue;
    try {
      const reply = await replyOnThreads(threads.client, threads.userId, r.postId!, post.captions.threadsReply, { pollIntervalMs: deps.pollIntervalMs });
      run.replies = [...(run.replies ?? []), { brand: brandId, postId: reply.postId }];
      saveRun(deps.dataDir, run);
      replyNotes.push(`Đã trả lời câu hỏi dưới bài Threads của ${setup!.brand.name}`);
    } catch (e) {
      replyNotes.push(`Chưa trả lời được dưới bài Threads của ${setup!.brand.name} (cần quyền threads_manage_replies): ${e instanceof Error ? e.message : e}`);
    }
  }

  const ok = results.filter((r) => r.status === "published").length;
  const failed = results.filter((r) => r.status === "failed");
  const label = (r: PostRecord) => `${r.brand ?? MAIN_BRAND} ${r.platform} ${r.format}`;
  const note = [
    `Đăng ${ok}/${results.length} bài cho ${routes.map((r) => r.brand.name).join(", ") || "không brand nào"}`,
    ...(failed.length ? [`Lỗi: ${failed.map((f) => `${label(f)}: ${f.error}`).join("; ")}`] : []),
    ...replyNotes,
  ].join(". ");
  if (!ok && failed.length) throw new Error(note);
  return { status: failed.length ? "warn" : "done", note };
}
