/**
 * Video: short 9:16 clips made the way the Satank-style pilots were, from the
 * dashboard instead of the terminal. A sample clip (its voice and its cuts)
 * becomes one full-frame picture per shot of our own character, a second pose
 * on a still background, and optionally a mouth that moves with the voice
 * (`talk illustrate`, run step by step in the background).
 *
 * Nothing goes out until every shot has been looked at full size and ticked,
 * the video is newer than every picture, and the owner approves the caption.
 * Publishing then puts the video (and a still for Threads) on the public site
 * and posts it, now or at a set time.
 *
 * Each video is a folder under `dir`: clip.*, meta.json (the dashboard's own
 * notes), plan.json, words.json, shots/ and the rendered mp4s from talk.
 */

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import sharp from "sharp";
import { readApproval, type EpisodePost } from "@hoi-sau/channel";
import { approveVideo } from "@hoi-sau/studio";
import { t } from "./i18n.js";
import { button, esc, flash, layout } from "./views.js";

/** Runs one of the repo's scripts (relative to the repo root) and resolves with its output. */
export type Exec = (script: string, args: string[], log: (s: string) => void, env?: Record<string, string>) => Promise<string>;

export interface VideoOptions {
  /** One folder per video. */
  dir: string;
  /** Approvals live in <episodesDir>/v-<id>/, where `channel publish` checks them. */
  episodesDir: string;
  /** site/public/media: what the public site serves, so Instagram and Threads can fetch it. */
  siteMediaDir: string;
  /** Public URL of siteMediaDir. */
  mediaBase: string;
  /** Folders of sample clips to pick from (missing ones are skipped). */
  samplesDirs: string[];
  /** Characters to choose from: slug and display name. */
  cast: () => Array<{ slug: string; name: string }>;
  exec: Exec;
  /** Upload the site after copying the media; off in tests and demos. */
  deploy: boolean;
}

interface Meta {
  id: string;
  slug: string;
  clip: string;
  title: string;
  /** The lead's mouth moves with the voice. */
  mouth: boolean;
  createdAt: string;
  /** Shot id → signature of its pictures and plan entry when the owner ticked it. */
  checked: Record<string, string>;
  /** Per shot: why pose B was not kept; per picture: why it has no moving mouth. */
  stabilize: Record<string, { ok: boolean; problem: string }>;
  mouths: Record<string, { ok: boolean; problem?: string }>;
  caption?: string;
  threadsCaption?: string;
  /** Which render goes out. */
  version?: "mouth" | "plain";
  /** Pictures for the Threads still (one or two). */
  still?: string[];
  /** ISO time to publish at; empty publishes when the button is pressed. */
  when?: string;
  posted?: { at: string; log: string };
}

export interface Shot {
  id: string;
  t: number;
  act: string;
  pose: string;
  bubble: string;
  cast: string[];
  moving?: string[];
  src?: string;
}

interface Line {
  text: string;
  start: number;
  end: number;
}

interface Plan {
  slug: string;
  clip: string;
  end: number;
  lines: Line[];
  shots: Shot[];
}

interface Job {
  running: boolean;
  step?: string;
  error?: string;
}

const TALK = "packages/talk/dist/cli.js";
const CHANNEL = "packages/channel/dist/cli.js";
const SITE = "scripts/site.mjs";
const CLIP_TYPES = /\.(mp4|mov|m4v|webm)$/i;
/** Captions stay short; the owner's rule. */
export const CAPTION_MAX = 220;

/** Spawns `node <root>/<script> ...args` in the repo root; every output line goes to `log`. */
export function nodeExec(root: string): Exec {
  return (script, args, log, env) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, script), ...args], { cwd: root, env: { ...process.env, ...env } });
      let out = "";
      let tail: string[] = [];
      const take = (d: Buffer) => {
        const text = d.toString();
        out += text;
        for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
          log(line);
          tail = [...tail, line].slice(-6);
        }
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(tail.join("\n") || `${script} stopped (${code})`))));
    });
}

const stamp = (d = new Date()) => d.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
const sig = (files: string[]) => files.map((f) => (existsSync(f) ? `${statSync(f).size}:${Math.round(statSync(f).mtimeMs)}` : "-")).join("|");

export class Videos {
  readonly jobs = new Map<string, Job>();
  private timer?: NodeJS.Timeout;
  constructor(readonly opts: VideoOptions) {}

  folder = (id: string) => join(this.opts.dir, id);
  shotsDir = (id: string) => join(this.folder(id), "shots");

