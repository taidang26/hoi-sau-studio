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
 * A text meme is the other kind: no sample clip, two lines of text typed by
 * the owner, one or two pictures and MusicGen music (`talk meme`). It goes
 * through the same drawing, ticking and approval.
 *
 * Approving also makes the TikTok cover (`talk cover`) when a cover line is
 * given, and rebuilds the owner's download page (`studio tai`).
 *
 * Each video is a folder under `dir`: clip.* or meme.json, meta.json (the
 * dashboard's own notes), plan.json, words.json, shots/ and the rendered mp4s.
 */

import { phoneBox } from "./phone.js";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import sharp from "sharp";
import { readApproval, type EpisodePost } from "@hoi-sau/channel";
import { approveVideo, CHARACTERS_DIR, SERIES_DIR } from "@hoi-sau/studio";
import { t } from "./i18n.js";
import { button, esc, flash, layout } from "./views.js";
import { IdeaStock, stockLink } from "./kho.js";
import { ReadyMade, readyLink } from "./kits.js";

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
  /** Where the characters and the series live (the ready-made pictures are kept there). */
  charactersDir?: string;
  seriesDir?: string;
  /** Upload the site after copying the media; off in tests and demos. */
  deploy: boolean;
  /** Downloads for the stock of ideas (scraped picture links); fetch by default. */
  fetch?: (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
}

export type VideoKind = "illustrate" | "meme";

/** What the owner types for a text meme (talk's MemeSpec). */
export interface MemeInput {
  top: string;
  punch: string;
  scenes: string[];
  music: string;
  seconds: number;
  /** An occasion (Tết, Noel...): the lead wears that season's outfit. */
  season?: string;
}

interface Meta {
  id: string;
  /** Missing on videos made before text memes: illustrate. */
  kind?: VideoKind;
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
  /** The TikTok cover's line ("line|line *key*"), and what went wrong making it. */
  cover?: string;
  coverProblem?: string;
  /** Per shot: share of the frame's edge that differs between the two poses (0–1); high means the picture shifted. */
  drift?: Record<string, number>;
  ask?: Ask;
  done?: Done;
  refused?: Refused;
}

/** What Muse Spark proposes to make from text or pictures (talk's IdeaPlan). */
export interface IdeaPlan {
  kind: "meme" | "comic";
  reply: string;
  read: string;
  lead: string;
  meme: { top: string; punch: string; scenes: string[] };
  comic: { direction: string; with: string[]; headline?: string };
  title: string;
  caption?: string;
}

/** One edit Muse Spark proposes from the owner's note (talk's FixAction). */
export interface FixAction {
  do: "line_text" | "line_time" | "add_line" | "drop_line" | "bubble" | "fix_detail" | "redraw" | "add_shot" | "redo_pose" | "one_pose" | "no_mouth";
  shot: string;
  line: number;
  text: string;
  start: number;
  end: number;
  what: string;
  find: string;
  say: string;
}

/** The owner's note and what the machine proposes for it, waiting for "Làm". */
interface Ask {
  note: string;
  at?: number;
  reply: string;
  actions: FixAction[];
}

/** The last applied fix, kept until the owner keeps it or goes back. */
interface Done {
  note: string;
  says: string[];
  /** Pictures that changed or were added, with the share of pose A that changed (1 for a new shot). */
  changed: Record<string, number>;
  /** Shots whose detail fix was meant to touch one thing only. */
  detail: string[];
  /** Why the run stopped partway, when it did: the owner can still go back. */
  failed?: string;
}

/** A fix where nothing could be done: the video is as it was, the owner reads why and writes again. */
interface Refused {
  note: string;
  why: string;
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
const STUDIO = "packages/studio/dist/cli.js";
/** Above this share of changed edge pixels the second pose has moved the room. */
export const DRIFT_WARN = 0.2;
export const MEME_MUSIC = "light playful lo-fi office background music, soft marimba and pizzicato, no vocals";
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
  /** Kho ý: scraped posts waiting to be read into text memes. */
  readonly stock: IdeaStock;
  readonly ready: ReadyMade;
  constructor(readonly opts: VideoOptions) {
    this.stock = new IdeaStock(this, opts.fetch);
    this.ready = new ReadyMade({ charactersDir: () => opts.charactersDir ?? CHARACTERS_DIR, seriesDir: () => opts.seriesDir ?? SERIES_DIR, exec: opts.exec, cast: opts.cast });
  }

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
  create(input: { kind?: VideoKind; slug: string; mouth: boolean; title?: string; sample?: string; upload?: { name: string; bytes: Uint8Array }; meme?: MemeInput; caption?: string }): string {
    if (!this.opts.cast().some((c) => c.slug === input.slug)) throw new Error(t("Chọn nhân vật chính."));
    if (input.kind === "meme") {
      const id = this.createMeme(input.slug, input.title ?? "", input.meme);
      if (input.caption?.trim()) {
        const m = this.meta(id);
        m.caption = input.caption.trim().slice(0, CAPTION_MAX);
        this.save(m);
      }
      return id;
    }
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

  /** A text meme: the words and scene notes go to meme.json, then planning and drawing start. */
  private createMeme(slug: string, title: string, meme?: MemeInput): string {
    const spec: MemeInput = {
      top: (meme?.top ?? "").trim(),
      punch: (meme?.punch ?? "").trim(),
      scenes: (meme?.scenes ?? [""]).map((s) => s.trim()).slice(0, 2),
      music: (meme?.music ?? "").trim(),
      seconds: Number(meme?.seconds) || 0,
    };
    if (!spec.scenes.length) spec.scenes = [""];
    if (!spec.top) throw new Error(t("Viết dòng chữ 1."));
    if (!spec.punch) throw new Error(t("Viết dòng chữ 2 (câu chốt)."));
    if (spec.top.length > 90 || spec.punch.length > 90) throw new Error(t("Mỗi dòng chữ tối đa {n} ký tự.", { n: 90 }));
    if (spec.seconds && (spec.seconds < 6 || spec.seconds > 20)) throw new Error(t("Độ dài từ 6 đến 20 giây, hoặc để trống cho máy tự tính."));
    let id = `${slug}-${stamp()}`;
    for (let n = 2; existsSync(this.folder(id)); n++) id = `${slug}-${stamp()}-${n}`;
    mkdirSync(this.folder(id), { recursive: true });
    writeFileSync(join(this.folder(id), "meme.json"), JSON.stringify(spec, null, 2) + "\n");
    this.save({ id, kind: "meme", slug, clip: "", title: title.trim() || spec.top.slice(0, 40), mouth: false, createdAt: new Date().toISOString(), checked: {}, stabilize: {}, mouths: {}, cover: `${spec.top}|*${spec.punch}*` });
    this.continue(id);
    return id;
  }

  kind = (id: string): VideoKind => this.meta(id).kind ?? "illustrate";

  /** One more try when a step dies on the network (a "fetch failed" once killed a whole run of poses). */
  private async talk(id: string, step: string, log: (s: string) => void, extra: string[] = []): Promise<string> {
    try {
      return await this.talkOnce(id, step, log, extra);
    } catch (e) {
      if (!/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|EAI_AGAIN/i.test(e instanceof Error ? e.message : String(e))) throw e;
      log(t("Mạng chập chờn, chạy lại bước {step}…", { step }));
      await new Promise((r) => setTimeout(r, this.opts.deploy ? 5000 : 10));
      return this.talkOnce(id, step, log, extra);
    }
  }

  private talkOnce(id: string, step: string, show: (s: string) => void, extra: string[] = []): Promise<string> {
    const m = this.meta(id);
    // Every step's lines also go to log.txt in the video's folder, so a run can be read back afterwards.
    const file = join(this.folder(id), "log.txt");
    const log = (s: string) => {
      show(s);
      try {
        appendFileSync(file, `${new Date().toISOString()} ${step}: ${s}\n`);
      } catch {
        /* the log is a help, never a reason to stop */
      }
    };
    if (m.kind === "meme") return this.opts.exec(TALK, ["meme", m.slug, "--out", this.folder(id), "--step", step, ...extra], log);
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
    await this.measureDrift(id, shots.map((s) => s.id));
    if (!meta.mouth) return;
    const after = this.meta(id);
    const pics = shots.flatMap((s) => [s.id, `${s.id}-b2`]).filter((p) => existsSync(join(dir, `${p}.png`)) && !existsSync(join(dir, `${p}-m.png`)) && (onlyShots || !after.mouths[p]));
    if (pics.length) {
      await this.talk(id, "mouths", log, ["--only", pics.join(",")]);
      this.remember(id);
    }
  }

  /** How much of the frame's edge changes between the two poses of each shot; kept so the page can warn. */
  async measureDrift(id: string, shots: string[]): Promise<void> {
    const m = this.meta(id);
    m.drift ??= {};
    for (const s of shots) {
      const a = join(this.shotsDir(id), `${s}.png`), b = join(this.shotsDir(id), `${s}-b2.png`);
      if (existsSync(a) && existsSync(b)) m.drift[s] = await edgeDrift(a, b);
      else delete m.drift[s];
    }
    this.save(m);
  }

  /** The files that make up one shot on screen, for the tick and for knowing the video is stale. */
  shotFiles(id: string, s: Shot): string[] {
    const d = this.shotsDir(id);
    return [...[s.id, `${s.id}-b2`].flatMap((p) => [`${p}.png`, `${p}-s.png`, `${p}-m.png`]), `${s.id}-blink.png`].map((f) => join(d, f));
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

  /**
   * New words for a shot (what it shows, the second pose, the bubble), the lines heard in it with their times,
   * a line the recogniser missed, and when the shot starts (not the first one).
   */
  editShot(
    id: string,
    shot: string,
    form: {
      act?: string;
      pose?: string;
      bubble?: string;
      lines?: Record<number, string>;
      starts?: Record<number, string>;
      ends?: Record<number, string>;
      drop?: number[];
      add?: { text: string; start: string; end: string };
      t?: string;
    },
  ): void {
    const plan = this.plan(id);
    const s = plan?.shots.find((x) => x.id === shot);
    if (!plan || !s) throw new Error(t("Không thấy cảnh này."));
    const sec = (v: string | undefined, what: string): number | undefined => {
      if (v === undefined || !v.trim()) return undefined;
      const n = Number(v.trim().replace(",", "."));
      if (!Number.isFinite(n) || n < 0 || n > plan.end) throw new Error(t("{what}: giây phải từ 0 đến {end}.", { what, end: plan.end.toFixed(1) }));
      return Math.round(n * 100) / 100;
    };
    if (form.act !== undefined && form.act.trim()) s.act = form.act.trim();
    if (form.pose !== undefined) s.pose = form.pose.trim();
    if (form.bubble !== undefined) s.bubble = form.bubble.trim();
    for (const [k, text] of Object.entries(form.lines ?? {})) if (plan.lines[Number(k)] && text.trim()) plan.lines[Number(k)].text = text.trim();
    for (const [k, v] of Object.entries(form.starts ?? {})) { const l = plan.lines[Number(k)], n = sec(v, l?.text ?? ""); if (l && n !== undefined) l.start = n; }
    for (const [k, v] of Object.entries(form.ends ?? {})) { const l = plan.lines[Number(k)], n = sec(v, l?.text ?? ""); if (l && n !== undefined) l.end = n; }
    if (form.add?.text.trim()) {
      const start = sec(form.add.start, t("Câu mới")), end = sec(form.add.end, t("Câu mới"));
      if (start === undefined || end === undefined) throw new Error(t("Câu mới cần giờ bắt đầu và kết thúc."));
      plan.lines.push({ text: form.add.text.trim(), start, end });
    }
    const drop = new Set(form.drop ?? []);
    plan.lines = plan.lines.filter((_, k) => !drop.has(k));
    for (const l of plan.lines) if (l.end <= l.start) throw new Error(t("Câu \"{text}\": giờ kết thúc phải sau giờ bắt đầu.", { text: l.text }));
    plan.lines.sort((a, b) => a.start - b.start);
    const start = sec(form.t, t("Giờ bắt đầu cảnh"));
    if (start !== undefined && start !== s.t) {
      if (plan.shots[0] === s) throw new Error(t("Cảnh đầu luôn bắt đầu từ 0 giây."));
      const near = plan.shots.find((x) => x !== s && Math.abs(x.t - start) < 0.3);
      if (near) throw new Error(t("Đã có cảnh {id} bắt đầu lúc {t}s.", { id: near.id, t: near.t.toFixed(1) }));
      if (start < 0.3) throw new Error(t("Cảnh sau phải bắt đầu từ 0.3 giây trở đi."));
      s.t = start;
      plan.shots.sort((a, b) => a.t - b.t);
    }
    this.savePlan(id, plan);
  }

  /** A new shot from `at` seconds (a line with no picture of its own): drawn, posed and checked like the others. */
  addShot(id: string, form: { t: string; act: string; pose?: string; bubble?: string }): string {
    if (this.jobs.get(id)?.running) throw new Error(t("Video này đang chạy."));
    const shot = this.insertShot(id, form);
    this.background(id, (log) => this.newShotWork(id, shot, log));
    return shot.id;
  }

  private async newShotWork(id: string, shot: Shot, log: (x: string) => void): Promise<void> {
    await this.talk(id, "draw", log, ["--only", shot.id]);
    if (shot.pose) await this.talk(id, "poses", log, ["--only", shot.id]);
    await this.fillGaps(id, log, [shot.id]);
  }

  /**
   * A shot for one line (a proposal's add_shot): it starts with the line the moment falls in, not at the
   * paused second, and when it would run on over later lines, the picture before comes back after it.
   */
  private insertForLine(id: string, a: FixAction): Shot {
    const plan = this.plan(id)!;
    const line = plan.lines.find((l) => a.start >= l.start - 0.3 && a.start <= l.end + 0.1);
    const taken = (x: number) => plan.shots.some((sh) => Math.abs(sh.t - x) < 0.3);
    const snapped = line && Math.abs(line.start - a.start) < 2 && !taken(line.start) ? line.start : a.start;
    const start = Math.max(0.3, snapped);
    const end = a.end > start + 0.3 ? a.end : line && line.end > start + 0.3 ? line.end : -1;
    const prev = [...plan.shots].reverse().find((x) => x.t <= start + 1e-6);
    const shot = this.insertShot(id, { t: start.toFixed(2), act: a.what });
    if (prev && end > 0) {
      const after = this.plan(id)!;
      const next = after.shots.find((x) => x.t > shot.t + 1e-6)?.t ?? after.end;
      if (next - end > 0.8 && !after.shots.some((x) => Math.abs(x.t - end) < 0.3)) {
        const ids = new Set(after.shots.map((x) => x.id));
        let n = after.shots.length + 1;
        while (ids.has(`s${String(n).padStart(2, "0")}`)) n++;
        after.shots.push({ id: `s${String(n).padStart(2, "0")}`, t: Math.round(end * 100) / 100, act: prev.act, pose: "", bubble: "", cast: [], src: prev.src ?? prev.id });
        after.shots.sort((x, y) => x.t - y.t);
        this.savePlan(id, after);
      }
    }
    return shot;
  }

  private insertShot(id: string, form: { t: string; act: string; pose?: string; bubble?: string }): Shot {
    const plan = this.plan(id);
    if (!plan) throw new Error(t("Chưa có kế hoạch cảnh."));
    const at = Math.round(Number((form.t ?? "").trim().replace(",", ".")) * 100) / 100;
    if (!Number.isFinite(at) || at < 0.3 || at > plan.end - 0.3) throw new Error(t("Giây bắt đầu cảnh mới phải từ 0.3 đến {end}.", { end: (plan.end - 0.3).toFixed(1) }));
    const near = plan.shots.find((x) => Math.abs(x.t - at) < 0.3);
    if (near) throw new Error(t("Đã có cảnh {id} bắt đầu lúc {t}s.", { id: near.id, t: near.t.toFixed(1) }));
    if (!form.act?.trim()) throw new Error(t("Viết cảnh mới vẽ gì."));
    const ids = new Set(plan.shots.map((x) => x.id));
    let n = plan.shots.length + 1;
    while (ids.has(`s${String(n).padStart(2, "0")}`)) n++;
    const shot: Shot = { id: `s${String(n).padStart(2, "0")}`, t: at, act: form.act.trim(), pose: (form.pose ?? "").trim(), bubble: (form.bubble ?? "").trim(), cast: [] };
    plan.shots.push(shot);
    plan.shots.sort((a, b) => a.t - b.t);
    this.savePlan(id, plan);
    return shot;
  }

  /** Takes a shot out; the one before it runs on until the next. The first shot stays. */
  removeShot(id: string, shot: string): void {
    const plan = this.plan(id);
    const k = plan?.shots.findIndex((x) => x.id === shot) ?? -1;
    if (!plan || k < 0) throw new Error(t("Không thấy cảnh này."));
    if (k === 0) throw new Error(t("Không bỏ được cảnh đầu."));
    if (plan.shots.some((x) => x.src === shot)) throw new Error(t("Cảnh khác đang dùng lại tranh này."));
    plan.shots.splice(k, 1);
    this.savePlan(id, plan);
    const m = this.meta(id);
    delete m.checked[shot];
    this.save(m);
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
    this.background(id, (log) => this.redrawWork(id, s, log));
  }

  private async redrawWork(id: string, s: Shot, log: (x: string) => void): Promise<void> {
    this.dropPictures(id, [s.id, `${s.id}-b`, `${s.id}-b2`], ["", "-s", "-m", "-s.raw", "-m.raw", "-mask", "-blink", "-prev"]);
    await this.talk(id, "draw", log, ["--only", s.id]);
    if (s.pose) await this.talk(id, "poses", log, ["--only", s.id]);
    await this.fillGaps(id, log, [s.id]);
  }

  /** Draws only the second pose again. */
  redrawPose(id: string, shot: string): void {
    const s = this.plan(id)?.shots.find((x) => x.id === shot && !x.src);
    if (!s?.pose) throw new Error(t("Cảnh này không có tư thế 2."));
    this.forget(id, [s.id]);
    this.background(id, (log) => this.poseWork(id, s, log));
  }

  private async poseWork(id: string, s: Shot, log: (x: string) => void): Promise<void> {
    this.dropPictures(id, [`${s.id}-b`, `${s.id}-b2`], ["", "-s", "-m", "-s.raw", "-m.raw"]);
    rmSync(join(this.shotsDir(id), `${s.id}-mask.png`), { force: true });
    await this.talk(id, "poses", log, ["--only", s.id]);
    await this.fillGaps(id, log, [s.id]);
  }

  /**
   * Changes only what the note says on pose A and keeps the rest of the picture (talk --step fix);
   * the change is carried into pose B and the mouths, and only what cannot take it is made again.
   */
  fixDetail(id: string, shot: string, note: string): void {
    const s = this.plan(id)?.shots.find((x) => x.id === shot && !x.src);
    if (!s) throw new Error(t("Không thấy cảnh này."));
    if (!note.trim()) throw new Error(t("Viết chỗ cần sửa, vd: bỏ ghim sao sau lưng Rico."));
    if (!existsSync(join(this.shotsDir(id), `${s.id}.png`))) throw new Error(t("Cảnh này chưa vẽ."));
    this.forget(id, [s.id]);
    this.background(id, (log) => this.fixWork(id, s, note.trim(), "", log));
  }

  private async fixWork(id: string, s: Shot, note: string, find: string, log: (x: string) => void): Promise<void> {
    await this.talk(id, "fix", log, ["--only", s.id, "--note", note, ...(find.trim() ? ["--find", find.trim()] : [])]);
    // talk carried the change into pose B and the mouths where it could and removed the rest: only that is made again.
    if (s.pose && !existsSync(join(this.shotsDir(id), `${s.id}-b.png`))) await this.talk(id, "poses", log, ["--only", s.id]);
    await this.fillGaps(id, log, [s.id]);
  }

  /** Puts back the picture from before the last detail fix. */
  undoFix(id: string, shot: string): void {
    const s = this.plan(id)?.shots.find((x) => x.id === shot && !x.src);
    const prev = join(this.shotsDir(id), `${shot}-prev.png`);
    if (!s || !existsSync(prev)) throw new Error(t("Không có bản trước để quay lại."));
    this.forget(id, [s.id]);
    this.background(id, async (log) => {
      copyFileSync(prev, join(this.shotsDir(id), `${s.id}.png`));
      rmSync(prev, { force: true });
      await this.afterNewA(id, s, log);
    });
  }

  /** Pose A changed: everything made from it goes and is made again. */
  private async afterNewA(id: string, s: Shot, log: (x: string) => void): Promise<void> {
    this.dropPictures(id, [s.id], ["-s", "-m", "-s.raw", "-m.raw", "-mask", "-blink"]);
    this.dropPictures(id, [`${s.id}-b`, `${s.id}-b2`], ["", "-s", "-m", "-s.raw", "-m.raw"]);
    if (s.pose) await this.talk(id, "poses", log, ["--only", s.id]);
    await this.fillGaps(id, log, [s.id]);
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
    this.background(id, (log) => this.renderWork(id, m, log));
  }

  private async renderWork(id: string, m: Meta, log: (x: string) => void): Promise<void> {
    await this.talk(id, "render", log);
    if (m.mouth) await this.talk(id, "render", log, ["--mouth"]);
  }

  // ------------------------------------------------------------ from text or pictures

  ideasDir = () => join(this.opts.dir, "_ideas");
  ideaDir = (id: string) => join(this.ideasDir(), id);

  /** What the owner dropped in (text, pictures or both); Muse Spark proposes a text clip or a one-panel comic. */
  newIdea(text: string, files: Array<{ name: string; bytes: Uint8Array }>, want: "" | "meme" | "comic" = ""): string {
    const pics = files.filter((f) => f.bytes.length && /\.(png|jpe?g|webp|gif)$/i.test(f.name)).slice(0, 4);
    if (!text.trim() && !pics.length) throw new Error(t("Dán chữ hoặc thêm ít nhất một ảnh."));
    let id = `y-${stamp()}`;
    for (let n = 2; existsSync(this.ideaDir(id)); n++) id = `y-${stamp()}-${n}`;
    const dir = this.ideaDir(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "input.txt"), text.trim());
    pics.forEach((f, i) => writeFileSync(join(dir, `img-${i + 1}${extname(f.name).toLowerCase().replace(".jpeg", ".jpg")}`), f.bytes));
    this.background(`idea:${id}`, async (log) => {
      log(t("Máy đang đọc chữ và ảnh…"));
      await this.opts.exec(TALK, ["idea", "--out", dir, ...(want ? ["--kind", want] : [])], log);
    });
    return id;
  }

  /** Reads the same drop-in again (a new answer from Muse Spark). */
  rereadIdea(id: string): void {
    const i = this.idea(id);
    if (!i) throw new Error(t("Không thấy mục này."));
    rmSync(join(this.ideaDir(id), "idea.json"), { force: true });
    this.background(`idea:${id}`, async (log) => {
      log(t("Máy đang đọc chữ và ảnh…"));
      await this.opts.exec(TALK, ["idea", "--out", this.ideaDir(id)], log);
    });
  }

  idea(id: string): { id: string; text: string; images: string[]; plan?: IdeaPlan; job?: Job } | undefined {
    if (!/^y-[a-z0-9-]+$/.test(id) || !existsSync(this.ideaDir(id))) return undefined;
    const dir = this.ideaDir(id);
    const f = join(dir, "idea.json");
    return {
      id,
      text: readFileSync(join(dir, "input.txt"), "utf8"),
      images: readdirSync(dir).filter((x) => /^img-\d+\.(png|jpe?g|webp|gif)$/i.test(x)).sort(),
      plan: existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as IdeaPlan) : undefined,
      job: this.jobs.get(`idea:${id}`),
    };
  }

  // ------------------------------------------------------------ fixing by note

  undoDir = (id: string) => join(this.folder(id), "undo");

  /** Spoken stretches with no subtitle, written by the last render (illustrated clips). */
  gaps(id: string): Array<{ start: number; end: number }> {
    const f = join(this.folder(id), "gaps.json");
    try {
      return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Array<{ start: number; end: number }>) : [];
    } catch {
      return [];
    }
  }

  /** The owner's note, read by Muse Spark against the plan and the pictures; the proposal waits on the page. */
  ask(id: string, note: string, at?: string): void {
    const m = this.meta(id);
    if (!this.plan(id)) throw new Error(t("Chưa có kế hoạch cảnh."));
    if (!note.trim()) throw new Error(t("Viết chỗ cần sửa, như nhắn tin."));
    const sec = at && at.trim() ? Number(at) : undefined;
    this.background(id, async (log) => {
      const out = join(this.folder(id), "fixes.json");
      rmSync(out, { force: true });
      if (m.kind !== "meme" && !existsSync(join(this.folder(id), "gaps.json"))) await this.talk(id, "gaps", log).catch(() => "");
      log(t("Máy đang đọc lời anh và soi các cảnh…"));
      await this.talk(id, "ask", log, ["--note", note.trim(), ...(sec !== undefined && Number.isFinite(sec) ? ["--at", String(sec)] : [])]);
      const r = JSON.parse(readFileSync(out, "utf8")) as { reply: string; actions: FixAction[] };
      const after = this.meta(id);
      after.ask = { note: note.trim(), at: sec, reply: r.reply, actions: r.actions };
      delete after.refused;
      this.save(after);
    });
  }

  dropAsk(id: string): void {
    const m = this.meta(id);
    delete m.ask;
    this.save(m);
  }

  /** Copies what a fix can change (plan, pictures, renders, notes) so it can be put back. */
  private snapshot(id: string): void {
    const u = this.undoDir(id), f = this.folder(id);
    clearDir(u);
    mkdirSync(u, { recursive: true });
    for (const name of readdirSync(f)) if (/^(plan|meta|meme)\.json$|\.mp4$/.test(name)) copyFileSync(join(f, name), join(u, name));
    if (existsSync(this.shotsDir(id))) cpSync(this.shotsDir(id), join(u, "shots"), { recursive: true, filter: (src) => !/[\\/]frames([\\/]|$)/.test(src) });
  }

  /** Does the picked edits of the proposal, renders again and keeps the evidence (before, after, what changed). */
  apply(id: string, picks: number[]): void {
    const m = this.meta(id);
    if (!m.ask) throw new Error(t("Chưa có gì để làm."));
    if (this.jobs.get(id)?.running) throw new Error(t("Video này đang chạy."));
    const acts = m.ask.actions.filter((_, i) => picks.includes(i));
    if (!acts.length) throw new Error(t("Chọn ít nhất một việc."));
    const note = m.ask.note;
    this.snapshot(id);
    const plan = this.plan(id)!;
    const shotOf = (a: FixAction) => plan.shots.find((x) => x.id === a.shot);
    for (const a of acts) {
      const l = plan.lines[a.line];
      if (a.do === "line_text" && l) l.text = a.text.trim();
      if (a.do === "line_time" && l && a.end > a.start) [l.start, l.end] = [a.start, a.end];
      if (a.do === "bubble" && shotOf(a)) shotOf(a)!.bubble = a.text.trim();
      if (a.do === "redraw" && shotOf(a) && a.what.trim()) shotOf(a)!.act = `${shotOf(a)!.act.replace(/\s*Fix: .*$/, "")} Fix: ${a.what.trim()}`;
    }
    const drop = new Set(acts.filter((a) => a.do === "drop_line").map((a) => a.line));
    plan.lines = plan.lines.filter((_, k) => !drop.has(k));
    for (const a of acts) if (a.do === "add_line" && a.text.trim() && a.end > a.start) plan.lines.push({ text: a.text.trim(), start: a.start, end: a.end });
    plan.lines.sort((a, b) => a.start - b.start);
    this.savePlan(id, plan);
    const added = acts.filter((a) => a.do === "add_shot").map((a) => this.insertForLine(id, a));
    for (const a of acts) {
      if (a.do === "one_pose") this.onePose(id, a.shot);
      if (a.do === "no_mouth") this.noMouth(id, a.shot);
    }
    const pictures = acts.filter((a) => ["fix_detail", "redraw", "redo_pose"].includes(a.do) && shotOf(a));
    this.forget(id, pictures.map((a) => a.shot));
    const after = this.meta(id);
    delete after.ask;
    after.done = { note, says: acts.map((a) => a.say), changed: {}, detail: acts.filter((a) => a.do === "fix_detail").map((a) => a.shot) };
    this.save(after);
    const changed = [...pictures.map((a) => a.shot), ...added.map((s) => s.id)];
    this.background(id, async (log) => {
      const fresh = this.plan(id)!;
      // One edit failing does not stop the others; whatever failed is said, and Hoàn tác puts everything back.
      const failed: string[] = [];
      let done = 0;
      const step = async (what: string, work: () => Promise<unknown>) => {
        try {
          await work();
          done++;
        } catch (e) {
          const msg = (e instanceof Error ? e.message : String(e)).split("\n").filter(Boolean).pop() ?? "";
          failed.push(`${what}: ${msg.replace(/^(Error: )?s\d+: /, "").slice(0, 200)}`);
        }
      };
      for (const a of pictures) {
        const s = fresh.shots.find((x) => x.id === a.shot)!;
        if (a.do === "fix_detail") await step(s.id, () => this.fixWork(id, s, a.what.trim() || note, a.find, log));
        if (a.do === "redraw") await step(s.id, () => this.redrawWork(id, s, log));
        if (a.do === "redo_pose" && s.pose) await step(s.id, () => this.poseWork(id, s, log));
      }
      for (const s of added) await step(s.id, () => this.newShotWork(id, s, log));
      // Nothing came out (every picture edit refused, no text edit): no render, the copy from before goes back.
      if (!done && !acts.some((a) => !["fix_detail", "redraw", "redo_pose", "add_shot"].includes(a.do))) {
        copyFileSync(join(this.undoDir(id), "meta.json"), join(this.folder(id), "meta.json"));
        clearDir(this.undoDir(id));
        const m = this.meta(id);
        m.refused = { note, why: failed.join(" · ") };
        this.save(m);
        throw new Error(failed.join(" · "));
      }
      log(t("Dựng lại video…"));
      await step(t("dựng video"), () => this.renderWork(id, this.meta(id), log));
      await this.evidence(id, changed).catch(() => undefined);
      if (failed.length) {
        const m = this.meta(id);
        if (m.done) m.done.failed = failed.join(" · ");
        this.save(m);
        throw new Error(failed.join(" · "));
      }
    });
  }

  /** Before, after, a zoom on what changed and a map of the changed pixels, per changed picture. */
  async evidence(id: string, shots: string[]): Promise<void> {
    const m = this.meta(id);
    if (!m.done) return;
    for (const s of new Set(shots)) {
      const a = join(this.undoDir(id), "shots", `${s}.png`), b = join(this.shotsDir(id), `${s}.png`);
      if (!existsSync(b)) continue;
      if (!existsSync(a)) {
        m.done.changed[s] = 1;
        continue;
      }
      const W = 540, H = 960;
      const [pa, pb] = await Promise.all([a, b].map((f) => sharp(f).resize(W, H, { fit: "cover" }).removeAlpha().raw().toBuffer()));
      const map = Buffer.alloc(W * H * 3);
      let n = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let i = 0; i < W * H; i++) {
        const d = Math.abs(pa[i * 3] - pb[i * 3]) + Math.abs(pa[i * 3 + 1] - pb[i * 3 + 1]) + Math.abs(pa[i * 3 + 2] - pb[i * 3 + 2]);
        const g = Math.round((pb[i * 3] + pb[i * 3 + 1] + pb[i * 3 + 2]) / 3 * 0.5 + 100);
        if (d > 60) {
          n++;
          const x = i % W, y = (i / W) | 0;
          [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
          map.set([230, 30, 30], i * 3);
        } else map.set([g, g, g], i * 3);
      }
      m.done.changed[s] = n / (W * H);
      await sharp(map, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 80 }).toFile(join(this.undoDir(id), `diff-${s}.jpg`));
      if (x1 >= 0) {
        const pad = 40, left = Math.max(0, x0 - pad), top = Math.max(0, y0 - pad);
        const box = { left, top, width: Math.min(W, x1 + pad) - left, height: Math.min(H, y1 + pad) - top };
        for (const [f, tag] of [[a, "before"], [b, "after"]] as const)
          await sharp(await sharp(f).resize(W, H, { fit: "cover" }).extract(box).png().toBuffer()).resize({ width: 360, height: 360, fit: "inside" }).jpeg({ quality: 85 }).toFile(join(this.undoDir(id), `zoom-${s}-${tag}.jpg`));
      }
    }
    this.save(m);
  }

  /** Keeps the fix: the copy from before goes. */
  keep(id: string): void {
    const m = this.meta(id);
    delete m.done;
    this.save(m);
    clearDir(this.undoDir(id));
  }

  /** Puts everything back as it was before the last fix. */
  undo(id: string): void {
    const u = this.undoDir(id), f = this.folder(id);
    if (!existsSync(join(u, "plan.json"))) throw new Error(t("Không có bản trước để quay lại."));
    if (this.jobs.get(id)?.running) throw new Error(t("Video này đang chạy."));
    for (const name of readdirSync(f)) if (/\.mp4$/.test(name)) rmSync(join(f, name), { force: true });
    for (const name of readdirSync(u)) if (/^(plan|meta|meme)\.json$|\.mp4$/.test(name)) copyFileSync(join(u, name), join(f, name));
    // File by file, never removing the folder: on Windows a picture the page is showing can hold the folder.
    const us = join(u, "shots"), sd = this.shotsDir(id);
    if (existsSync(us)) {
      const kept = new Set(readdirSync(us));
      for (const name of existsSync(sd) ? readdirSync(sd) : []) if (/\.png$/.test(name) && !kept.has(name)) rmSync(join(sd, name), { force: true });
      mkdirSync(sd, { recursive: true });
      cpSync(us, sd, { recursive: true, force: true });
    }
    clearDir(u);
    const m = this.meta(id);
    delete m.done;
    delete m.ask;
    this.save(m);
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
  async approve(id: string, form: { caption: string; threadsCaption?: string; version: "mouth" | "plain"; still: string[]; when?: string; cover?: string }): Promise<void> {
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
    const cover = form.cover === undefined ? m.cover : form.cover.trim() || undefined;
    Object.assign(m, { caption, threadsCaption: form.threadsCaption?.trim() || undefined, version: form.version, still, when, cover });
    delete m.posted;
    delete m.coverProblem;
    this.save(m);
    // The TikTok cover and the download page; a cover that cannot be made does not undo the approval.
    if (this.jobs.get(id)?.running) return;
    this.background(id, async (log) => {
      if (cover) {
        try {
          const out = await this.opts.exec(TALK, ["cover", m.slug, "--out", this.folder(id), "--quote", cover], log);
          const file = out.trim().split(/\r?\n/).pop()?.trim() ?? "";
          if (!existsSync(file)) throw new Error(t("Không thấy ảnh bìa vừa làm."));
          copyFileSync(file, join(this.opts.episodesDir, ep, "cover.jpg"));
          copyFileSync(file, join(this.folder(id), "cover.jpg"));
        } catch (e) {
          const mm = this.meta(id);
          mm.coverProblem = e instanceof Error ? e.message : String(e);
          this.save(mm);
        }
      }
      await this.opts.exec(STUDIO, ["tai"], log);
      if (this.opts.deploy) await this.opts.exec(SITE, ["deploy"], log);
    });
  }

  /** The TikTok cover, once made. */
  coverFile = (id: string) => join(this.opts.episodesDir, this.epId(id), "cover.jpg");

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

  /** Moves or clears the set time of an approved clip not posted yet (Lịch đăng). */
  setWhen(id: string, when?: string): void {
    const m = this.meta(id);
    if (m.posted || !this.approved(id)) return;
    if (when) m.when = when;
    else delete m.when;
    this.save(m);
  }

  /** Approved clips with a set time that have not gone out yet, soonest first. */
  scheduled(): Meta[] {
    return this.list().filter((m) => m.when && !m.posted && this.approved(m.id)).sort((a, b) => a.when!.localeCompare(b.when!));
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

/**
 * Share of the frame's edge (top fifth, outer tenth left and right) that is
 * clearly different between two pictures. The second pose keeps the first
 * one's background, so anything well above zero means the room moved.
 */
export async function edgeDrift(a: string, b: string): Promise<number> {
  const W = 54, H = 96;
  const grey = (f: string) => sharp(f).resize(W, H, { fit: "fill" }).greyscale().raw().toBuffer();
  const [pa, pb] = await Promise.all([grey(a), grey(b)]);
  let n = 0, moved = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!(y < H * 0.2 || x < W * 0.1 || x >= W * 0.9)) continue;
      n++;
      if (Math.abs(pa[y * W + x] - pb[y * W + x]) > 24) moved++;
    }
  return +(moved / n).toFixed(3);
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

/** The one box for what the owner would otherwise hand to Claude: text, pictures, or both. */
function ideaBox(v: Videos): string {
  const recent = existsSync(v.ideasDir())
    ? readdirSync(v.ideasDir()).filter((x) => x.startsWith("y-") && !x.startsWith("y-k-")).sort().reverse().slice(0, 5)
    : [];
  const list = recent.map((id) => {
    const i = v.idea(id)!;
    return `<li><a href="/video/idea/${esc(id)}">${esc(i.plan?.title || i.text.slice(0, 40) || t("{n} ảnh", { n: i.images.length }))}</a>${i.job?.running ? ` <span class="spinner"></span>` : ""}</li>`;
  }).join("");
  const samples = v.samples();
  return `<section class="card ideabox"><h2>${esc(t("Muốn làm gì, cứ viết như nhắn tin"))}</h2>
<p class="muted small">${esc(t("Dán câu, ảnh chụp bài đăng, ảnh meme hay một clip. Máy tự điền phần còn lại rồi cho anh xem trước, chưa làm gì khi anh chưa bấm."))}</p>
<form class="form" method="post" action="/video/idea" enctype="multipart/form-data">
<textarea name="text" rows="3" placeholder="${esc(t("vd: Đi làm đã mệt rồi còn phải ăn bữa cơm dở ẹc do mình tự nấu mang theo"))}"></textarea>
<label class="small">${esc(t("Đính kèm ảnh hoặc clip (không bắt buộc)"))}<input type="file" name="files" accept="image/*,video/*" multiple></label>
${samples.length ? `<details class="small"><summary>${esc(t("Hoặc dùng clip mẫu có sẵn"))}</summary><select name="sample"><option value="">${esc(t("— không dùng —"))}</option>${samples.map((x) => `<option value="${esc(x.path)}">${esc(x.label)}</option>`).join("")}</select></details>` : ""}
<button class="btn on">${esc(t("Gửi"))}</button></form>${list ? `<ul class="small idealist">${list}</ul>` : ""}${stockLink(v.stock)}${readyLink(v.ready)}</section>`;
}

/** The cast member a note names (slug or name, any case), else Tũn, else the first. */
export function leadFromText(text: string, cast: Array<{ slug: string; name: string }>): string {
  const low = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, " ")} `;
  const said = (w: string) => Boolean(w) && low.includes(` ${w.toLowerCase()} `);
  return cast.find((c) => said(c.name) || said(c.slug))?.slug ?? cast.find((c) => c.slug === "cu-li")?.slug ?? cast[0]?.slug ?? "cu-li";
}

/** The proposal for one drop-in: what was read (evidence), then the clip and the comic forms, filled and editable. */
export function ideaPage(v: Videos, id: string, studio: boolean, err?: string): string | undefined {
  const i = v.idea(id);
  if (!i) return undefined;
  const cast = v.opts.cast();
  const busy = Boolean(i.job?.running);
  const pics = i.images.map((f) => `<a href="/video-media/_ideas/${esc(id)}/${esc(f)}" target="_blank"><img src="/video-media/_ideas/${esc(id)}/${esc(f)}" alt="" loading="lazy"></a>`).join("");
  const input = `<section class="card"><h2>${esc(t("Anh đưa"))}</h2>${i.text ? `<p class="ideatext">${esc(i.text)}</p>` : ""}${pics ? `<div class="ideapics">${pics}</div>` : ""}</section>`;
  if (busy || !i.plan) {
    const bar = busy
      ? `<div class="notice"><span class="spinner"></span>${esc(i.job?.step ?? t("Máy đang đọc chữ và ảnh…"))}</div><meta http-equiv="refresh" content="3">`
      : `<div class="warn small">${esc(t("Chưa đọc được"))}: ${esc(i.job?.error ?? "")}</div>`;
    return layout(t("Làm từ chữ hoặc ảnh"), "/video", `<header class="head"><a class="muted" href="/video">← ${esc(t("Video"))}</a><h1>${esc(t("Làm từ chữ hoặc ảnh"))}</h1></header>${bar}${input}`);
  }
  const p = i.plan;
  const pick = (name: string, sel: string) => `<select name="${name}">${cast.map((c) => `<option value="${esc(c.slug)}"${c.slug === sel ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select>`;
  const meme = `<form class="form" method="post" action="/video/new" enctype="multipart/form-data"><input type="hidden" name="kind" value="meme"><input type="hidden" name="scenes" value="${p.meme.scenes.length > 1 ? 2 : 1}">
<label>${esc(t("Dòng chữ 1: câu dẫn"))}<input name="top" maxlength="90" required value="${esc(p.meme.top)}"></label>
<label>${esc(t("Dòng chữ 2: câu chốt (hiện sau, chữ đỏ)"))}<input name="punch" maxlength="90" required value="${esc(p.meme.punch)}"></label>
<details><summary class="small">${esc(t("Chỉnh thêm cảnh, nhân vật, chú thích (máy đã điền sẵn)"))}</summary>
<label>${esc(t("Cảnh 1 vẽ gì"))}<input name="scene1" value="${esc(p.meme.scenes[0] ?? "")}"></label>
${p.meme.scenes.length > 1 ? `<label>${esc(t("Cảnh 2 vẽ gì"))}<input name="scene2" value="${esc(p.meme.scenes[1] ?? "")}"></label>` : ""}
<div class="row"><label>${esc(t("Nhân vật chính"))}${pick("slug", p.lead)}</label><label>${esc(t("Tên video"))}<input name="title" value="${esc(p.title)}"></label></div>
<label>${esc(t("Chú thích (ngắn, tối đa 5 hashtag không dấu)"))}<input name="caption" maxlength="${CAPTION_MAX}" value="${esc(p.caption ?? "")}"></label></details>
<input type="hidden" name="music" value="${esc(MEME_MUSIC)}">
<p class="muted small">${esc(t("Chữ giữ nguyên văn. Câu chốt hiện ngay khi đọc xong dòng 1. Có nhạc nền."))}</p>
<button class="btn on">▶ ${esc(t("Làm clip chữ"))}</button></form>`;
  const comic = studio
    ? `<form class="form" method="post" action="/studio/new"><input type="hidden" name="format" value="single"><input type="hidden" name="run" value="1">
<label>${esc(t("Tranh vẽ gì, ai nói gì"))}<textarea name="direction" rows="3" required>${esc(p.comic.direction)}</textarea></label>
<details><summary class="small">${esc(t("Chỉnh thêm nhân vật, câu in trên tranh (máy đã điền sẵn)"))}</summary>
<div class="row"><label>${esc(t("Nhân vật chính"))}${pick("lead", p.lead)}</label></div>
${cast.filter((c) => c.slug !== p.lead).length ? `<fieldset><legend>${esc(t("Cùng xuất hiện"))}</legend>${cast.filter((c) => c.slug !== p.lead).map((c) => `<label class="check"><input type="checkbox" name="with" value="${esc(c.slug)}"${p.comic.with.includes(c.slug) ? " checked" : ""}> ${esc(c.name)}</label>`).join("")}</fieldset>` : ""}
<label>${esc(t("Câu in trên đầu tranh (nguyên văn)"))}<textarea name="headline" rows="2">${esc(p.comic.headline ?? "")}</textarea></label></details>
<button class="btn on">▶ ${esc(t("Làm tranh 1 khung"))}</button></form>`
    : `<p class="muted small">${esc(t("Phần làm tranh chưa bật trên máy này."))}</p>`;
  const first = p.kind === "comic" ? [t("Tranh 1 khung"), comic, t("Hoặc làm clip chữ"), meme] : [t("Clip chữ (video)"), meme, t("Hoặc làm tranh 1 khung"), comic];
  const body = `<header class="head"><a class="muted" href="/video">← ${esc(t("Video"))}</a><h1>${esc(p.title || t("Làm từ chữ hoặc ảnh"))}</h1></header>${flash(undefined, err)}
${input}
<section class="card"><p><b>${esc(t("Máy hiểu"))}:</b> ${esc(p.reply)}</p>${p.read ? `<p class="small"><b>${esc(t("Chữ đọc được trong ảnh"))}:</b> “${esc(p.read)}”</p><p class="muted small">${esc(t("Đối chiếu với ảnh ở trên. Sai chữ nào thì sửa ngay trong ô bên dưới."))}</p>` : ""}</section>
<section class="card"><h2>${esc(first[0])}</h2>${first[1]}</section>
<details class="card"><summary>${esc(first[2])}</summary>${first[3]}</details>
<form class="inline" method="post" action="/video/idea/${esc(id)}/again"><button class="btn">${esc(t("Đọc lại"))}</button></form>`;
  return layout(p.title || t("Làm từ chữ hoặc ảnh"), "/video", body);
}

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
  return layout(t("Video"), "/video", `<header class="head"><h1>${esc(t("Làm bài mới"))}</h1></header>${flash(ok, err)}${ideaBox(v)}
<h2 class="section-title">${esc(t("Video đã làm"))}</h2>${cards ? `<div class="vgrid">${cards}</div>` : `<p class="muted">${esc(t("Chưa có video nào."))}</p>`}
`);
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
  const drift = m.drift?.[s.id] ?? 0;
  if (drift > DRIFT_WARN) pics.push(`<figure class="empty warnfig"><figcaption>${esc(t("Nền lệch giữa 2 tư thế ({p}% mép khung đổi). Bấm Vẽ lại tư thế 2 hoặc Giữ 1 tư thế.", { p: Math.round(drift * 100) }))}</figcaption></figure>`);
  const actions = busy
    ? ""
    : `<div class="vactions">${checked ? `<span class="tag ok">✓ ${esc(t("Đã soát"))}</span>` : has(`${s.id}.png`) ? button(`/video/${id}/shot/${s.id}/ok`, `✓ ${esc(t("Đã soát cỡ thật, ổn"))}`, "btn on") : ""}
<a class="btn" href="#fix" data-fill="${esc(t("Cảnh {id}: ", { id: s.id }))}" data-at="${s.t.toFixed(2)}">✎ ${esc(t("Báo lỗi cảnh này"))}</a></div>
<details class="vmanual"><summary>${esc(t("Sửa tay"))}</summary><div class="vactions">
<form class="inline" method="post" action="/video/${esc(id)}/shot/${esc(s.id)}/fix"><input name="note" placeholder="${esc(t("Sửa đúng chỗ nào? vd: bỏ ghim sao sau lưng Rico"))}"><button class="btn">${esc(t("Sửa chi tiết, giữ tranh"))}</button></form>
${has(`${s.id}-prev.png`) ? button(`/video/${id}/shot/${s.id}/undo`, esc(t("Quay lại bản trước khi sửa"))) : ""}
<form class="inline" method="post" action="/video/${esc(id)}/shot/${esc(s.id)}/redraw"><input name="note" placeholder="${esc(t("Lỗi gì? vd: thừa một bàn tay"))}"><button class="btn">${esc(t("Vẽ lại cả cảnh"))}</button></form>
${s.pose ? button(`/video/${id}/shot/${s.id}/repose`, esc(t("Vẽ lại tư thế 2"))) + button(`/video/${id}/shot/${s.id}/onepose`, esc(t("Giữ 1 tư thế"))) : ""}
${m.mouth && (has(`${s.id}-m.png`) || has(`${s.id}-b2-m.png`)) ? button(`/video/${id}/shot/${s.id}/nomouth`, esc(t("Bỏ nhép"))) : ""}
${plan.shots[0] !== s ? button(`/video/${id}/shot/${s.id}/remove`, esc(t("Bỏ cảnh này"))) : ""}</div>`;
  const manualEnd = busy ? "" : "</details>";
  const edit = `<details><summary>${esc(t("Lời, giờ phụ đề, bong bóng, mô tả cảnh"))}</summary><form class="form" method="post" action="/video/${esc(id)}/shot/${esc(s.id)}/edit">
${lines.map((l) => `<div class="row vline"><label>${esc(t("Lời"))}<input name="line-${l.k}" value="${esc(l.text)}"></label><label>${esc(t("Từ giây"))}<input name="start-${l.k}" inputmode="decimal" value="${l.start.toFixed(2)}" size="5"></label><label>${esc(t("Đến giây"))}<input name="end-${l.k}" inputmode="decimal" value="${l.end.toFixed(2)}" size="5"></label><label class="check"><input type="checkbox" name="drop" value="${l.k}"> ${esc(t("Xoá câu"))}</label></div>`).join("")}
<div class="row vline"><label>${esc(t("Thêm câu máy nghe sót"))}<input name="add-text" placeholder="${esc(t("vd: Taeyang với cả Bigbang về Việt Nam hát concert"))}"></label><label>${esc(t("Từ giây"))}<input name="add-start" inputmode="decimal" size="5" placeholder="${s.t.toFixed(1)}"></label><label>${esc(t("Đến giây"))}<input name="add-end" inputmode="decimal" size="5" placeholder="${end.toFixed(1)}"></label></div>
${plan.shots[0] !== s ? `<label>${esc(t("Cảnh bắt đầu từ giây"))}<input name="t" inputmode="decimal" size="5" value="${s.t.toFixed(2)}"></label>` : ""}
<label>${esc(t("Bong bóng (ngắn, ≤12 chữ)"))}<input name="bubble" value="${esc(s.bubble)}"></label>
<label>${esc(t("Cảnh vẽ gì (tiếng Anh cho Muse Image)"))}<textarea name="act" rows="3">${esc(s.act)}</textarea></label>
<label>${esc(t("Tư thế 2 (để trống: chỉ 1 tư thế)"))}<input name="pose" value="${esc(s.pose)}"></label>
<button class="btn">${esc(t("Lưu"))}</button><p class="muted small">${esc(t("Sửa mô tả cảnh xong bấm Vẽ lại cả cảnh. Sửa lời, giờ phụ đề hay bong bóng chỉ cần Dựng lại. Xem giây trong video ở trên để biết câu nói lúc nào."))}</p></form></details>`;
  return `<div class="card vshot${checked ? " checked" : ""}" id="${esc(s.id)}"><div class="vshot-head"><b>${esc(s.id)}</b> · ${s.t.toFixed(1)}–${end.toFixed(1)}s ${s.bubble ? `<span class="bubble-text">💬 ${esc(s.bubble)}</span>` : ""}</div>
${((said) => (said.length > 140 ? `<details class="vlines"><summary>${esc(said.slice(0, 120))}…</summary>${esc(said)}</details>` : `<p class="vlines">${esc(said)}</p>`))(lines.map((l) => l.text).join(" "))}<div class="vpics">${pics.join("")}</div>${actions}${busy ? "" : edit}${manualEnd}</div>`;
}

