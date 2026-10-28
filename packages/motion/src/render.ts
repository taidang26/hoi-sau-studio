/**
 * Lettered panels → one vertical motion comic (MP4, 9:16) for Reels and Threads.
 *
 * Each panel becomes its own clip first (blurred copy of the panel as the
 * background, the panel itself under a slow camera move), cached by a key of
 * its inputs, so changing one panel re-renders one clip. The clips are then
 * joined with crossfades and an audio track.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { type CameraMove, isPreset, type MovePreset, preset, zoompanExprs } from "./camera.js";
import { ffmpeg, ffprobePath, MotionError, run, stageFont } from "./ffmpeg.js";
import { toSrt, type Cue } from "./srt.js";
import { drawTextFilters, type TextBlock } from "./text.js";

/** xfade transition names; see `ffmpeg -h filter=xfade`. */
export type Transition = "fade" | "fadeblack" | "fadewhite" | "slideleft" | "slideup" | "wipeleft" | "circleopen" | "smoothleft" | "none";

export interface Shot {
  /** Lettered panel (PNG/JPEG/WebP), absolute or relative to the spec's baseDir. */
  image: string;
  /** Seconds on screen, including the transition into the next shot. */
  duration: number;
  move?: CameraMove | MovePreset;
  /** Dialogue already drawn on the panel; used for the subtitle file only. */
  dialogue?: { speaker?: string; text: string }[];
  /**
   * Transparent overlays the size of the panel (speech bubbles) that stay
   * still while the art under them moves, each fading in at `at` seconds.
   */
  layers?: { image: string; at: number }[];
  /** Transition into the next shot; defaults to the spec's. */
  transition?: Transition;
}

export interface Card {
  /** Background image; defaults to the first shot's panel. */
  image?: string;
  blocks: TextBlock[];
  duration?: number;
}

export interface MotionSpec {
  shots: Shot[];
  width?: number;
  height?: number;
  fps?: number;
  /** Small label at the top of every panel clip, e.g. "HỒI SAU · TẬP 3". */
  header?: string;
  /** Hook title kept at the top of every panel clip, inside `area`, above the panel. */
  title?: string;
  /**
   * Where everything that matters stays (on a 1080x1920 frame, scaled for drafts):
   * the platforms' safe area. The panel fits inside it under the title; only the
   * blurred backdrop runs out to the edges.
   */
  area?: Area;
  /** Text-only clip before the first panel. */
  intro?: Card;
  /** Text-only clip after the last panel: the call to comment. */
  outro?: Card;
  transition?: { kind: Transition; duration: number };
  /** Background music, looped and faded; silent track when omitted. */
  audio?: { file: string; volume?: number };
  /** TTF/OTF with Vietnamese glyphs for header and cards. */
  font?: string;
  /** "draft" renders 540x960 quickly for previews and tests. */
  quality?: "draft" | "final";
  /** Resolves relative image paths. */
  baseDir?: string;
}

export interface Segment {
  kind: "intro" | "shot" | "outro";
  index?: number;
  start: number;
  end: number;
}

export interface MotionResult {
  video: string;
  cover: string;
  subtitles: string;
  /** Seconds. */
  duration: number;
  width: number;
  height: number;
  segments: Segment[];
}