  list(): Meta[] {
    if (!existsSync(this.opts.dir)) return [];
    return readdirSync(this.opts.dir)
      .filter((id) => existsSync(join(this.opts.dir, id, "meta.json")))
      .map((id) => this.meta(id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  meta(id: string): Meta {
    if (!/^[a-z0-9-]+$/.test(id) || !existsSync(join(this.folder(id), "meta.json"))) throw new Error(t("Không thấy video này."));
    return { checked: {}, stabilize: {}, mouths: {}, ...JSON.parse(readFileSync(join(this.folder(id), "meta.json"), "utf8")) };
  }

  private save(m: Meta): void {
    writeFileSync(join(this.folder(m.id), "meta.json"), JSON.stringify(m, null, 2) + "\n");
  }

  plan(id: string): Plan | undefined {
    const f = join(this.folder(id), "plan.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Plan) : undefined;
  }

  private savePlan(id: string, plan: Plan): void {
    writeFileSync(join(this.folder(id), "plan.json"), JSON.stringify(plan, null, 2) + "\n");
  }

  /** Sample clips found in the sample folders, as [folder name, file name, full path]. */
  samples(): Array<{ label: string; path: string }> {
    return this.opts.samplesDirs
      .filter((d) => existsSync(d))
      .flatMap((d) => readdirSync(d).filter((f) => CLIP_TYPES.test(f)).map((f) => ({ label: `${basename(d)} / ${f}`, path: join(d, f) })));
  }

  /** A new video from a sample clip (a path from samples()) or uploaded bytes; starts listening and planning. */
  create(input: { slug: string; mouth: boolean; title?: string; sample?: string; upload?: { name: string; bytes: Uint8Array } }): string {
    if (!this.opts.cast().some((c) => c.slug === input.slug)) throw new Error(t("Chọn nhân vật chính."));
    let source: string | undefined;
    if (input.sample) {
      source = this.samples().find((s) => s.path === input.sample)?.path;
      if (!source) throw new Error(t("Không thấy clip mẫu này."));
    } else if (!input.upload?.bytes.length) throw new Error(t("Chọn một clip mẫu hoặc tải clip lên."));
    const ext = (extname(source ?? input.upload!.name) || ".mp4").toLowerCase();
    if (!CLIP_TYPES.test(ext)) throw new Error(t("Clip phải là video mp4, mov hoặc webm."));
    let id = `${input.slug}-${stamp()}`;
    for (let n = 2; existsSync(this.folder(id)); n++) id = `${input.slug}-${stamp()}-${n}`;
    mkdirSync(this.folder(id), { recursive: true });
    const clip = `clip${ext}`;
    if (source) copyFileSync(source, join(this.folder(id), clip));
    else writeFileSync(join(this.folder(id), clip), input.upload!.bytes);
    const title = (input.title ?? "").trim() || basename(source ?? input.upload!.name).replace(/\.\w+$/, "");
    this.save({ id, slug: input.slug, clip, title, mouth: input.mouth, createdAt: new Date().toISOString(), checked: {}, stabilize: {}, mouths: {} });
    this.continue(id);
    return id;
  }

  private talk(id: string, step: string, log: (s: string) => void, extra: string[] = []): Promise<string> {
    const m = this.meta(id);
    return this.opts.exec(TALK, ["illustrate", m.slug, join(this.folder(id), m.clip), "--out", this.folder(id), "--step", step, ...extra], log);
  }

  /** Reads what the last stabilize or mouths run wrote and keeps it per shot or picture. */
  private remember(id: string): void {
    const m = this.meta(id);
    const read = <T>(f: string): T[] => (existsSync(join(this.folder(id), f)) ? (JSON.parse(readFileSync(join(this.folder(id), f), "utf8")) as T[]) : []);
    for (const r of read<{ id: string; ok: boolean; problem: string }>("stabilize.json")) m.stabilize[r.id] = { ok: r.ok, problem: r.problem };
    for (const r of read<{ pic: string; ok: boolean; problem?: string }>("mouths.json")) m.mouths[r.pic] = { ok: r.ok, problem: r.problem };
    this.save(m);
    for (const f of ["stabilize.json", "mouths.json"]) rmSync(join(this.folder(id), f), { force: true });
  }

  private background(id: string, work: (log: (s: string) => void) => Promise<unknown>): void {
    if (this.jobs.get(id)?.running) throw new Error(t("Video này đang chạy."));
    const job: Job = { running: true };
    this.jobs.set(id, job);
    void (async () => {
      try {
        await work((s) => (job.step = s));
      } catch (e) {
        job.error = e instanceof Error ? e.message : String(e);
      } finally {
        job.running = false;
      }
    })();
  }

  /** Waits for a background run; for tests. */
  async settle(id: string): Promise<void> {
    while (this.jobs.get(id)?.running) await new Promise((r) => setTimeout(r, 10));
  }

  /** Every picture still missing, in order: plan, draw, second poses, still background, mouths. Never redoes what exists. */
  continue(id: string): void {
    this.background(id, async (log) => {
      if (!this.plan(id)) await this.talk(id, "plan", log);
      await this.talk(id, "draw", log);
      await this.talk(id, "poses", log);
      await this.fillGaps(id, log);
    });
  }

  /** Stabilize and mouths only where they have not run yet, so a picture that failed is not paid for twice. */
  private async fillGaps(id: string, log: (s: string) => void, onlyShots?: string[]): Promise<void> {
    const plan = this.plan(id)!;
    const dir = this.shotsDir(id);
    const shots = plan.shots.filter((s) => !s.src && (!onlyShots || onlyShots.includes(s.id)));
    const meta = this.meta(id);
    const toStabilize = shots.filter((s) => existsSync(join(dir, `${s.id}-b.png`)) && !existsSync(join(dir, `${s.id}-b2.png`)) && (onlyShots || !meta.stabilize[s.id])).map((s) => s.id);
    if (toStabilize.length) {
      await this.talk(id, "stabilize", log, ["--only", toStabilize.join(",")]);
      this.remember(id);
    }
    if (!meta.mouth) return;
    const after = this.meta(id);
    const pics = shots.flatMap((s) => [s.id, `${s.id}-b2`]).filter((p) => existsSync(join(dir, `${p}.png`)) && !existsSync(join(dir, `${p}-m.png`)) && (onlyShots || !after.mouths[p]));
    if (pics.length) {
      await this.talk(id, "mouths", log, ["--only", pics.join(",")]);
      this.remember(id);
    }
  }

  /** The files that make up one shot on screen, for the tick and for knowing the video is stale. */
  shotFiles(id: string, s: Shot): string[] {
    const d = this.shotsDir(id);
    return [s.id, `${s.id}-b2`].flatMap((p) => [`${p}.png`, `${p}-s.png`, `${p}-m.png`]).map((f) => join(d, f));
  }

  /** The lines heard during a shot, with their index in plan.lines. */
  shotLines(plan: Plan, s: Shot): Array<Line & { k: number }> {
    const end = plan.shots.find((x) => x.t > s.t)?.t ?? plan.end;
    return plan.lines.map((l, k) => ({ ...l, k })).filter((l) => l.start >= s.t - 0.15 && l.start < end - 0.15);
  }

  private shotSig(id: string, s: Shot, plan: Plan): string {
    return `${sig(this.shotFiles(id, s))}#${JSON.stringify([s.act, s.pose, s.bubble, this.shotLines(plan, s).map((l) => l.text)])}`;
  }

  isChecked(id: string, s: Shot, plan = this.plan(id)!, meta = this.meta(id)): boolean {
    return meta.checked[s.id] === this.shotSig(id, s, plan);
  }

  tick(id: string, shot: string): void {
    const plan = this.plan(id);
    const s = plan?.shots.find((x) => x.id === shot);
    if (!plan || !s) throw new Error(t("Không thấy cảnh này."));
    if (!existsSync(join(this.shotsDir(id), `${s.src ?? s.id}.png`))) throw new Error(t("Cảnh này chưa vẽ."));
    const m = this.meta(id);
    m.checked[s.id] = this.shotSig(id, s, plan);
    this.save(m);
  }

  /** New words for a shot (what it shows, the second pose, the bubble) and the lines heard in it. */
  editShot(id: string, shot: string, form: { act?: string; pose?: string; bubble?: string; lines?: Record<number, string> }): void {
    const plan = this.plan(id);
    const s = plan?.shots.find((x) => x.id === shot);
    if (!plan || !s) throw new Error(t("Không thấy cảnh này."));
    if (form.act !== undefined && form.act.trim()) s.act = form.act.trim();
    if (form.pose !== undefined) s.pose = form.pose.trim();
    if (form.bubble !== undefined) s.bubble = form.bubble.trim();
    for (const [k, text] of Object.entries(form.lines ?? {})) if (plan.lines[Number(k)] && text.trim()) plan.lines[Number(k)].text = text.trim();
    this.savePlan(id, plan);
  }

  private dropPictures(id: string, pics: string[], kinds: string[]): void {
    for (const p of pics) for (const k of kinds) rmSync(join(this.shotsDir(id), `${p}${k}.png`), { force: true });
  }

  /** Draws the whole shot again (both poses and mouths); `note` is added to what the shot shows. */
  redraw(id: string, shot: string, note = ""): void {
    const plan = this.plan(id);
    const s = plan?.shots.find((x) => x.id === shot && !x.src);
    if (!plan || !s) throw new Error(t("Không thấy cảnh này."));
    if (note.trim()) {
      s.act = `${s.act.replace(/\s*Fix: .*$/, "")} Fix: ${note.trim()}`;
      this.savePlan(id, plan);
    }
    this.forget(id, [s.id]);
    this.background(id, async (log) => {
      this.dropPictures(id, [s.id, `${s.id}-b`, `${s.id}-b2`], ["", "-s", "-m", "-s.raw", "-m.raw", "-mask"]);
      await this.talk(id, "draw", log, ["--only", s.id]);
      await this.talk(id, "poses", log, ["--only", s.id]);
      await this.fillGaps(id, log, [s.id]);
    });
  }

  /** Draws only the second pose again. */
  redrawPose(id: string, shot: string): void {
    const s = this.plan(id)?.shots.find((x) => x.id === shot && !x.src);
    if (!s?.pose) throw new Error(t("Cảnh này không có tư thế 2."));
    this.forget(id, [s.id]);
    this.background(id, async (log) => {
      this.dropPictures(id, [`${s.id}-b`, `${s.id}-b2`], ["", "-s", "-m", "-s.raw", "-m.raw"]);
      rmSync(join(this.shotsDir(id), `${s.id}-mask.png`), { force: true });
      await this.talk(id, "poses", log, ["--only", s.id]);
      await this.fillGaps(id, log, [s.id]);
    });
  }

  /** Keeps one pose: better than a second pose that does not paste cleanly. */
  onePose(id: string, shot: string): void {
    const plan = this.plan(id);
    const s = plan?.shots.find((x) => x.id === shot);
    if (!plan || !s) throw new Error(t("Không thấy cảnh này."));
    s.pose = "";
    this.savePlan(id, plan);
    this.dropPictures(id, [`${s.id}-b`, `${s.id}-b2`], ["", "-s", "-m", "-s.raw", "-m.raw", "-mask"]);
  }

  /** The picture keeps its mouth as drawn. */
  noMouth(id: string, shot: string): void {
    const m = this.meta(id);
    for (const p of [shot, `${shot}-b2`]) {
      this.dropPictures(id, [p], ["-s", "-m"]);
      m.mouths[p] = { ok: false, problem: "turned off by hand" };
    }
    this.save(m);
  }

  private forget(id: string, shots: string[]): void {
    const m = this.meta(id);
    for (const s of shots) {
      delete m.stabilize[s];
      delete m.mouths[s];
      delete m.mouths[`${s}-b2`];
    }
    this.save(m);
  }

  videoFile(id: string, version: "mouth" | "plain"): string {
    return join(this.folder(id), `${this.meta(id).slug}${version === "mouth" ? "-mouth" : ""}.mp4`);
  }

  /** The render is older than a picture or the plan: render again before it can go out. */
  stale(id: string, version: "mouth" | "plain"): boolean {
    const v = this.videoFile(id, version);
    if (!existsSync(v)) return true;
    const plan = this.plan(id);
    if (!plan) return true;
    const newest = Math.max(statSync(join(this.folder(id), "plan.json")).mtimeMs, ...plan.shots.flatMap((s) => this.shotFiles(id, s)).filter(existsSync).map((f) => statSync(f).mtimeMs));
    return statSync(v).mtimeMs < newest;
  }

  render(id: string): void {
    const m = this.meta(id);
    if (!this.plan(id)) throw new Error(t("Chưa có kế hoạch cảnh."));
    this.background(id, async (log) => {
      await this.talk(id, "render", log);
      if (m.mouth) await this.talk(id, "render", log, ["--mouth"]);
    });
  }

  /** Shots not ticked yet, by id. */
  unchecked(id: string): string[] {
    const plan = this.plan(id);
    if (!plan) return [];
    const meta = this.meta(id);
    return plan.shots.filter((s) => !s.src && !this.isChecked(id, s, plan, meta)).map((s) => s.id);
  }

  epId = (id: string) => `v-${id}`;

  /**
   * The owner's sign-off: every shot ticked, a fresh render, a short caption.
   * Copies the video (and the Threads still) to the site, writes the posts and approves them.
   */
  async approve(id: string, form: { caption: string; threadsCaption?: string; version: "mouth" | "plain"; still: string[]; when?: string }): Promise<void> {
    const m = this.meta(id);
    const left = this.unchecked(id);
    if (left.length) throw new Error(t("Còn {n} cảnh chưa soát: {list}.", { n: left.length, list: left.join(", ") }));
    if (this.stale(id, form.version)) throw new Error(t("Video chưa dựng hoặc cũ hơn tranh. Bấm Dựng video trước."));
    const caption = form.caption.trim();
    if (!caption) throw new Error(t("Viết chú thích."));
    if (caption.length > CAPTION_MAX || (form.threadsCaption ?? "").length > CAPTION_MAX) throw new Error(t("Chú thích dài quá, tối đa {n} ký tự.", { n: CAPTION_MAX }));
    const when = form.when?.trim() ? new Date(form.when).toISOString() : undefined;
    const ep = this.epId(id);
    const media = join(this.opts.siteMediaDir, ep);
    mkdirSync(media, { recursive: true });
    copyFileSync(this.videoFile(id, form.version), join(media, "video.mp4"));
    const videoPost: EpisodePost = { episodeId: ep, format: "reels-9x16", caption, mediaUrls: [`${this.opts.mediaBase}${ep}/video.mp4`] };
    const postFile = join(this.opts.episodesDir, ep, "post.json");
    mkdirSync(join(this.opts.episodesDir, ep), { recursive: true });
    writeFileSync(postFile, JSON.stringify(videoPost, null, 2) + "\n");
    approveVideo(ep, this.videoFile(id, form.version), postFile, { dir: this.opts.episodesDir });

    const still = form.still.filter((p) => existsSync(join(this.shotsDir(id), `${p}.png`))).slice(0, 2);
    if (still.length) {
      const sep = join(this.opts.siteMediaDir, `${ep}-still`);
      mkdirSync(sep, { recursive: true });
      const jpg = join(sep, "still.jpg");
      await writeStill(still.map((p) => join(this.shotsDir(id), `${p}.png`)), jpg);
      const stillPost: EpisodePost = { episodeId: `${ep}-still`, format: "image-4x5", caption: (form.threadsCaption ?? "").trim() || caption, mediaUrls: [`${this.opts.mediaBase}${ep}-still/still.jpg`] };
      const stillFile = join(this.opts.episodesDir, `${ep}-still`, "post.json");
      mkdirSync(join(this.opts.episodesDir, `${ep}-still`), { recursive: true });
      writeFileSync(stillFile, JSON.stringify(stillPost, null, 2) + "\n");
      approveVideo(`${ep}-still`, jpg, stillFile, { dir: this.opts.episodesDir });
    }
    Object.assign(m, { caption, threadsCaption: form.threadsCaption?.trim() || undefined, version: form.version, still, when });
    delete m.posted;
    this.save(m);
    if (this.opts.deploy) this.background(id, (log) => this.opts.exec(SITE, ["deploy"], log));
  }

  approved(id: string): boolean {
    return Boolean(readApproval(join(this.opts.episodesDir, this.epId(id))));
  }

  /** Posts the approved video: Reels on Facebook and Instagram, the TikTok inbox, and Threads (the still, when there is one). */
  publish(id: string): void {
    if (!this.approved(id)) throw new Error(t("Duyệt video trước khi đăng."));
    const m = this.meta(id);
    if (m.posted) throw new Error(t("Video này đã đăng."));
    const ep = this.epId(id);
    const env = { EPISODES_DIR: this.opts.episodesDir };
    this.background(id, async (log) => {
      const hasStill = Boolean(m.still?.length) && existsSync(join(this.opts.episodesDir, `${ep}-still`, "post.json"));
      let out = await this.opts.exec(CHANNEL, ["publish", join(this.opts.episodesDir, ep, "post.json"), "facebook", "instagram", "tiktok", ...(hasStill ? [] : ["threads"])], log, env);
      if (hasStill) out += await this.opts.exec(CHANNEL, ["publish", join(this.opts.episodesDir, `${ep}-still`, "post.json"), "threads"], log, env);
      const mm = this.meta(id);
      mm.posted = { at: new Date().toISOString(), log: out.trim() };
      this.save(mm);
    });
  }

  /** Publishes what is approved and due; the dashboard calls this every half minute. */
  due(now = new Date()): string[] {
    const started: string[] = [];
    for (const m of this.list()) {
      if (!m.when || m.posted || Date.parse(m.when) > now.getTime() || this.jobs.get(m.id)?.running || this.jobs.get(m.id)?.error || !this.approved(m.id)) continue;
      this.publish(m.id);
      started.push(m.id);
    }
    return started;
  }

  start(): void {
    this.timer ??= setInterval(() => {
      try {
        this.due();
      } catch {
        // a broken folder must not stop the clock
      }
    }, 30_000);
    this.timer.unref();
  }
}

/** One picture cropped to 4:5, or two side by side, as the JPEG Threads gets. */
export async function writeStill(pics: string[], out: string): Promise<void> {
  const W = 1080, H = 1350;
  const w = Math.round(W / pics.length);
  const parts = await Promise.all(pics.map((p) => sharp(p).resize(w, H, { fit: "cover", position: "centre" }).toBuffer()));
  await sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } })
    .composite(parts.map((input, i) => ({ input, left: i * w, top: 0 })))
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(out);
}

// ------------------------------------------------------------------ pages

const img = (id: string, file: string, cls = "") => `<a href="/video-media/${esc(id)}/shots/${esc(file)}" target="_blank"><img class="${cls}" src="/video-media/${esc(id)}/shots/${esc(file)}" alt="" loading="lazy"></a>`;
const when = (iso: string) => new Date(iso).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

function stepsOf(v: Videos, m: Meta): Array<[string, boolean]> {
  const plan = v.plan(m.id);
  const shots = plan?.shots.filter((s) => !s.src) ?? [];
  const has = (f: string) => existsSync(join(v.shotsDir(m.id), f));
  return [
    [t("Chia cảnh"), Boolean(plan)],
    [t("Vẽ"), shots.length > 0 && shots.every((s) => has(`${s.id}.png`))],
    [t("Tư thế 2"), shots.length > 0 && shots.every((s) => !s.pose || has(`${s.id}-b2.png`) || m.stabilize[s.id])],
    ...(m.mouth ? [[t("Nhép miệng"), shots.length > 0 && shots.every((s) => [s.id, `${s.id}-b2`].every((p) => !has(`${p}.png`) || has(`${p}-m.png`) || m.mouths[p]))] as [string, boolean]] : []),
    [t("Soát từng cảnh"), Boolean(plan) && v.unchecked(m.id).length === 0],
    [t("Dựng video"), !v.stale(m.id, m.mouth ? "mouth" : "plain")],
    [t("Duyệt"), v.approved(m.id)],
    [t("Đăng"), Boolean(m.posted)],
  ];
}

const stepBar = (steps: Array<[string, boolean]>) => `<ol class="vsteps">${steps.map(([n, d]) => `<li class="${d ? "done" : ""}">${d ? "✓ " : ""}${esc(n)}</li>`).join("")}</ol>`;

export function videosPage(v: Videos, err?: string, ok?: string): string {
  const cast = v.opts.cast();
  const samples = v.samples();
  const cards = v
    .list()
    .map((m) => {
      const cover = existsSync(join(v.shotsDir(m.id), "s01.png")) ? `<img src="/video-media/${esc(m.id)}/shots/s01.png" alt="" loading="lazy">` : `<div class="vthumb-empty">▶</div>`;
      const job = v.jobs.get(m.id);
      const done = stepsOf(v, m);
      const next = done.find(([, d]) => !d)?.[0];
      return `<a class="card vcard" href="/video/${esc(m.id)}">${cover}<div><b>${esc(m.title)}</b><p class="muted small">${esc(cast.find((c) => c.slug === m.slug)?.name ?? m.slug)} · ${esc(when(m.createdAt))}</p>${job?.running ? `<span class="tag due"><span class="spinner"></span>${esc(t("đang chạy…"))}</span>` : `<span class="tag">${esc(next ? t("Tiếp: {s}", { s: next }) : t("Đã đăng"))}</span>`}</div></a>`;
    })
    .join("");
  const form = `<section class="card"><h2>${esc(t("Làm video mới"))}</h2>
<form class="form" method="post" action="/video/new" enctype="multipart/form-data">
<label>${esc(t("Kiểu video"))}<select name="kind"><option value="illustrate">${esc(t("Tranh minh hoạ theo lời (2 tư thế, nền đứng yên)"))}</option></select></label>
<div class="row"><label>${esc(t("Clip mẫu"))}<select name="sample"><option value="">${esc(t("— tải clip lên ở dưới —"))}</option>${samples.map((s) => `<option value="${esc(s.path)}">${esc(s.label)}</option>`).join("")}</select></label>
<label>${esc(t("Hoặc tải clip lên"))}<input type="file" name="clip" accept="video/*"></label></div>
<div class="row"><label>${esc(t("Nhân vật chính"))}<select name="slug">${cast.map((c) => `<option value="${esc(c.slug)}"${c.slug === "cu-li" ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
<label>${esc(t("Tên video"))}<input name="title" placeholder="${esc(t("vd: Lương và deadline"))}"></label></div>
<label class="check"><input type="checkbox" name="mouth" value="1" checked> ${esc(t("Nhép miệng theo lời"))}</label>
<p class="muted small">${esc(t("Giữ tiếng và nhịp cắt của clip mẫu. Máy tự chia cảnh, vẽ, vẽ tư thế 2 và miệng. Anh soát từng cảnh rồi mới dựng và đăng."))}</p>
<button class="btn on">${esc(t("Bắt đầu"))}</button></form></section>`;
  return layout(t("Video"), "/video", `<header class="head"><h1>${esc(t("Video"))}</h1></header>${flash(ok, err)}${form}${cards ? `<div class="vgrid">${cards}</div>` : `<p class="muted">${esc(t("Chưa có video nào."))}</p>`}`);
}

function shotCard(v: Videos, m: Meta, plan: Plan, s: Shot, busy: boolean): string {
  const id = m.id;
  const has = (f: string) => existsSync(join(v.shotsDir(id), f));
  const end = plan.shots.find((x) => x.t > s.t)?.t ?? plan.end;
  const lines = v.shotLines(plan, s);
  const checked = v.isChecked(id, s, plan, m);
  if (s.src) return `<div class="card vshot src"><b>${esc(s.id)}</b> · ${s.t.toFixed(1)}s <span class="muted">${esc(t("dùng lại tranh {src}", { src: s.src }))}</span></div>`;
  const pics: string[] = [];
  if (has(`${s.id}.png`)) pics.push(`<figure>${img(id, `${s.id}.png`)}<figcaption>${esc(t("Tư thế 1"))}</figcaption></figure>`);
  else pics.push(`<figure class="empty">${esc(t("chưa vẽ"))}</figure>`);
  if (has(`${s.id}-b2.png`)) pics.push(`<figure>${img(id, `${s.id}-b2.png`)}<figcaption>${esc(t("Tư thế 2"))}</figcaption></figure>`);
  else if (s.pose && (has(`${s.id}-b.png`) || m.stabilize[s.id])) pics.push(`<figure class="empty warnfig">${has(`${s.id}-b.png`) ? img(id, `${s.id}-b.png`, "faded") : ""}<figcaption>${esc(t("Tư thế 2 ghép không sạch, video dùng 1 tư thế"))}</figcaption></figure>`);
  if (m.mouth)
    for (const p of [s.id, `${s.id}-b2`].filter((p) => has(`${p}.png`))) {
      if (has(`${p}-m.png`)) pics.push(`<figure class="mouth">${img(id, `${p}-s.png`)}${img(id, `${p}-m.png`)}<figcaption>${esc(t("Miệng ngậm / há"))}</figcaption></figure>`);
      else if (m.mouths[p]) pics.push(`<figure class="empty"><figcaption>${esc(t("Không nhép: {why}", { why: m.mouths[p].problem ?? "" }))}</figcaption></figure>`);
    }
  const actions = busy
    ? ""
    : `<div class="vactions">${checked ? `<span class="tag ok">✓ ${esc(t("Đã soát"))}</span>` : has(`${s.id}.png`) ? button(`/video/${id}/shot/${s.id}/ok`, `✓ ${esc(t("Đã soát cỡ thật, ổn"))}`, "btn on") : ""}
<form class="inline" method="post" action="/video/${esc(id)}/shot/${esc(s.id)}/redraw"><input name="note" placeholder="${esc(t("Lỗi gì? vd: thừa một bàn tay"))}"><button class="btn">${esc(t("Vẽ lại cảnh"))}</button></form>
${s.pose ? button(`/video/${id}/shot/${s.id}/repose`, esc(t("Vẽ lại tư thế 2"))) + button(`/video/${id}/shot/${s.id}/onepose`, esc(t("Giữ 1 tư thế"))) : ""}
${m.mouth && (has(`${s.id}-m.png`) || has(`${s.id}-b2-m.png`)) ? button(`/video/${id}/shot/${s.id}/nomouth`, esc(t("Bỏ nhép"))) : ""}</div>`;
  const edit = `<details><summary>${esc(t("Sửa lời, bong bóng, mô tả cảnh"))}</summary><form class="form" method="post" action="/video/${esc(id)}/shot/${esc(s.id)}/edit">
${lines.map((l) => `<label>${esc(t("Lời {a}–{b}s", { a: l.start.toFixed(1), b: l.end.toFixed(1) }))}<input name="line-${l.k}" value="${esc(l.text)}"></label>`).join("")}
<label>${esc(t("Bong bóng (ngắn, ≤12 chữ)"))}<input name="bubble" value="${esc(s.bubble)}"></label>
<label>${esc(t("Cảnh vẽ gì (tiếng Anh cho Muse Image)"))}<textarea name="act" rows="3">${esc(s.act)}</textarea></label>
<label>${esc(t("Tư thế 2 (để trống: chỉ 1 tư thế)"))}<input name="pose" value="${esc(s.pose)}"></label>
<button class="btn">${esc(t("Lưu"))}</button><p class="muted small">${esc(t("Sửa mô tả cảnh xong bấm Vẽ lại cảnh. Sửa lời hay bong bóng chỉ cần Dựng lại."))}</p></form></details>`;
  return `<div class="card vshot${checked ? " checked" : ""}" id="${esc(s.id)}"><div class="vshot-head"><b>${esc(s.id)}</b> · ${s.t.toFixed(1)}–${end.toFixed(1)}s ${s.bubble ? `<span class="bubble-text">💬 ${esc(s.bubble)}</span>` : ""}</div>
<p class="vlines">${lines.map((l) => esc(l.text)).join(" ")}</p><div class="vpics">${pics.join("")}</div>${actions}${edit}</div>`;
}

export function videoPage(v: Videos, id: string, err?: string, ok?: string): string | undefined {
  let m: Meta;
  try {
    m = v.meta(id);
  } catch {
    return undefined;
  }
  const plan = v.plan(id);
  const job = v.jobs.get(id);
  const busy = Boolean(job?.running);
  const bar = busy
    ? `<div class="notice"><span class="spinner"></span><b>${esc(t("Đang chạy"))}:</b> ${esc(job!.step ?? t("bắt đầu…"))}</div><meta http-equiv="refresh" content="3">`
    : `${job?.error ? `<div class="warn small">${esc(t("Lần chạy trước dừng lại"))}: ${esc(job.error)}</div>` : ""}${flash(ok, err)}`;
  const left = v.unchecked(id);
  const version: "mouth" | "plain" = m.version ?? (m.mouth ? "mouth" : "plain");
  const videos = (["mouth", "plain"] as const)
    .filter((k) => (k === "mouth" ? m.mouth : true) && existsSync(v.videoFile(id, k)))
    .map((k) => `<figure class="vvideo"><video controls preload="metadata" playsinline src="/video-media/${esc(id)}/${esc(basename(v.videoFile(id, k)))}"></video><figcaption>${esc(k === "mouth" ? t("Có nhép miệng") : t("Không nhép"))}${v.stale(id, k) ? ` · <b class="warn-text">${esc(t("cũ hơn tranh, dựng lại"))}</b>` : ""}</figcaption></figure>`)
    .join("");
  const tools = busy
    ? ""
    : `<div class="vactions">${button(`/video/${id}/continue`, esc(t("Vẽ tiếp phần còn thiếu")))}${plan ? button(`/video/${id}/render`, esc(t("Dựng video")), left.length ? "btn" : "btn on") : ""}</div>`;
  const shots = plan ? plan.shots.map((s) => shotCard(v, m, plan, s, busy)).join("") : "";
  const stillChoices = plan
    ? plan.shots
        .filter((s) => !s.src)
        .flatMap((s) => [`${s.id}`, `${s.id}-b2`])
        .filter((p) => existsSync(join(v.shotsDir(id), `${p}.png`)))
        .map((p) => `<label class="vstill"><input type="checkbox" name="still" value="${esc(p)}"${m.still?.includes(p) ? " checked" : ""}><img src="/video-media/${esc(id)}/shots/${esc(p)}.png" alt="${esc(p)}" loading="lazy"></label>`)
        .join("")
    : "";
  const approved = v.approved(id);
  const publish = m.posted
    ? `<div class="notice ok-note">${esc(t("Đã đăng lúc {at}", { at: when(m.posted.at) }))}</div><pre class="small">${esc(m.posted.log)}</pre>`
    : approved && !busy
      ? `<div class="vactions">${button(`/video/${id}/publish`, esc(t("Đăng ngay")), "btn on")}${m.when ? `<span class="tag due">${esc(t("Hẹn đăng {at}", { at: when(m.when) }))}</span>` : ""}</div>`
      : "";
  const approve = `<section class="card" id="approve"><h2>${esc(t("Duyệt và đăng"))}</h2>${left.length ? `<div class="warn small">${esc(t("Còn {n} cảnh chưa soát: {list}.", { n: left.length, list: left.join(", ") }))}</div>` : ""}
<form class="form" method="post" action="/video/${esc(id)}/approve">
<label>${esc(t("Chú thích (ngắn, tối đa 5 hashtag không dấu)"))}<textarea name="caption" rows="2" maxlength="${CAPTION_MAX}">${esc(m.caption ?? "")}</textarea></label>
<div class="row"><label>${esc(t("Bản đăng"))}<select name="version">${m.mouth ? `<option value="mouth"${version === "mouth" ? " selected" : ""}>${esc(t("Có nhép miệng"))}</option>` : ""}<option value="plain"${version === "plain" ? " selected" : ""}>${esc(t("Không nhép"))}</option></select></label>
<label>${esc(t("Hẹn giờ đăng (giờ máy này; để trống để đăng tay)"))}<input type="datetime-local" name="when" value="${esc(m.when ? new Date(Date.parse(m.when) - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "")}"></label></div>
<label>${esc(t("Threads: ảnh thay video (chọn 1–2 tranh; bỏ trống thì Threads đăng video)"))}</label><div class="vstills">${stillChoices}</div>
<label>${esc(t("Chú thích Threads (một câu hỏi, 1 thẻ chủ đề)"))}<input name="threadsCaption" maxlength="${CAPTION_MAX}" value="${esc(m.threadsCaption ?? "")}"></label>
<button class="btn on"${busy ? " disabled" : ""}>${esc(approved ? t("Duyệt lại") : t("Duyệt"))}</button>
<p class="muted small">${esc(t("Duyệt chỉ nhận khi mọi cảnh đã soát và video mới hơn tranh. Đăng Reels lên Facebook và Instagram, gửi nháp TikTok, Threads đăng ảnh hoặc video."))}</p></form>${publish}</section>`;
  const body = `<header class="head"><a class="muted" href="/video">← ${esc(t("Video"))}</a><h1>${esc(m.title)}</h1></header>${bar}${stepBar(stepsOf(v, m))}
${videos ? `<section class="card"><div class="vvideos">${videos}</div></section>` : ""}${tools}
${plan ? `<h2>${esc(t("Soát từng cảnh ở cỡ thật"))}</h2><p class="muted small">${esc(t("Bấm vào tranh để xem cỡ thật. Soi mặt, tay, đồ vật, chữ, đồng hồ, và nền giữa 2 tư thế."))}</p>${shots}` : `<p class="muted">${esc(t("Đang nghe lời và chia cảnh…"))}</p>`}
${plan ? approve : ""}`;
  return layout(m.title, "/video", body);
}

// ------------------------------------------------------------------ demo

/**
 * Stands in for talk, channel and site in the demo and tests: a three-shot
 * plan, plain placeholder pictures, a second pose that does not paste on
 * s02 and a mouth that is not found on s02, a short render, fake post links.
 */
export function mockExec(): Exec {
  const picture = (file: string, label: string, hue: number) =>
    sharp({ create: { width: 1080, height: 1920, channels: 3, background: `hsl(${hue}, 45%, 82%)` } })
      .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><circle cx="540" cy="900" r="260" fill="hsl(${hue}, 40%, 55%)"/><text x="540" y="1400" font-size="90" text-anchor="middle" font-family="sans-serif" fill="#333">${label}</text></svg>`) }])
      .png()
      .toFile(file);
  return async (script, args, log) => {
    if (script === SITE) return "deployed";
    if (script === CHANNEL) {
      const platforms = args.slice(2);
      return platforms.map((p) => `hoi-sau ${p}: https://example.com/${p}/demo-post`).join("\n") + "\n";
    }
    const [, slug, , , out, , step] = args;
    const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : undefined;
    const dir = join(out, "shots");
    mkdirSync(dir, { recursive: true });
    const planFile = join(out, "plan.json");
    if (step === "plan") {
      const lines = [
        { text: "Sáng thứ Hai vào làm", start: 0.2, end: 1.8 },
        { text: "sếp giao thêm ba việc", start: 2.1, end: 3.9 },
        { text: "chiều về vẫn chưa xong", start: 4.2, end: 5.8 },
      ];
      const shots: Shot[] = [
        { id: "s01", t: 0, act: "the lead arrives at the office desk, sleepy", pose: "yawns with both arms up", bubble: "Thứ Hai rồi…", cast: [] },
        { id: "s02", t: 2, act: "the boss drops three folders on the desk", pose: "the lead's eyes go wide", bubble: "Ba việc nữa?!", cast: [] },
        { id: "s03", t: 4, act: "the lead slumped over the desk at sunset", pose: "", bubble: "", cast: [] },
      ];
      writeFileSync(planFile, JSON.stringify({ slug, clip: args[2], end: 6, lines, shots }, null, 2) + "\n");
      writeFileSync(join(out, "words.json"), "[]\n");
      log("3 lines, 3 shots");
      return "";
    }
    const plan = JSON.parse(readFileSync(planFile, "utf8")) as Plan;
    const pick = (s: Shot, pic = s.id) => !s.src && (!only || only.includes(s.id) || only.includes(pic));
    const hue = (i: number) => 30 + i * 70;
    if (step === "draw")
      for (const [i, s] of plan.shots.entries()) if (pick(s) && (only || !existsSync(join(dir, `${s.id}.png`)))) (log(`${s.id}: drawing`), await picture(join(dir, `${s.id}.png`), `${s.id} A`, hue(i)));
    if (step === "poses")
      for (const [i, s] of plan.shots.entries()) if (s.pose && pick(s) && (only || !existsSync(join(dir, `${s.id}-b.png`)))) (log(`${s.id}: second pose`), await picture(join(dir, `${s.id}-b.png`), `${s.id} B`, hue(i) + 20));
    if (step === "stabilize") {
      const report = [];
      for (const s of plan.shots.filter((x) => pick(x) && existsSync(join(dir, `${x.id}-b.png`)))) {
        const ok = s.id !== "s02";
        if (ok) copyFileSync(join(dir, `${s.id}-b.png`), join(dir, `${s.id}-b2.png`));
        report.push({ id: s.id, ok, problem: ok ? "" : "ghost of pose A left behind", tries: 1 });
      }
      writeFileSync(join(out, "stabilize.json"), JSON.stringify(report));
    }
    if (step === "mouths") {
      const report = [];
      for (const s of plan.shots)
        for (const pic of [s.id, `${s.id}-b2`]) {
          if (!pick(s, pic) || !existsSync(join(dir, `${pic}.png`))) continue;
          if (s.id === "s02") {
            report.push({ pic, ok: false, problem: "no mouth found" });
            continue;
          }
          copyFileSync(join(dir, `${pic}.png`), join(dir, `${pic}-s.png`));
          copyFileSync(join(dir, `${pic}.png`), join(dir, `${pic}-m.png`));
          report.push({ pic, ok: true });
        }
      writeFileSync(join(out, "mouths.json"), JSON.stringify(report));
    }
    if (step === "render") {
      const video = join(out, `${slug}${args.includes("--mouth") ? "-mouth" : ""}.mp4`);
      const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-loop", "1", "-t", "2", "-i", join(dir, "s01.png"), "-vf", "scale=540:960,format=yuv420p", "-r", "15", video]);
      if (made.status !== 0) writeFileSync(video, "demo video");
      log(video);
    }
    return "";
  };
}