const shotAt = (plan: Plan, at: number) => [...plan.shots].reverse().find((s) => s.t <= at + 1e-6) ?? plan.shots[0];
const thumb = (id: string, s: Shot | undefined) => (s ? `<img class="fixthumb" src="/video-media/${esc(id)}/shots/${esc(s.src ?? s.id)}.png" alt="${esc(s.id)}" loading="lazy">` : "");

/** What one proposed edit changes, shown next to the picture it is about. */
function evidenceOf(plan: Plan, a: FixAction): string {
  const l = plan.lines[a.line], s = plan.shots.find((x) => x.id === a.shot);
  const q = (x: string) => `“${esc(x)}”`;
  switch (a.do) {
    case "line_text": return l ? `${l.start.toFixed(1)}s: <del>${q(l.text)}</del> → <ins>${q(a.text)}</ins>` : "";
    case "line_time": return l ? `${q(l.text)}: <del>${l.start.toFixed(1)}–${l.end.toFixed(1)}s</del> → <ins>${a.start.toFixed(1)}–${a.end.toFixed(1)}s</ins>` : "";
    case "add_line": return `<ins>+ ${q(a.text)}</ins> ${a.start.toFixed(1)}–${a.end.toFixed(1)}s`;
    case "drop_line": return l ? `<del>${q(l.text)}</del>` : "";
    case "bubble": return `💬 <del>${q(s?.bubble ?? "")}</del> → <ins>${q(a.text)}</ins>`;
    case "fix_detail": return esc(t("Chỉ sửa đúng chỗ “{find}”, phần còn lại giữ nguyên.", { find: a.find || a.what }));
    case "redraw": return esc(t("Vẽ lại cả tranh."));
    case "add_shot": return esc(a.end > a.start ? t("Cảnh mới từ {t}s đến {e}s, sau đó về lại tranh trước.", { t: a.start.toFixed(1), e: a.end.toFixed(1) }) : t("Cảnh mới từ {t}s đến cảnh kế tiếp.", { t: a.start.toFixed(1) }));
    case "redo_pose": return esc(t("Vẽ lại tư thế 2."));
    case "one_pose": return esc(t("Giữ 1 tư thế, tranh đứng yên."));
    case "no_mouth": return esc(t("Miệng không nhép."));
  }
}