interface Ctx {
  W: number;
  H: number;
  fps: number;
  upscale: number;
  font?: string;
  workDir: string;
  baseDir: string;
  draft: boolean;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export async function imageSize(file: string): Promise<{ width: number; height: number }> {
  const { stdout } = await run(ffprobePath(), [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", file,
  ]);
  const [w, h] = stdout.trim().split("x").map(Number);
  if (!w || !h) throw new MotionError(`Could not read the size of ${file}`);
  return { width: w, height: h };
}

export interface Area {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * What TikTok, Reels and Shorts leave uncovered on a 1080x1920 video: their top
 * bar, the caption/name/music block at the bottom and the button column on the
 * right sit on everything outside.
 */
export const PLATFORM_SAFE: Area = { left: 60, top: 250, right: 940, bottom: 1480 };

/** The title band at the top of `area`, on a 1080-wide frame. */
export const TITLE_BAND = 170;

/**
 * Where the panel sits in the frame: full width, leaving room at top and bottom
 * for the app's UI; with an `area` (1080x1920 units), as large as fits inside
 * it below the title band.
 */
export function panelBox(img: { width: number; height: number }, W: number, H: number, area?: Area) {
  if (area) {
    const s = W / 1080;
    const top = (area.top + TITLE_BAND) * s, left = area.left * s;
    const maxW = (area.right - area.left) * s, maxH = (area.bottom - area.top - TITLE_BAND) * s;
    const k = Math.min(maxW / img.width, maxH / img.height);
    const w = even(img.width * k), h = even(img.height * k);
    return { w, h, x: Math.round(left + (maxW - w) / 2), y: Math.round(top), top: Math.round(area.top * s) };
  }
  const reserve = Math.round(H * 0.135);
  const maxH = H - 2 * reserve;
  let w = W;
  let h = (W * img.height) / img.width;
  if (h > maxH) {
    h = maxH;
    w = (maxH * img.width) / img.height;
  }
  w = even(w);
  h = even(h);
  return { w, h, x: Math.round((W - w) / 2), y: Math.round(reserve + (maxH - h) / 2), top: reserve };
}

const resolveImage = (ctx: Ctx, p: string) => (isAbsolute(p) ? p : resolve(ctx.baseDir, p));

/** Cache key of a clip: its settings plus the image's size and mtime. */
function clipKey(ctx: Ctx, parts: unknown, images: string[]): string {
  const h = createHash("sha1");
  h.update(JSON.stringify({ W: ctx.W, H: ctx.H, fps: ctx.fps, up: ctx.upscale, font: ctx.font, parts }));
  for (const img of images) {
    const st = statSync(img);
    h.update(`${img}:${st.size}:${st.mtimeMs}`);
  }
  return h.digest("hex").slice(0, 16);
}

function cached(out: string, key: string): boolean {
  const k = `${out}.key`;
  return existsSync(out) && existsSync(k) && readFileSync(k, "utf8") === key;
}

const encodeArgs = (ctx: Ctx) => [
  "-c:v", "libx264",
  "-preset", ctx.draft ? "ultrafast" : "medium",
  "-crf", ctx.draft ? "28" : "18",
  "-pix_fmt", "yuv420p",
  "-r", String(ctx.fps),
];

const background = (ctx: Ctx, input: string) =>
  `${input}scale=${ctx.W}:${ctx.H}:force_original_aspect_ratio=increase,crop=${ctx.W}:${ctx.H},` +
  `boxblur=${Math.round(ctx.W / 40)}:2,eq=brightness=-0.18:saturation=0.75,setsar=1`;

async function renderShot(ctx: Ctx, shot: Shot, index: number, header?: string, title?: string, area?: Area): Promise<string> {
  const image = resolveImage(ctx, shot.image);
  if (!existsSync(image)) throw new MotionError(`Panel not found: ${image}`);
  const out = join(ctx.workDir, `shot-${String(index + 1).padStart(2, "0")}.mp4`);
  const move = typeof shot.move === "string" ? preset(shot.move) : (shot.move ?? preset("hold"));
  const layers = (shot.layers ?? []).map((l) => ({ ...l, image: resolveImage(ctx, l.image) }));
  const key = clipKey(ctx, { move, d: shot.duration, header, title, area, at: layers.map((l) => l.at) }, [image, ...layers.map((l) => l.image)]);
  if (cached(out, key)) return out;

  const frames = Math.max(2, Math.round(shot.duration * ctx.fps));
  const size = await imageSize(image);
  const box = panelBox(size, ctx.W, ctx.H, area);
  const z = zoompanExprs(move, frames);
  const s = ctx.W / 1080;
  const headerFilters = [
    ...(header ? drawTextFilters({ text: header, fontSize: Math.round(ctx.W / 26), y: box.top * 0.45, color: "white" }, ctx.W, ctx.workDir, ctx.font) : []),
    // The hook title, inside the safe area's top band; two lines at most.
    ...(title && area
      ? drawTextFilters({ text: title, fontSize: Math.round(54 * s), y: Math.round((area.top + 24) * s), width: (area.right - area.left - 40) * s, cx: ((area.left + area.right) / 2) * s, color: "#FFD45C", border: Math.round(5 * s) }, ctx.W, ctx.workDir, ctx.font)
      : []),
  ];

  const secs = String(frames / ctx.fps);
  const graph = [
    `[0:v]${background(ctx, "")}[bg]`,
    `[1:v]scale=${box.w * ctx.upscale}:${box.h * ctx.upscale},setsar=1,` +
      `zoompan=z='${z.z}':x='${z.x}':y='${z.y}':d=${frames}:s=${box.w}x${box.h}:fps=${ctx.fps},format=rgba[fg0]`,
    ...layers.flatMap((l, j) => [
      `[${2 + j}:v]scale=${box.w}:${box.h},format=rgba,fade=t=in:st=${l.at}:d=0.18:alpha=1[l${j}]`,
      `[fg${j}][l${j}]overlay=0:0:shortest=1[fg${j + 1}]`,
    ]),
    `[bg][fg${layers.length}]overlay=x=${box.x}:y=${box.y}:shortest=1${headerFilters.length ? "," + headerFilters.join(",") : ""},format=yuv420p[v]`,
  ].join(";");

  await ffmpeg(
    [
      "-loop", "1", "-framerate", String(ctx.fps), "-t", secs, "-i", image,
      "-i", image,
      ...layers.flatMap((l) => ["-loop", "1", "-framerate", String(ctx.fps), "-t", secs, "-i", l.image]),
      "-filter_complex", graph,
      "-map", "[v]", "-frames:v", String(frames), ...encodeArgs(ctx), out,
    ],
    ctx.workDir,
  );
  writeFileSync(`${out}.key`, key);
  return out;
}

async function renderCard(ctx: Ctx, card: Card, name: string, fallbackImage: string): Promise<string> {
  const image = resolveImage(ctx, card.image ?? fallbackImage);
  const out = join(ctx.workDir, `${name}.mp4`);
  const duration = card.duration ?? 2;
  const key = clipKey(ctx, { blocks: card.blocks, duration }, [image]);
  if (cached(out, key)) return out;

  // Card text is laid out for 1080 wide; scale it to the frame.
  const s = ctx.W / 1080;
  const text = card.blocks.flatMap((b) =>
    drawTextFilters({ ...b, fontSize: Math.round(b.fontSize * s), y: b.y * s, width: b.width && b.width * s, cx: b.cx === undefined ? undefined : b.cx * s }, ctx.W, ctx.workDir, ctx.font),
  );
  const graph = `[0:v]${background(ctx, "")},drawbox=x=0:y=0:w=iw:h=ih:color=black@0.35:t=fill${text.length ? "," + text.join(",") : ""},format=yuv420p[v]`;
  await ffmpeg(
    [
      "-loop", "1", "-framerate", String(ctx.fps), "-t", String(duration), "-i", image,
      "-filter_complex", graph, "-map", "[v]", "-frames:v", String(Math.round(duration * ctx.fps)), ...encodeArgs(ctx), out,
    ],
    ctx.workDir,
  );
  writeFileSync(`${out}.key`, key);
  return out;
}

export interface Clip {
  file: string;
  duration: number;
  /** Transition into the next clip. */
  transition: Transition;
}

/** Start time of each clip once consecutive clips overlap by the transition. */
export function timeline(clips: { duration: number; transition: Transition }[], fade: number): { starts: number[]; total: number } {
  const starts: number[] = [];
  let t = 0;
  clips.forEach((c, i) => {
    starts.push(round3(t));
    const overlap = i < clips.length - 1 && c.transition !== "none" ? fade : 0;
    t += c.duration - overlap;
  });
  return { starts, total: round3(t) };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** filter_complex that joins clips with xfade (or plain concat for "none"). */
export function joinGraph(clips: Clip[], fade: number, fps = 30): string {
  if (clips.length === 1) return "[0:v]settb=AVTB,setpts=PTS-STARTPTS[v]";
  const parts = clips.map((_, i) => `[${i}:v]settb=AVTB,setpts=PTS-STARTPTS,fps=${fps}[c${i}]`);
  let prev = "c0";
  let acc = clips[0].duration;
  for (let i = 1; i < clips.length; i++) {
    const t = clips[i - 1].transition;
    const label = i === clips.length - 1 ? "v" : `x${i}`;
    if (t === "none") {
      parts.push(`[${prev}][c${i}]concat=n=2:v=1:a=0[${label}]`);
    } else {
      acc -= fade;
      parts.push(`[${prev}][c${i}]xfade=transition=${t}:duration=${fade}:offset=${round3(acc)}[${label}]`);
    }
    acc += clips[i].duration;
    prev = label;
  }
  return parts.join(";");
}

export async function renderMotionComic(spec: MotionSpec, outDir: string): Promise<MotionResult> {
  if (!spec.shots.length) throw new MotionError("A motion comic needs at least one shot.");
  const draft = spec.quality === "draft";
  const W = spec.width ?? (draft ? 540 : 1080);
  const H = spec.height ?? (draft ? 960 : 1920);
  const fps = spec.fps ?? 30;
  const workDir = join(outDir, "work");
  mkdirSync(workDir, { recursive: true });
  const ctx: Ctx = {
    W, H, fps, draft, workDir,
    upscale: draft ? 2 : 4,
    font: stageFont(workDir, spec.font),
    baseDir: spec.baseDir ?? process.cwd(),
  };
  const fade = spec.transition?.kind === "none" ? 0 : (spec.transition?.duration ?? 0.4);
  const defaultT: Transition = spec.transition?.kind ?? "fade";
  const firstImage = spec.shots[0].image;

  const clips: (Clip & Omit<Segment, "start" | "end">)[] = [];
  if (spec.intro) {
    const d = spec.intro.duration ?? 2;
    clips.push({ kind: "intro", file: await renderCard(ctx, { ...spec.intro, duration: d }, "intro", firstImage), duration: d, transition: "fadeblack" });
  }
  for (const [i, shot] of spec.shots.entries()) {
    clips.push({ kind: "shot", index: i, file: await renderShot(ctx, shot, i, spec.header, spec.title, spec.area), duration: shot.duration, transition: shot.transition ?? defaultT });
  }
  if (spec.outro) {
    const d = spec.outro.duration ?? 3;
    clips.push({ kind: "outro", file: await renderCard(ctx, { ...spec.outro, duration: d }, "outro", spec.shots.at(-1)!.image), duration: d, transition: "none" });
  }
  // Fades never run longer than the shortest clip allows.
  const minClip = Math.min(...clips.map((c) => c.duration));
  const f = Math.min(fade, minClip / 2);
  const { starts, total } = timeline(clips, f);

  const video = join(outDir, "reel.mp4");
  const audioIn = spec.audio
    ? ["-stream_loop", "-1", "-i", resolveImage(ctx, spec.audio.file)]
    : ["-f", "lavfi", "-t", String(total), "-i", "anullsrc=r=48000:cl=stereo"];
  const a = clips.length;
  const audioGraph = spec.audio
    ? `[${a}:a]atrim=0:${total},asetpts=PTS-STARTPTS,volume=${spec.audio.volume ?? 0.6},afade=t=in:d=0.5,afade=t=out:st=${Math.max(0, total - 1.5)}:d=1.5[a]`
    : `[${a}:a]anull[a]`;
  await ffmpeg(
    [
      ...clips.flatMap((c) => ["-i", c.file]),
      ...audioIn,
      "-filter_complex", `${joinGraph(clips, f, fps)};${audioGraph}`,
      "-map", "[v]", "-map", "[a]",
      ...encodeArgs(ctx),
      "-profile:v", "high", "-g", String(fps * 2),
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
      "-t", String(total), "-movflags", "+faststart",
      video,
    ],
    workDir,
  );

  const cover = join(outDir, "cover.jpg");
  // The first panel clip, a beat after it settles, makes the most telling thumbnail.
  const firstShot = clips.findIndex((c) => c.kind === "shot");
  const coverAt = Math.min(total - 0.1, starts[firstShot] + Math.min(1, clips[firstShot].duration / 2));
  await ffmpeg(["-ss", String(coverAt), "-i", video, "-frames:v", "1", "-q:v", "2", cover], workDir);

  const segments: Segment[] = clips.map((c, i) => ({
    kind: c.kind,
    index: c.index,
    start: starts[i],
    end: round3(starts[i] + c.duration),
  }));
  const cues: Cue[] = [];
  segments.forEach((seg) => {
    if (seg.kind !== "shot") return;
    const lines = spec.shots[seg.index!].dialogue ?? [];
    cues.push(...spreadCues(lines.map((l) => l.text), seg.start, seg.end));
  });
  const subtitles = join(outDir, "subs.srt");
  writeFileSync(subtitles, toSrt(cues), "utf8");

  const result: MotionResult = { video, cover, subtitles, duration: total, width: W, height: H, segments };
  writeFileSync(join(outDir, "motion.json"), JSON.stringify({ ...result, video: basename(video), cover: basename(cover), subtitles: basename(subtitles), spec }, null, 2) + "\n");
  return result;
}

/** Splits a clip's time across its lines in proportion to their length. */
export function spreadCues(lines: string[], start: number, end: number): Cue[] {
  const total = lines.reduce((n, l) => n + Math.max(1, [...l].length), 0);
  let t = start;
  return lines.map((text) => {
    const d = ((end - start) * Math.max(1, [...text].length)) / total;
    const cue = { start: round3(t), end: round3(t + d), text };
    t += d;
    return cue;
  });
}