/** The picture an edit is about: its shot, or the shot on screen at its time. */
function shotFor(plan: Plan, a: FixAction): Shot | undefined {
  if (a.shot) return plan.shots.find((x) => x.id === a.shot);
  const l = plan.lines[a.line];
  if (l) return shotAt(plan, l.start);
  return a.start >= 0 ? shotAt(plan, a.start) : undefined;
}

/**
 * Fixing by note: the owner pauses on the problem and writes it like a message; the machine answers with
 * edits shown against the picture and the subtitle they touch, does them on "Làm", then shows before
 * and after with the changed pixels marked, with "Giữ" or "Hoàn tác".
 */
function fixCard(v: Videos, m: Meta, plan: Plan, busy: boolean): string {
  const id = m.id;
  const suspects = [
    ...v.gaps(id).map((g) => ({ at: g.start, text: t("{a}–{b}s có tiếng nói mà không có phụ đề", { a: g.start.toFixed(1), b: g.end.toFixed(1) }), fill: t("Từ {a} đến {b}s có câu nói chưa có phụ đề, câu đó là: ", { a: g.start.toFixed(1), b: g.end.toFixed(1) }) })),
    ...plan.shots.filter((s) => (m.drift?.[s.id] ?? 0) > DRIFT_WARN).map((s) => ({ at: s.t, text: t("Cảnh {id}: nền lệch giữa 2 tư thế", { id: s.id }), fill: t("Cảnh {id} tư thế 2 bị xô nền, giữ 1 tư thế.", { id: s.id }) })),
  ];
  const bar = `<div class="fixbar">${plan.shots.map((s, i) => {
    const e = plan.shots[i + 1]?.t ?? plan.end;
    return `<button type="button" class="fixseg" style="flex:${Math.max(0.2, e - s.t).toFixed(2)}" data-seek="${s.t.toFixed(2)}" title="${esc(`${s.id} ${s.t.toFixed(1)}s`)}">${esc(s.id)}</button>`;
  }).join("")}${suspects.map((x) => `<span class="fixdot" style="left:${((x.at / plan.end) * 100).toFixed(1)}%" title="${esc(x.text)}"></span>`).join("")}</div>`;
  const warn = suspects.length
    ? `<ul class="fixsus">${suspects.map((x) => `<li>⚠ ${esc(x.text)} · <a href="#fix" data-fill="${esc(x.fill)}" data-at="${x.at.toFixed(2)}">${esc(t("Sửa giúp"))}</a></li>`).join("")}</ul>`
    : "";
  const ask = m.ask;
  const note = ask && !ask.actions.length ? ask.note : "";
  const form = busy
    ? ""
    : `<form class="form" method="post" action="/video/${esc(id)}/ask"><input type="hidden" name="at" id="fix-at" value="${ask?.at ?? ""}">
<p class="small"><span class="tag" id="fix-where">${esc(t("Chưa dừng video: lỗi chung cả clip"))}</span></p>
<textarea name="note" id="fix-note" rows="3" required placeholder="${esc(t("vd: chỗ này thiếu tranh cho câu Taeyang · câu đầu là Mẹ không phải Mày · Rico quay lưng mà có ghim sao"))}">${esc(note)}</textarea>
<label class="check small rule-pick"><input type="checkbox" name="rule" value="1"> ${esc(t("Áp dụng cho mọi bài từ giờ (lưu vào Luật nhà)"))}</label>
<button class="btn on">${esc(t("Xem máy định sửa gì"))}</button></form>`;
  const proposal = ask && !busy
    ? ask.actions.length
      ? `<div class="fixplan"><p><b>${esc(t("Máy định làm"))}:</b> ${esc(ask.reply)}</p><p class="muted small">${esc(t("Anh viết"))}: “${esc(ask.note)}”</p>
<form method="post" action="/video/${esc(id)}/apply">${ask.actions.map((a, i) => `<label class="fixrow"><input type="checkbox" name="pick" value="${i}" checked>${thumb(id, shotFor(plan, a))}<span><b>${esc(a.say)}</b><br><span class="small">${evidenceOf(plan, a)}</span></span></label>`).join("")}
<div class="vactions"><button class="btn on">${esc(t("Làm"))}</button></div></form>
<form class="inline" method="post" action="/video/${esc(id)}/askdrop"><button class="btn">${esc(t("Bỏ, viết lại"))}</button></form>
<p class="muted small">${esc(t("Chưa đúng ý thì viết lại ở ô trên cho rõ hơn. Bỏ chọn việc nào không muốn làm."))}</p></div>`
      : `<div class="warn small">${esc(ask.reply || t("Máy chưa hiểu, anh viết rõ hơn giúp: cảnh nào, chữ nào, sai thế nào."))}</div>`
    : "";
  const refused = !busy && !m.done && m.refused
    ? `<div class="warn small"><b>${esc(t("Không sửa được, tranh và video vẫn như cũ"))}:</b> “${esc(m.refused.note)}”<br>${esc(m.refused.why)}<br>${esc(t("Viết lại cho cụ thể hơn, hoặc dùng Vẽ lại cảnh trong Sửa tay."))}</div>`
    : "";
  const done = m.done;
  const result = done
    ? `<div class="fixdone"><p><b>${esc(busy ? t("Đang sửa") : done.failed ? t("Sửa chưa xong") : t("Đã sửa"))}:</b> “${esc(done.note)}”</p>${!busy && done.failed ? `<div class="warn small">${esc(t("Có việc không làm được, tranh đó giữ như cũ: {why}. Bấm Hoàn tác để về đúng bản trước khi sửa.", { why: done.failed }))}</div>` : ""}<ul>${done.says.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
${busy ? "" : Object.entries(done.changed).map(([s, share]) => {
  const u = (f: string) => `/video-media/${esc(id)}/undo/${esc(f)}`;
  const isNew = share === 1 && !existsSync(join(v.undoDir(id), "shots", `${s}.png`));
  const before = isNew ? `<figure class="empty">${esc(t("cảnh mới"))}</figure>` : `<figure><a href="${u(`shots/${s}.png`)}" target="_blank"><img src="${u(`shots/${s}.png`)}" alt="" loading="lazy"></a><figcaption>${esc(t("Trước"))}</figcaption></figure>`;
  const after = `<figure>${img(id, `${s}.png`)}<figcaption>${esc(t("Sau"))}</figcaption></figure>`;
  const zoom = existsSync(join(v.undoDir(id), `zoom-${s}-after.jpg`)) ? `<figure class="fixzoom"><img src="${u(`zoom-${s}-before.jpg`)}" alt=""><img src="${u(`zoom-${s}-after.jpg`)}" alt=""><figcaption>${esc(t("Phóng to chỗ đổi"))}</figcaption></figure>` : "";
  const diff = existsSync(join(v.undoDir(id), `diff-${s}.jpg`)) ? `<figure><img src="${u(`diff-${s}.jpg`)}" alt=""><figcaption>${esc(t("Đỏ: chỗ đã đổi ({p}%)", { p: (share * 100).toFixed(1) }))}</figcaption></figure>` : "";
  const over = done.detail.includes(s) && share > 0.25 ? `<div class="warn small">${esc(t("Cảnh {id}: máy đổi nhiều hơn chỗ cần sửa ({p}% tranh). Xem kỹ, không ổn thì Hoàn tác.", { id: s, p: Math.round(share * 100) }))}</div>` : "";
  return `<div class="fixshot"><b>${esc(s)}</b>${over}<div class="vpics">${before}${after}${zoom}${diff}</div></div>`;
}).join("")}
${busy ? "" : `<p class="muted small">${esc(t("Video ở trên đã dựng lại. Xem lại rồi chọn."))}</p><div class="vactions">${button(`/video/${id}/keep`, esc(t("Giữ")), "btn on")}${button(`/video/${id}/undo`, esc(t("Hoàn tác")))}</div>`}</div>`
    : "";
  const cuts = JSON.stringify(plan.shots.map((s) => [s.id, s.t]));
  const lines = JSON.stringify(plan.lines.map((l) => [l.start, l.end, l.text]));
  const script = `<script>(function(){var cuts=${cuts.replace(/</g, "\\u003c")},lines=${lines.replace(/</g, "\\u003c")};
var at=document.getElementById("fix-at"),where=document.getElementById("fix-where"),note=document.getElementById("fix-note"),vids=document.querySelectorAll(".vvideos video");
function set(x){if(!at)return;at.value=x.toFixed(2);var s=cuts[0][0];cuts.forEach(function(c){if(c[1]<=x+1e-6)s=c[0]});var l=lines.filter(function(q){return x>=q[0]-0.1&&x<=q[1]+0.1})[0];
where.textContent=${JSON.stringify(t("Đang dừng ở"))}+" "+x.toFixed(1)+"s · "+${JSON.stringify(t("cảnh"))}+" "+s+(l?" · “"+l[2]+"”":"")}
vids.forEach(function(v){v.addEventListener("pause",function(){set(v.currentTime)});v.addEventListener("seeked",function(){if(v.paused)set(v.currentTime)})});
function seek(x){set(x);vids.forEach(function(v){try{v.currentTime=x}catch(e){}})}
document.querySelectorAll("[data-seek]").forEach(function(b){b.addEventListener("click",function(){seek(+b.dataset.seek)})});
document.querySelectorAll("[data-fill]").forEach(function(a){a.addEventListener("click",function(){if(!note)return;if(a.dataset.at)seek(+a.dataset.at);note.value=a.dataset.fill;setTimeout(function(){note.focus();note.setSelectionRange(note.value.length,note.value.length)},50)})});
if(at&&at.value)set(+at.value)})()</script>`;
  return `<section class="card" id="fix"><h2>${esc(t("Sửa bằng lời"))}</h2><p class="muted small">${esc(t("Xem video, dừng đúng chỗ lỗi rồi viết như nhắn tin. Máy tự lấy giây và cảnh đang dừng, cho anh xem trước sẽ sửa gì, bấm Làm mới sửa."))}</p>
${bar}${warn}${refused}${result}${proposal}${form}</section>${script}`;
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
  const addShot = plan && !busy && m.kind !== "meme"
    ? `<details class="card vmanual" id="add-shot"><summary>${esc(t("Sửa tay: thêm cảnh"))}</summary><p class="muted small">${esc(t("Cho câu thoại chưa có tranh riêng. Cảnh mới chạy từ giây này đến cảnh kế tiếp. Câu bị máy nghe sót thì thêm ở ô Sửa lời của cảnh đó."))}</p>
<form class="form" method="post" action="/video/${esc(id)}/addshot"><div class="row"><label>${esc(t("Bắt đầu từ giây"))}<input name="t" inputmode="decimal" size="5" required placeholder="12.5"></label>
<label>${esc(t("Bong bóng (không bắt buộc)"))}<input name="bubble"></label></div>
<label>${esc(t("Cảnh vẽ gì"))}<textarea name="act" rows="2" required placeholder="${esc(t("vd: Rico quay lưng đứng giữa khán đài concert, lightstick vương miện vàng"))}"></textarea></label>
<label>${esc(t("Tư thế 2 (để trống: chỉ 1 tư thế)"))}<input name="pose"></label>
<button class="btn">${esc(t("Thêm và vẽ"))}</button></form></details>`
    : "";
  const shots = plan ? plan.shots.map((s) => shotCard(v, m, plan, s, busy)).join("") + addShot : "";
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
      ? `<div class="vactions">${button(`/video/${id}/publish`, esc(t("Đăng ngay")), "btn on")}${phoneBox(v.epId(id))}${m.when ? `<span class="tag due">${esc(t("Hẹn đăng {at}", { at: when(m.when) }))}</span>` : ""}</div>`
      : "";
  const approve = `<section class="card" id="approve"><h2>${esc(t("Duyệt và đăng"))}</h2>${left.length ? `<div class="warn small">${esc(t("Còn {n} cảnh chưa soát: {list}.", { n: left.length, list: left.join(", ") }))}</div>` : ""}
<form class="form" method="post" action="/video/${esc(id)}/approve">
<label>${esc(t("Chú thích (ngắn, tối đa 5 hashtag không dấu)"))}<textarea name="caption" rows="2" maxlength="${CAPTION_MAX}">${esc(m.caption ?? "")}</textarea></label>
<label>${esc(t("Hẹn giờ đăng (giờ máy này; để trống để đăng tay)"))}<input type="datetime-local" name="when" value="${esc(m.when ? new Date(Date.parse(m.when) - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "")}"></label>
<details class="vmore"><summary>${esc(t("Tuỳ chọn thêm: bản đăng, bìa TikTok, Threads (máy đã điền sẵn)"))}</summary>
<label>${esc(t("Bản đăng"))}<select name="version">${m.mouth ? `<option value="mouth"${version === "mouth" ? " selected" : ""}>${esc(t("Có nhép miệng"))}</option>` : ""}<option value="plain"${version === "plain" ? " selected" : ""}>${esc(t("Không nhép"))}</option></select></label>
<label>${esc(t("Threads: ảnh thay video (chọn 1–2 tranh; bỏ trống thì Threads đăng video)"))}</label><div class="vstills">${stillChoices}</div>
<label>${esc(t("Chữ trên bìa TikTok (| để xuống dòng, *chữ đỏ*; để trống: không làm bìa)"))}<input name="cover" maxlength="120" value="${esc(m.cover ?? "")}"></label>
${existsSync(join(v.folder(id), "cover.jpg")) ? `<a href="/video-media/${esc(id)}/cover.jpg" target="_blank"><img class="vcover" src="/video-media/${esc(id)}/cover.jpg" alt="" loading="lazy" style="max-width:180px"></a>` : ""}${m.coverProblem ? `<div class="warn small">${esc(t("Chưa làm được bìa: {why}", { why: m.coverProblem }))}</div>` : ""}
<label>${esc(t("Chú thích Threads (một câu hỏi, 1 thẻ chủ đề)"))}<input name="threadsCaption" maxlength="${CAPTION_MAX}" value="${esc(m.threadsCaption ?? "")}"></label></details>
<button class="btn on"${busy ? " disabled" : ""}>${esc(approved ? t("Duyệt lại") : t("Duyệt"))}</button>
<p class="muted small">${esc(t("Duyệt chỉ nhận khi mọi cảnh đã soát và video mới hơn tranh. Duyệt xong máy tự làm bìa TikTok và cập nhật trang tải clip về điện thoại. Đăng Reels lên Facebook và Instagram, gửi nháp TikTok, Threads đăng ảnh hoặc video."))}</p></form>${publish}</section>`;
  const rendered = Boolean(videos) && !v.stale(id, version);
  const next = busy || !plan
    ? ""
    : m.posted
      ? ""
      : approved
        ? `<section class="card next-step"><h2>${esc(t("Bước tiếp: đăng"))}</h2>${publish}</section>`
        : left.length
          ? `<section class="card next-step"><div class="card-head"><h2>${esc(t("Bước tiếp: xem {n} cảnh bên dưới", { n: left.length }))}</h2>${button(`/video/${id}/okall`, esc(t("Cảnh nào cũng ổn, dựng video")), "btn on")}</div><p class="muted small">${esc(t("Cảnh nào sai thì bấm Báo lỗi ở cảnh đó, máy vẽ lại. Còn lại bấm nút này là xong."))}</p>${job?.error ? button(`/video/${id}/continue`, esc(t("Vẽ tiếp phần còn thiếu"))) : ""}</section>`
          : !rendered
            ? `<section class="card next-step"><div class="card-head"><h2>${esc(t("Bước tiếp: dựng video"))}</h2>${button(`/video/${id}/render`, esc(t("Dựng video")), "btn on")}</div></section>`
            : `<section class="card next-step"><div class="card-head"><h2>${esc(t("Bước tiếp: xem video rồi duyệt"))}</h2><a class="btn on" href="#approve">${esc(t("Đến ô duyệt"))}</a></div><p class="muted small">${esc(t("Chỗ nào chưa ưng thì viết vào ô Sửa bằng lời ngay dưới video."))}</p></section>`;
  const shotList = plan
    ? `<details class="card vshots"${left.length || !rendered ? " open" : ""}><summary><b>${esc(t("Từng cảnh ({n})", { n: plan.shots.length }))}</b> <span class="muted small">${esc(left.length ? t("còn {n} cảnh chưa xem", { n: left.length }) : t("đã xem hết"))}</span></summary><p class="muted small">${esc(t("Bấm vào tranh để xem cỡ thật. Soi mặt, tay, đồ vật, chữ, đồng hồ, và nền giữa 2 tư thế."))}</p>${shots}</details>`
    : `<p class="muted">${esc(m.kind === "meme" ? t("Đang lên cảnh…") : t("Đang nghe lời và chia cảnh…"))}</p>`;
  const body = `<header class="head"><a class="muted" href="/video">← ${esc(t("Video"))}</a><h1>${esc(m.title)}</h1></header>${bar}${stepBar(stepsOf(v, m))}
${next}
${videos ? `<section class="card"><div class="vvideos">${videos}</div></section>` : ""}${plan ? fixCard(v, m, plan, busy) : ""}
${shotList}
${plan && (!left.length || approved || m.posted) ? approve.replace(publish, approved ? "" : publish) : ""}`;
  return layout(m.title, "/video", body);
}

// ------------------------------------------------------------------ demo

/**
 * Stands in for talk, channel and site in the demo and tests: a three-shot
 * plan, plain placeholder pictures, a second pose that does not paste on
 * s02 and a mouth that is not found on s02, a short render, fake post links.
 */
/**
 * Removes a folder, waiting out Windows' short locks (a picture being served, a shell standing in it);
 * when it stays locked it is moved aside, so the next fix still starts from an empty folder.
 */
function clearDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    renameSync(dir, `${dir}-old-${Date.now()}`);
  }
}

export function mockExec(): Exec {
  const picture = (file: string, label: string, hue: number) =>
    sharp({ create: { width: 1080, height: 1920, channels: 3, background: `hsl(${hue}, 45%, 82%)` } })
      .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><circle cx="540" cy="900" r="260" fill="hsl(${hue}, 40%, 55%)"/><text x="540" y="1400" font-size="90" text-anchor="middle" font-family="sans-serif" fill="#333">${label}</text></svg>`) }])
      .png()
      .toFile(file);
  return async (script, args, log) => {
    if (script === SITE) return "deployed";
    if (script === STUDIO) return "tai: built";
    const at = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : "");
    if (args[0] === "cover") {
      const file = join(at("--out"), `${args[1]}-cover.jpg`);
      await sharp(join(at("--out"), "shots", "s01.png")).resize(540, 960).jpeg().toFile(file);
      log(`cover: ${at("--quote")}`);
      return `${file}\n`;
    }
    if (args[0] === "idea") {
      const out = at("--out");
      const text = readFileSync(join(out, "input.txt"), "utf8").trim();
      const pics = readdirSync(out).filter((f) => f.startsWith("img-"));
      const words = text || "Ai cũng xứng đáng có một công việc ổn định. Trừ tôi, tôi xứng đáng trúng số rồi nghỉ việc";
      const cut = words.indexOf(". ");
      const plan: IdeaPlan = {
        kind: (at("--kind") as "meme" | "comic") || (pics.length || /\. /.test(words) ? "meme" : "comic"),
        reply: pics.length ? "Ảnh là một câu than, làm clip chữ 2 nhịp." : "Làm clip chữ từ câu anh gõ.",
        read: pics.length ? words : "",
        lead: "cu-li",
        meme: { top: cut > 0 ? words.slice(0, cut + 1) : words, punch: cut > 0 ? words.slice(cut + 2) : "", scenes: ["Tũn vỗ vai đồng nghiệp", "Tũn ôm vé số mơ màng"] },
        comic: { direction: `Tũn ở văn phòng: ${words}`, with: [], headline: words },
        title: "Trúng số nghỉ việc",
        caption: "Ổn định là cho người khác #danvanphong #HoiSau",
      };
      writeFileSync(join(out, "idea.json"), JSON.stringify(plan, null, 2));
      return "";
    }
    if (args[0] === "meme" && at("--step") === "plan") {
      const out = at("--out");
      const spec = JSON.parse(readFileSync(join(out, "meme.json"), "utf8")) as MemeInput;
      // Same pacing as talk's memeTiming: the punchline once the first line is read.
      const read = (x: string) => 1 + x.trim().split(/\s+/).length * 0.28;
      const punchAt = +Math.max(2, read(spec.top)).toFixed(2);
      const end = +(spec.seconds || Math.max(6, punchAt + read(spec.punch) + 2.5)).toFixed(2);
      const shots: Shot[] = spec.scenes.map((note, i) => ({ id: `s0${i + 1}`, t: i ? punchAt : 0, act: note || "the lead at the office desk", pose: "blinks and moves a hand", bubble: "", cast: [] }));
      writeFileSync(join(out, "plan.json"), JSON.stringify({ slug: args[1], clip: "", end, lines: [{ text: spec.top, start: 0, end: punchAt }, { text: spec.punch, start: punchAt, end }], shots }, null, 2) + "\n");
      return "";
    }
    if (script === CHANNEL) {
      const platforms = args.slice(2);
      return platforms.map((p) => `hoi-sau ${p}: https://example.com/${p}/demo-post`).join("\n") + "\n";
    }
    const slug = args[1], out = at("--out"), step = at("--step");
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
    if (step === "gaps") writeFileSync(join(out, "gaps.json"), JSON.stringify([{ start: 1.85, end: 2.05 }].filter(() => plan.lines.length < 4)));
    if (step === "ask") {
      // Stands in for Muse Spark: a few notes it understands, anything else gets a question.
      const note = at("--note"), acts: FixAction[] = [];
      const base = { shot: "", line: -1, text: "", start: -1, end: -1, what: "", find: "" };
      if (/Mẹ/.test(note)) acts.push({ ...base, do: "line_text", line: 0, text: plan.lines[0].text.replace(/^\S+/, "Mẹ"), say: "Câu 1: đổi chữ đầu thành Mẹ" });
      if (/ghim/.test(note)) acts.push({ ...base, do: "fix_detail", shot: "s01", what: "remove the star pin on his back", find: "star pin", say: "Cảnh s01: bỏ ghim sao" });
      if (/thiếu tranh/.test(note)) acts.push({ ...base, do: "add_shot", start: 5, what: "the lead walks home at dusk", say: "Thêm cảnh từ 5s" });
      if (/Taeyang/.test(note)) acts.push({ ...base, do: "add_shot", start: 4.5, end: 5.0, what: "a stage far away with tiny faceless silhouettes", say: "Thêm cảnh sân khấu" });
      if (/đồng hồ/.test(note)) acts.push({ ...base, do: "fix_detail", shot: "s02", what: "remove the wall clock", find: "wall clock", say: "Cảnh s02: bỏ đồng hồ" });
      writeFileSync(join(out, "fixes.json"), JSON.stringify({ reply: acts.length ? "Sửa như anh nói" : "Anh muốn sửa cảnh nào?", actions: acts }));
      return "";
    }
    if (step === "fix")
      for (const [i, s] of plan.shots.entries())
        if (only?.includes(s.id)) {
          copyFileSync(join(dir, `${s.id}.png`), join(dir, `${s.id}-prev.png`));
          log(`${s.id}: fixing (${at("--note")})`);
          await picture(join(dir, `${s.id}.png`), `${s.id} A fixed`, hue(i) + 5);
          // Like talk: a fix found by --find is carried into pose B and the mouths; a whole new picture drops them.
          if (!at("--find")) for (const p of [`${s.id}-s`, `${s.id}-m`, `${s.id}-b`, `${s.id}-b2`, `${s.id}-b2-s`, `${s.id}-b2-m`]) rmSync(join(dir, `${p}.png`), { force: true });
        }
    if (step === "poses")
      for (const [i, s] of plan.shots.entries()) if (s.pose && pick(s) && (only || !existsSync(join(dir, `${s.id}-b.png`)))) (log(`${s.id}: second pose`), await picture(join(dir, `${s.id}-b.png`), `${s.id} B`, hue(i) + 20));
    if (step === "stabilize") {
      const report = [];
      for (const s of plan.shots.filter((x) => pick(x) && existsSync(join(dir, `${x.id}-b.png`)))) {
        const ok = s.id !== "s02";
        // Pose B on pose A's background: only the middle (the character) changes.
        if (ok) await sharp(join(dir, `${s.id}.png`)).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><circle cx="600" cy="860" r="240" fill="hsl(200, 40%, 55%)"/></svg>`) }]).png().toFile(join(dir, `${s.id}-b2.png`));
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
