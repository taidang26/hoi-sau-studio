/**
 * Illustrated voice-over videos, the way cartoon narration pages make them:
 * the clip's original voice, cut where the clip cuts, and for every shot one
 * full-frame picture of our character acting out what is said, a short speech
 * bubble of our own and word-by-word captions. The character moves by
 * switching between two poses of the same picture on the caption beats; the
 * background stays pixel-identical between them (stabilize). No camera moves.
 *
 *   plan       MMS-1B word times of the voice → lines → the clip's cuts → Muse Spark writes each shot
 *   draw       Muse Image draws each shot; Muse Spark checks it (on-model, once, no text, things face the right way) and it is redrawn on a fail
 *   poses      a second pose of each shot (Muse Image edit), checked the same way
 *   stabilize  SAM 3.1 masks the character in both poses; pose B keeps pose A's background outside them
 *   mouths     (--mouth) a mouth-open copy of each picture: Muse Image opens the lead's mouth, SAM 3.1 finds it and only the mouth is pasted in
 *   render     1080x1920 with the original audio; with --mouth the lead's mouth opens and shuts with the voice
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { DELIVERY } from "@hoi-sau/motion";
import { characterRefs, generateSoftly, S, styleReference, styleText, type ChatMessage, type StudioContext } from "@hoi-sau/studio";
import type { Sam } from "@hoi-sau/dance";
import { COMIC_FONT_PATH, escapeXml, loadFont, measure, svgToPng } from "@hoi-sau/svg-text";
import { captionSvg } from "./captions.js";
import { chunkWords, OUT, SAFE, type Chunk, type Word } from "./timeline.js";
import { align, grow, maskBox, unionBox, writePng, type Box, type Raster } from "./patch.js";
import { python } from "./voice.js";

export interface Line {
  text: string;
  start: number;
  end: number;
}

export interface Shot {
  id: string;
  /** Start time in the clip. */
  t: number;
  /** English, for Muse Image: the character acting out the shot's words. */
  act: string;
  /** English: the next moment of the same picture, for the second pose; empty for none. */
  pose: string;
  /** Our own words in the speech bubble (Vietnamese, short); empty for none. */
  bubble: string;
  /** Cast slugs in the picture besides the lead. */
  cast: string[];
  /**
   * What moves between the two poses, for SAM (stabilize): the characters by
   * default; add what they hold or wear (ice pack, badge, sheet of paper) so no
   * copy of it stays behind, or name only some of them to keep the rest still.
   */
  moving?: string[];
  /** Reuse another shot's pictures (a cut back to it). */
  src?: string;
}

export interface Plan {
  slug: string;
  clip: string;
  end: number;
  lines: Line[];
  shots: Shot[];
}

// ---------------------------------------------------------------- pure parts

/** Words into spoken lines, split where the voice pauses at least `gap` seconds. */
export function groupLines(words: Word[], gap = 0.45): Line[] {
  const out: Line[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) out.push({ text: cur.map((w) => w.text).join(" "), start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  };
  for (const w of words) {
    if (cur.length && w.start - cur[cur.length - 1].end >= gap) flush();
    cur.push(w);
  }
  flush();
  return out;
}

/** Shot-change times from ffmpeg's showinfo output (select='gt(scene,x)'). */
export function parseCuts(log: string): number[] {
  return [...log.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 0.3);
}

/** One shot per stretch between cuts; each line belongs to the shot it starts in. */
export function shotSpans(lines: Line[], cuts: number[], end: number): Array<{ t: number; end: number; lines: number[] }> {
  const starts = [0, ...cuts.filter((c) => c > 0 && c < end)].sort((a, b) => a - b);
  return starts
    .map((t, i) => {
      const e = starts[i + 1] ?? end;
      return { t, end: e, lines: lines.map((l, k) => (l.start >= t - 0.15 && l.start < e - 0.15 ? k : -1)).filter((k) => k >= 0) };
    })
    .filter((s) => s.end - s.t > 0.2);
}

/** Corrected line texts timed by the recogniser's words: one to one when the counts match, else spread by length. */
export function timeWords(lines: Line[], heard: Word[]): Word[] {
  const out: Word[] = [];
  for (const l of lines) {
    const said = heard.filter((w) => w.start >= l.start - 0.05 && w.start < l.end);
    const toks = l.text.split(/\s+/).filter(Boolean);
    if (said.length === toks.length) toks.forEach((t, k) => out.push({ text: t, start: said[k].start, end: said[k].end }));
    else {
      const total = toks.reduce((n, t) => n + t.length, 0) || 1;
      let at = l.start;
      for (const t of toks) {
        const d = ((l.end - l.start) * t.length) / total;
        out.push({ text: t, start: at, end: at + d });
        at += d;
      }
    }
  }
  return out;
}

/**
 * Rows of flat colour at the top and bottom of a greyscale picture (w×h): Muse
 * sometimes draws a smaller picture inside the 9:16 frame and fills the rest.
 */
export function flatBands(grey: Uint8Array, w: number, h: number, maxVar = 16): { top: number; bottom: number } {
  const flat = (y: number) => {
    let sum = 0, sq = 0;
    for (let x = 0; x < w; x++) { const v = grey[y * w + x]; sum += v; sq += v * v; }
    const m = sum / w;
    return sq / w - m * m < maxVar;
  };
  let top = 0, bottom = 0;
  while (top < h / 2 && flat(top)) top++;
  while (bottom < h / 2 && flat(h - 1 - bottom)) bottom++;
  return { top, bottom };
}

/**
 * Why a drawn picture is not a full 1080x1920 frame, or "" when it is: a wrong
 * aspect, or empty bands (both ends over 6% of the height, or one over 15%).
 * A plain wall or floor at one end stays under those.
 */
export function frameProblem(width: number, height: number, bands: { top: number; bottom: number }): string {
  if (Math.abs(width / height - 9 / 16) > 0.02) return `the picture is ${width}x${height}, not 9:16`;
  const t = bands.top / height, b = bands.bottom / height;
  if ((t > 0.06 && b > 0.06) || t > 0.15 || b > 0.15) return `empty colour bands (${bands.top}px top, ${bands.bottom}px bottom): the picture must fill the whole 9:16 frame`;
  return "";
}

async function frameCheck(png: Buffer): Promise<string> {
  const { width = 0, height = 0 } = await sharp(png).metadata();
  const grey = new Uint8Array(await sharp(png).resize(OUT.w, OUT.h, { fit: "fill" }).greyscale().raw().toBuffer());
  return frameProblem(width, height, flatBands(grey, OUT.w, OUT.h));
}

/** Which pose a moment shows: the poses take turns on each caption chunk inside the shot, or on each word when the shot has one chunk. */
export function poseAt(chunks: Chunk[], chunk: number, shotStart: number, poses: number, word = 0, shotEnd = Infinity): number {
  if (poses < 2 || chunk < 0) return 0;
  const first = chunks.findIndex((c) => c.end > shotStart);
  // A short shot with a single caption chunk would hold one pose: switch on its words instead.
  const inShot = chunks.filter((c) => c.end > shotStart && c.start < shotEnd).length;
  if (inShot <= 1) return word % poses;
  return Math.max(0, chunk - first) % poses;
}

/** The bubble pops in: a bit small, a bit big, then its size. Null before it shows. */
export const POP: Array<[number, number]> = [[0, 0.82], [0.05, 1.06], [0.11, 1]];
export function popScale(since: number): number | null {
  if (since < -1e-6) return null;
  return [...POP].reverse().find(([d]) => since >= d - 1e-6)![1];
}

/** Square dilation of a 0/1 mask by r pixels. */
export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let d = -r; d <= r && !v; d++) { const xx = x + d; if (xx >= 0 && xx < w && mask[y * w + xx]) v = 1; }
      tmp[y * w + x] = v;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let d = -r; d <= r && !v; d++) { const yy = y + d; if (yy >= 0 && yy < h && tmp[yy * w + x]) v = 1; }
      out[y * w + x] = v;
    }
  return out;
}

export interface Warp { k: number; dx: number; dy: number; err: number }

/** Where pixel (x, y) of A comes from in B under scale k about the centre and shift (dx, dy); -1 off the picture. */
export function warpIndex(w: number, h: number, t: Pick<Warp, "k" | "dx" | "dy">, x: number, y: number): number {
  const sx = Math.round((x - w / 2 - t.dx) / t.k + w / 2), sy = Math.round((y - h / 2 - t.dy) / t.k + h / 2);
  return sx < 0 || sy < 0 || sx >= w || sy >= h ? -1 : sy * w + sx;
}

/** The scale and shift that best lay B's background (RGB, w×h) over A's, judged where `keep` is set. */
export function alignBackground(a: Uint8Array, b: Uint8Array, w: number, h: number, keep: Uint8Array, opts: { range?: number; scales?: [number, number] } = {}): Warp {
  const range = opts.range ?? 48;
  const [k0, k1] = opts.scales ?? [0.92, 1.08];
  const score = (t: Omit<Warp, "err">, step: number) => {
    let e = 0, n = 0;
    for (let y = 0; y < h; y += step)
      for (let x = 0; x < w; x += step) {
        const i = y * w + x;
        if (!keep[i]) continue;
        const j = warpIndex(w, h, t, x, y);
        if (j < 0) continue;
        e += Math.abs(a[i * 3] - b[j * 3]) + Math.abs(a[i * 3 + 1] - b[j * 3 + 1]) + Math.abs(a[i * 3 + 2] - b[j * 3 + 2]);
        n++;
      }
    return n ? e / n / 3 : Infinity;
  };
  const coarse = Math.max(1, Math.round(w / 90));
  let best: Warp = { k: 1, dx: 0, dy: 0, err: Infinity };
  for (let k = k0; k <= k1 + 1e-9; k += 0.01)
    for (let dx = -range; dx <= range; dx += Math.max(1, Math.round(range / 6)))
      for (let dy = -range; dy <= range; dy += Math.max(1, Math.round(range / 6))) {
        const e = score({ k, dx, dy }, coarse);
        if (e < best.err) best = { k, dx, dy, err: e };
      }
  const c = { ...best }, fine = Math.max(1, Math.round(range / 24));
  for (let k = c.k - 0.01; k <= c.k + 0.0101; k += 0.0025)
    for (let dx = c.dx - 4 * fine; dx <= c.dx + 4 * fine; dx += fine)
      for (let dy = c.dy - 4 * fine; dy <= c.dy + 4 * fine; dy += fine) {
        const e = score({ k, dx, dy }, Math.max(1, coarse >> 1));
        if (e < best.err) best = { k, dx, dy, err: e };
      }
  return best;
}

// ---------------------------------------------------------------- the steps

const ASR = fileURLToPath(new URL("../tts/asr.py", import.meta.url));

/** MMS-1B-all (Vietnamese) word times of the voice in `audio` (a vocal stem works best). */
export async function hearWords(audio: string, out: string): Promise<Word[]> {
  await new Promise<void>((ok, fail) => {
    const p = spawn(python(), [ASR, audio, out], { stdio: "inherit" });
    p.on("error", fail);
    p.on("close", (code) => (code === 0 ? ok() : fail(new Error(`asr.py exited with ${code}`))));
  });
  return JSON.parse(readFileSync(out, "utf8")).map((w: { text: string; start: number; end: number }) => ({ text: w.text, start: w.start, end: w.end }));
}

export function sceneCuts(clip: string, threshold = 0.2): number[] {
  const r = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-i", clip, "-vf", `select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 << 20 });
  return parseCuts(r.stderr ?? "");
}

const PLAN = S.obj({
  shots: S.arr(
    S.obj({
      act: S.str("English, one sentence: the lead character acting out exactly what these words say, with the 1-3 props they need, and which way things face; if the words name a time, say what time a clock in the picture shows"),
      pose: S.str("English: the next moment of the same picture, a different pose or expression; same place, same props"),
      bubble: S.str("Vietnamese, at most 7 words, our own punchy words for this beat (never copy the spoken line)"),
      cast: S.arr(S.str("slug of another cast member, only if the words need one"), 0, 2),
    }),
  ),
});

/** Muse Spark writes one shot per stretch of the clip. */
export async function planShots(ctx: StudioContext, slug: string, lines: Line[], spans: ReturnType<typeof shotSpans>): Promise<Shot[]> {
  const p = ctx.profiles.get(slug);
  if (!p) throw new Error(`No character "${slug}".`);
  const cast = [...ctx.profiles.values()].filter((c) => c.slug !== slug).map((c) => `${c.slug} = ${c.name} (${c.species}, ${c.role})`).join("; ");
  const beats = spans.map((s, i) => `Shot ${i + 1} (${s.t.toFixed(1)}-${s.end.toFixed(1)} s): ${s.lines.map((k) => lines[k].text).join(" ") || "(no words)"}`).join("\n");
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        `A narrated Vietnamese short video is being remade with our cartoon character ${p.name} (${p.species}, ${p.role}) as the narrator, acting out each beat in our office comic.`,
        `For each shot write: what ${p.name} does in the picture (act), a second pose for the same picture (pose), a short speech bubble in our own words (bubble), and any other cast member the words really need (cast; others: ${cast}).`,
        "Keep each picture simple: one clear action, a strong expression, two or three props. Screens face whoever uses them.",
        "When the words name a time (4 giờ chiều, 8 giờ sáng), any clock in that shot and the next ones shows that time, so write it into act and pose; leave the clock out when no time is said.",
        beats,
      ].join("\n\n"),
    },
  ];
  const r = await ctx.spark.json<{ shots: Array<Omit<Shot, "id" | "t">> }>("illustrate_plan", PLAN, messages);
  return spans.map((s, i) => ({ id: `s${String(i + 1).padStart(2, "0")}`, t: s.t, act: r.shots[i]?.act ?? "", pose: r.shots[i]?.pose ?? "", bubble: r.shots[i]?.bubble ?? "", cast: r.shots[i]?.cast ?? [] }));
}

/** The look Tài asked for: big character with a strong expression, a lazy sketchy background, nothing extra. */
export const LOOK = [
  "Comic approach like a simple webcomic: flat colours and a thick dark outline in the series line style; the main character big, filling about half of the frame, with a strong, clear facial expression that sells the joke.",
  "The background is drawn loosely and lazily: a few sketchy lines and pale flat colour washes, with at most two to four simple props, only the ones the scene needs. No crowd, no extra people; anyone else is drawn simply and faded.",
  "No sparkles, stars, hearts, sweat drops, anger marks, motion lines, speed lines, dust puffs or emoji-like symbols.",
  "Objects face the right way: a screen faces whoever is using it, a character's body faces what he works on, paws hold things naturally, every character has exactly two arms.",
  "The picture fills the whole frame edge to edge: no borders, no empty colour bands at the top or bottom. Keep the top fifth and the bottom fifth calm (a speech bubble and captions go there).",
  "Only draw a computer or phone when the scene needs one; a screen nobody in the scene uses never glows toward the viewer.",
  "Absolutely no text, letters, numbers, signs, speech bubbles or captions anywhere; a clock shows hands only, at the time the scene asks.",
].join(" ");

const CHECK = S.obj({ pass: S.bool(), problems: S.arr(S.str("one concrete problem"), 0, 8), fix: S.str("English edit instruction naming only what to change, or empty if pass") });

const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`;

/** Muse Spark looks at one picture: on-model, drawn once, no text, physical and orientation logic. */
export async function checkPicture(ctx: StudioContext, slug: string, act: string, png: Buffer): Promise<{ pass: boolean; problems: string[]; fix: string }> {
  const p = ctx.profiles.get(slug)!;
  const sheet = characterRefs(ctx, slug)[0];
  const content: ChatMessage["content"] = [
    {
      type: "text",
      text: [
        `You check one frame of a short comic video before it is posted. The first image is the frame, the second is ${p.name}'s model sheet.`,
        `The frame should show: ${act}.`,
        `Fail it for: ${p.name} off-model (${p.look.signature.join("; ")}); ${p.name} drawn more than once (unless the scene asks for a copy such as a ghost); any drawn text, letters, numbers or speech bubble; a human;`,
        "extra arms or hands, a paw holding something wrongly; objects facing the wrong way (a monitor or phone screen must face the character using it, his body must face what he works on; eyes may look at the viewer); a clock with more or fewer than two hands, or a clock showing a different time from the one asked;",
        "a busy background (crowds, many props) or sparkles, sweat drops, motion lines; a glowing screen facing the viewer while the character uses it; a misshapen or broken prop (a wallet must look like a normal bifold wallet); empty colour bands across the top or bottom.",
        "If it fails, write the fix as a short edit instruction.",
      ].join(" "),
    },
    { type: "image_url", image_url: { url: dataUrl(png) } },
    ...(sheet ? [{ type: "image_url" as const, image_url: { url: sheet } }] : []),
  ];
  return ctx.spark.json("frame_check", CHECK, [{ role: "user", content }]);
}

export async function drawShots(ctx: StudioContext, plan: Plan, dir: string, opts: { only?: string[]; tries?: number; log?: (s: string) => void } = {}): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const p = ctx.profiles.get(plan.slug)!;
  const lead = `${p.name}: ${p.look.description.replace(/\s+/g, " ")} Exactly as in the character reference sheet`;
  const style = styleReference(ctx.style);
  for (const s of plan.shots) {
    const file = join(dir, `${s.id}.png`);
    if (s.src || (opts.only ? !opts.only.includes(s.id) : existsSync(file))) continue;
    const refs = [...characterRefs(ctx, plan.slug), ...s.cast.flatMap((c) => characterRefs(ctx, c)), ...(style ? [style] : [])];
    const prompt = `Full-frame vertical illustration for a short comedy video, one scene. ${lead}. Scene: ${s.act}. ${LOOK} ${ctx.style ? `Style: ${styleText(ctx.style)}` : ""} Draw ${p.name} exactly once.`;
    let fix = "";
    for (let attempt = 0; attempt < (opts.tries ?? 3); attempt++) {
      opts.log?.(`${s.id}: drawing${fix ? ` again (${fix})` : ""}`);
      const res = await generateSoftly(ctx.image, { prompt: prompt + (fix ? ` Make sure: ${fix}` : ""), size: `${OUT.w}x${OUT.h}`, references: refs }, opts.log);
      writeFileSync(file, res.image);
      const frame = await frameCheck(res.image);
      const v = frame ? { pass: false, problems: [frame], fix: "Draw the scene to fill the whole vertical 9:16 frame edge to edge, continuing the wall up and the floor down; no empty bands." } : await checkPicture(ctx, plan.slug, s.act, res.image);
      opts.log?.(`${s.id}: ${v.pass ? "check passed" : `check failed: ${v.problems.join("; ")}`}`);
      if (v.pass) break;
      fix = v.fix;
    }
  }
}

export async function drawPoses(ctx: StudioContext, plan: Plan, dir: string, opts: { only?: string[]; log?: (s: string) => void } = {}): Promise<void> {
  const p = ctx.profiles.get(plan.slug)!;
  for (const s of plan.shots) {
    const base = join(dir, `${s.id}.png`), file = join(dir, `${s.id}-b.png`);
    if (s.src || !s.pose || !existsSync(base) || (opts.only ? !opts.only.includes(s.id) : existsSync(file))) continue;
    const prompt = `Edit the attached picture into the next moment of the same animation: ${s.pose}. Keep exactly the same framing, camera, background, colours, line style, props and the same character design (${p.name}); only the pose and expression change, the body stays in the same place and size. ${LOOK}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      opts.log?.(`${s.id}: second pose`);
      const res = await generateSoftly(ctx.image, { prompt, size: `${OUT.w}x${OUT.h}`, references: [dataUrl(readFileSync(base)), ...characterRefs(ctx, plan.slug)] }, opts.log);
      writeFileSync(file, res.image);
      const v = await checkPicture(ctx, plan.slug, `${s.act}; now: ${s.pose}`, res.image);
      opts.log?.(`${s.id}-b: ${v.pass ? "check passed" : `check failed: ${v.problems.join("; ")}`}`);
      if (v.pass) break;
    }
  }
}

const rgbOf = async (file: string) => new Uint8Array(await sharp(file).resize(OUT.w, OUT.h, { fit: "cover" }).removeAlpha().raw().toBuffer());

async function maskOf(sam: Sam, rgb: Uint8Array, phrases: string[]): Promise<Uint8Array> {
  const { w, h } = OUT;
  const url = dataUrl(await sharp(Buffer.from(rgb), { raw: { width: w, height: h, channels: 3 } }).png().toBuffer());
  const mask = new Uint8Array(w * h);
  for (const ph of phrases)
    for (const s of (await sam.segment(ph, url, w, h)).filter((x) => (x.score ?? 1) >= 0.3)) for (let i = 0; i < mask.length; i++) if (s.mask[i]) mask[i] = 1;
  return mask;
}

/**
 * Limits for a usable pose B (see poseBProblem), set on the 20 shots of the
 * first two illustrated clips: the ghost share caught 11 of the 14 broken
 * pastes. Scale and uncovered pixels only catch the worst ones: pose Bs drawn
 * at 95-97% still pasted cleanly when the character stayed off the frame edge.
 */
export const POSE_B = { scale: [0.94, 1.06] as [number, number], uncovered: 60000, ghost: 0.02, ghostLevel: 60, ring: 40 };

/**
 * Why a stabilised pose B would look cut or shifted, or "" when it is usable:
 * drawn at another size than A (the alignment scale), part of the paste falling
 * outside B's picture (straight cut lines), or A's character showing through
 * around the paste (ghost share: pixels in a ring just outside the paste where
 * A and the aligned B differ strongly, i.e. something moved that the mask missed).
 */
export function poseBProblem(m: { k: number; uncovered: number; ghost: number }, lim = POSE_B): string {
  if (m.k < lim.scale[0] || m.k > lim.scale[1]) return `pose B is drawn at ${(m.k * 100).toFixed(1)}% of pose A's size`;
  if (m.uncovered > lim.uncovered) return `${m.uncovered} pasted pixels fall outside pose B's picture`;
  if (m.ghost > lim.ghost) return `${(m.ghost * 100).toFixed(1)}% of the ring around the paste changed (leftovers of pose A)`;
  return "";
}

/** Share of ring pixels (dilated region minus region) where A and the aligned B differ by more than `level` on some channel. */
export function ghostShare(a: Uint8Array, bw: Uint8Array, region: Uint8Array, w: number, h: number, ring = POSE_B.ring, level = POSE_B.ghostLevel): number {
  // Relative to the far background: two Muse drawings of one room never match line for line,
  // so only a ring that differs more than the room does points at something left behind.
  const outer = dilate(region, w, h, ring), far = dilate(region, w, h, ring * 4);
  let n = 0, bad = 0, fn = 0, fbad = 0;
  for (let i = 0; i < w * h; i++) {
    if (region[i]) continue;
    let d = false;
    for (let c = 0; c < 3; c++) if (Math.abs(a[i * 3 + c] - bw[i * 3 + c]) > level) { d = true; break; }
    if (outer[i]) { n++; if (d) bad++; } else if (!far[i]) { fn++; if (d) fbad++; }
  }
  return Math.max(0, (n ? bad / n : 0) - (fn ? fbad / fn : 0));
}

interface PoseB { ok: boolean; problem: string; k: number; dx: number; dy: number; uncovered: number; ghost: number; out?: Buffer; soft?: Buffer }

async function pasteB(sam: Sam, phrases: string[], a: Uint8Array, b: Uint8Array): Promise<PoseB> {
  const { w, h } = OUT;
  const ma = await maskOf(sam, a, phrases), mb = await maskOf(sam, b, phrases);
  const keep = dilate(ma.map((v, i) => v | mb[i]), w, h, 24).map((v) => 1 - v);
  const t = alignBackground(a, b, w, h, keep);
  const bw = new Uint8Array(w * h * 3), mbw = new Uint8Array(w * h), inside = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x, j = warpIndex(w, h, t, x, y);
      inside[i] = j < 0 ? 0 : 1;
      for (let c = 0; c < 3; c++) bw[i * 3 + c] = j < 0 ? a[i * 3 + c] : b[j * 3 + c];
      if (j >= 0 && mb[j]) mbw[i] = 1;
    }
  // Wide and soft: a tight edge cuts limbs and props, takes no sticker outline, and steps the lines behind them.
  const region = dilate(ma.map((v, i) => v | mbw[i]), w, h, 28);
  let uncovered = 0;
  for (let i = 0; i < w * h; i++) if (region[i] && !inside[i]) uncovered++;
  const ghost = ghostShare(a, bw, region, w, h);
  const m = { k: t.k, uncovered, ghost };
  const problem = poseBProblem(m);
  const base = { ...m, dx: t.dx, dy: t.dy, problem, ok: !problem };
  if (problem) return base;
  const soft = await sharp(Buffer.from(region.map((v) => v * 255)), { raw: { width: w, height: h, channels: 1 } }).blur(9).extractChannel(0).raw().toBuffer();
  const out = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const s = soft[i] / 255;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(a[i * 3 + c] * (1 - s) + bw[i * 3 + c] * s);
  }
  return { ...base, out, soft };
}

/**
 * Pose B with pose A's exact background: B is aligned to A and only what moves
 * comes from B. A pose B that would look cut or shifted (poseBProblem) is drawn
 * again, up to `retries` times; if none is usable the shot keeps one pose.
 */
export async function stabilizePoses(sam: Sam, ctx: StudioContext, plan: Plan, dir: string, opts: { only?: string[]; retries?: number; log?: (s: string) => void } = {}): Promise<Array<{ id: string; ok: boolean; problem: string; tries: number }>> {
  const { w, h } = OUT;
  const phrase = (slug: string) => `cartoon ${ctx.profiles.get(slug)?.species.split("(")[0].trim() ?? slug}`;
  const report: Array<{ id: string; ok: boolean; problem: string; tries: number }> = [];
  for (const s of plan.shots) {
    const fb = join(dir, `${s.id}-b.png`), fb2 = join(dir, `${s.id}-b2.png`);
    if (s.src || !existsSync(fb) || (opts.only && !opts.only.includes(s.id))) continue;
    const a = await rgbOf(join(dir, `${s.id}.png`));
    const phrases = s.moving?.length ? s.moving : [plan.slug, ...s.cast].map(phrase);
    let r: PoseB | undefined, tries = 0;
    for (; tries <= (opts.retries ?? 2); tries++) {
      if (tries > 0) {
        rmSync(fb, { force: true });
        await drawPoses(ctx, plan, dir, { only: [s.id], log: opts.log });
        if (!existsSync(fb)) break;
      }
      r = await pasteB(sam, phrases, a, await rgbOf(fb));
      opts.log?.(`${s.id}: pose B scale ${r.k.toFixed(3)}, ${r.dx},${r.dy} px, uncovered ${r.uncovered}, ghost ${(r.ghost * 100).toFixed(2)}%${r.ok ? "" : ` - ${r.problem}`}`);
      if (r.ok) break;
    }
    if (r?.ok && r.out && r.soft) {
      await sharp(r.out, { raw: { width: w, height: h, channels: 3 } }).png().toFile(fb2);
      await sharp(r.soft, { raw: { width: w, height: h, channels: 1 } }).png().toFile(join(dir, `${s.id}-mask.png`));
    } else {
      rmSync(fb2, { force: true });
      opts.log?.(`${s.id}: keeps one pose (${r?.problem ?? "no pose B"})`);
    }
    report.push({ id: s.id, ok: !!r?.ok, problem: r?.problem ?? "no pose B", tries: Math.min(tries + 1, (opts.retries ?? 2) + 1) });
  }
  return report;
}

export const mouthPrompt = (name: string, open: boolean) =>
  `Change only ${name}'s mouth: ${open ? "open it mid-word as if talking loudly, clearly showing the inside of the mouth; it opens downward from where the mouth is, stays below the nose with a clear gap of skin between them, never touches or covers the nose, eyes or eye markings, and is no taller than it is wide" : "close it, lips together in a calm closed line, no teeth, no smile"}. The mouth stays the same width and in the same place. Do not move the head, nose, eyes, eyebrows, cheeks, arms, anyone else or anything else. Keep the same framing, background, colours and line style. No text.`;

/**
 * The lead's mouth among SAM's finds: the biggest find whose centre lies on the
 * lead (`lead`, a 0/1 mask), at a mouth's size. Undefined when none fits, so a
 * picture where the lead's mouth is hidden keeps its mouth as drawn.
 */
export function leadMouth(finds: Array<{ mask: Uint8Array; score?: number }>, lead: Uint8Array, w: number, h: number): { mask: Uint8Array; box: Box } | undefined {
  let best: { mask: Uint8Array; box: Box } | undefined;
  for (const f of finds) {
    if ((f.score ?? 1) < 0.3) continue;
    const b = maskBox(f.mask, w, h);
    if (!b || b.w > w * 0.3 || b.h > h * 0.12 || b.w < 6 || b.h < 4) continue;
    if (!lead[Math.round(b.y + b.h / 2) * w + Math.round(b.x + b.w / 2)]) continue;
    if (!best || b.w * b.h > best.box.w * best.box.h) best = { mask: f.mask, box: b };
  }
  return best;
}

/** Every find on the lead at a face feature's size, as one 0/1 mask (both eyes, say). */
export function leadFeatures(finds: Array<{ mask: Uint8Array; score?: number }>, lead: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (const f of finds) {
    if ((f.score ?? 1) < 0.3) continue;
    const b = maskBox(f.mask, w, h);
    if (!b || b.w > w * 0.35 || b.h > h * 0.15) continue;
    if (!lead[Math.round(b.y + b.h / 2) * w + Math.round(b.x + b.w / 2)]) continue;
    for (let i = 0; i < out.length; i++) if (f.mask[i]) out[i] = 1;
  }
  return out;
}

/** How much of `mask` (shifted by dx, dy) lies on `keep`, as a share of the mask. */
/** Gap an open mouth keeps under the nose: closer, the paste leaves a thin seam along the nose. */
export const NOSE_GAP = 6;

export function overlapShare(mask: Uint8Array, keep: Uint8Array, w: number, h: number, dx = 0, dy = 0): number {
  let n = 0, on = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      n++;
      const tx = x + dx, ty = y + dy;
      if (tx >= 0 && ty >= 0 && tx < w && ty < h && keep[ty * w + tx]) on++;
    }
  return n ? on / n : 0;
}

const area = (m: Uint8Array) => m.reduce((n, v) => n + (v ? 1 : 0), 0);

/**
 * `base` with the mouth of `edit` (shifted by dx, dy) pasted in through a tight
 * mask: the old mouth grown by `oldGrow` px (so a grin's corner curls go too)
 * and the new one grown by `grow` px, feathered, so the nose and cheeks around
 * them stay as drawn. Nothing is pasted on `keep` (the
 * picture's own nose and eyes), so they always stay on top.
 */
export function pasteMouth(base: Raster, edit: Raster, oldMouth: Uint8Array, newMouth: Uint8Array, dx: number, dy: number, grow = 5, keep?: Uint8Array, oldGrow = grow): Raster {
  const { width: w, height: h } = base;
  const moved = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = x - dx, sy = y - dy;
      if (sx >= 0 && sy >= 0 && sx < w && sy < h && newMouth[sy * w + sx]) moved[y * w + x] = 1;
    }
  const old = dilate(oldMouth, w, h, oldGrow), hard = dilate(moved, w, h, grow);
  for (let i = 0; i < hard.length; i++) hard[i] |= old[i];
  // Feather: the share of a (2r+1)² window that is inside, so the edge fades over r px.
  const r = 2, out = Buffer.from(base.data);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let inside = 0, all = 0;
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { const xx = x + i, yy = y + j; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; all++; inside += hard[yy * w + xx]; }
      const a = inside / all;
      if (!a || keep?.[y * w + x]) continue;
      const sx = x - dx, sy = y - dy;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const k = (y * w + x) * 3, m = (sy * w + sx) * 3;
      for (let c = 0; c < 3; c++) out[k + c] = Math.round(base.data[k + c] * (1 - a) + edit.data[m + c] * a);
    }
  return { data: out, width: w, height: h };
}

const FACE_CHECK = S.obj({ pass: S.bool(), problems: S.arr(S.str("one concrete problem"), 0, 6) });

/** Muse Spark looks at the face close up in both frames: one clean mouth each, no leftover lines of the old one. */
async function faceProblem(ctx: StudioContext, name: string, shut: Raster, open: Raster, box: Box): Promise<string> {
  const crop = async (r: Raster) => dataUrl(await sharp(r.data, { raw: { width: r.width, height: r.height, channels: 3 } }).extract({ left: box.x, top: box.y, width: box.w, height: box.h }).png().toBuffer());
  const v = await ctx.spark.json<{ pass: boolean; problems: string[] }>("mouth_check", FACE_CHECK, [{
    role: "user",
    content: [
      { type: "text", text: `Two close-ups of ${name}'s face from a cartoon, the first with the mouth shut, the second open. Fail them if either has more than one mouth, a leftover line, curl or corner of another mouth on the cheeks or chin, a smear or a patch of a different colour around the mouth, or a nose or eyes that are cut, covered or changed between the two.` },
      { type: "image_url", image_url: { url: await crop(shut) } },
      { type: "image_url", image_url: { url: await crop(open) } },
    ],
  }]);
  return v.pass ? "" : `the face close-up check failed: ${v.problems.join("; ")}`;
}

/**
 * Each shot picture (and its pose B) gets a shut and an open mouth, `<pic>-s.png`
 * and `<pic>-m.png`: Muse Image redraws the lead's mouth closed and open, SAM 3.1
 * finds the mouth in each, and only the mouth is pasted onto the picture, never
 * over the picture's own nose and eyes. The pair is dropped when the open mouth
 * is not clearly bigger than the shut one, is too tall, runs into the nose or eyes,
 * or Muse Spark sees a leftover of the old mouth in the face close-up.
 */
export async function drawMouths(sam: Sam, ctx: StudioContext, plan: Plan, dir: string, opts: { only?: string[]; log?: (s: string) => void } = {}): Promise<Array<{ pic: string; ok: boolean; problem?: string }>> {
  const { w, h } = OUT;
  const p = ctx.profiles.get(plan.slug)!;
  const species = p.species.split("(")[0].trim();
  const report: Array<{ pic: string; ok: boolean; problem?: string }> = [];
  const pngOf = (rgb: Uint8Array) => sharp(Buffer.from(rgb), { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  const findMouth = async (rgb: Uint8Array) => leadMouth(await sam.segment(`mouth of the cartoon ${species}`, dataUrl(await pngOf(rgb)), w, h), await maskOf(sam, rgb, [`cartoon ${species}`]), w, h);
  /**
   * The lead's nose, eyes and eye markings in the picture, grown 3 px: never pasted over, and an open mouth must not reach them.
   * `nearNose` is the nose grown by NOSE_GAP: an open mouth touching it leaves a thin seam under the nose.
   */
  const faceKeep = async (rgb: Uint8Array) => {
    const url = dataUrl(await pngOf(rgb)), lead = await maskOf(sam, rgb, [`cartoon ${species}`]);
    const keep = new Uint8Array(w * h), nose = new Uint8Array(w * h);
    for (const ph of [`nose of the cartoon ${species}`, `eyes of the cartoon ${species}`, `eye patches of the cartoon ${species}`]) {
      const m = leadFeatures(await sam.segment(ph, url, w, h), lead, w, h);
      for (let i = 0; i < keep.length; i++) if (m[i]) { keep[i] = 1; if (ph.startsWith("nose")) nose[i] = 1; }
    }
    return { keep: dilate(keep, w, h, 3), nearNose: dilate(nose, w, h, NOSE_GAP) };
  };
  for (const s of plan.shots) {
    if (s.src) continue;
    for (const pic of [s.id, `${s.id}-b2`]) {
      // --only takes a shot (s06: both its pictures) or one picture (s06-b2).
      if (opts.only && !opts.only.includes(s.id) && !opts.only.includes(pic)) continue;
      const file = join(dir, `${pic}.png`), shutFile = join(dir, `${pic}-s.png`), openFile = join(dir, `${pic}-m.png`);
      if (!existsSync(file) || (!opts.only && existsSync(openFile))) continue;
      const rgb = await rgbOf(file);
      const base: Raster = { data: Buffer.from(rgb), width: w, height: h };
      const mouth = await findMouth(rgb);
      if (!mouth) {
        report.push({ pic, ok: false, problem: `no mouth of ${p.name} found` });
        opts.log?.(`${pic}: no mouth of ${p.name} found; this picture keeps its mouth as drawn`);
        continue;
      }
      const { keep, nearNose } = await faceKeep(rgb);
      const made: Record<"shut" | "open", { img: Raster; size: number; box: Box; onFace: number; nearNose: number } | undefined> = { shut: undefined, open: undefined };
      for (const kind of ["shut", "open"] as const) {
        opts.log?.(`${pic}: drawing the mouth ${kind}`);
        const res = await generateSoftly(ctx.image, { prompt: mouthPrompt(p.name, kind === "open"), size: `${w}x${h}`, references: [dataUrl(await writePng(base))] }, opts.log);
        writeFileSync(join(dir, `${pic}-${kind === "open" ? "m" : "s"}.raw.png`), res.image);
        const editRgb = new Uint8Array(await sharp(res.image).resize(w, h, { fit: "cover" }).removeAlpha().raw().toBuffer());
        const found = await findMouth(editRgb);
        if (!found) { opts.log?.(`${pic}: no mouth found in the ${kind} edit`); continue; }
        const edit: Raster = { data: Buffer.from(editRgb), width: w, height: h };
        const shift = align(base, edit, grow(unionBox([mouth.box, found.box])!, 1.6, w, h, 48));
        made[kind] = { img: pasteMouth(base, edit, mouth.mask, found.mask, shift.dx, shift.dy, 5, keep, 12), size: area(found.mask), box: found.box, onFace: overlapShare(found.mask, keep, w, h, shift.dx, shift.dy), nearNose: overlapShare(found.mask, nearNose, w, h, shift.dx, shift.dy) };
      }
      const { shut, open } = made;
      const problem = !shut || !open ? "a mouth edit failed"
        : open.size < shut.size * 1.4 ? `the open mouth is not clearly bigger than the shut one (${open.size} vs ${shut.size} px)`
        : open.box.h > shut.box.w * 1.6 ? `the open mouth is too tall (${open.box.h} px for a ${shut.box.w} px wide mouth)`
        : open.onFace > 0.03 ? `the open mouth runs into the nose or eyes (${Math.round(open.onFace * 100)}% of it)`
        : open.nearNose > 0 ? `the open mouth comes within ${NOSE_GAP} px of the nose`
        : await faceProblem(ctx, p.name, shut.img, open.img, grow(unionBox([mouth.box, shut.box, open.box])!, 3, w, h, 160));
      report.push({ pic, ok: !problem, problem: problem || undefined });
      if (problem) { opts.log?.(`${pic}: ${problem}; this picture keeps its mouth as drawn`); continue; }
      await sharp(made.shut!.img.data, { raw: { width: w, height: h, channels: 3 } }).png().toFile(shutFile);
      await sharp(made.open!.img.data, { raw: { width: w, height: h, channels: 3 } }).png().toFile(openFile);
      opts.log?.(`${pic}: mouth pair ready (open ${made.open!.size} px, shut ${made.shut!.size} px)`);
    }
  }
  return report;
}

/** Shuts the mouth outside heard words (with a little slack either side); `fps` frames per second. */
export function gateToWords(mouth: boolean[], words: Word[], fps: number): boolean[] {
  return mouth.map((open, f) => open && words.some((x) => f / fps >= x.start - 0.06 && f / fps <= x.end + 0.06));
}

function bubbleSvg(text: string): string {
  const font = loadFont(COMIC_FONT_PATH);
  const size = 56, maxW = SAFE.right - SAFE.left - 120;
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(" ")) {
    const next = cur ? `${cur} ${word}` : word;
    if (measure(font, next, size) > maxW && cur) { lines.push(cur); cur = word; } else cur = next;
  }
  lines.push(cur);
  const tw = Math.max(...lines.map((l) => measure(font, l, size)));
  const bw = tw + 90, bh = lines.length * size * 1.22 + 64, x = (OUT.w - bw) / 2, y = 20, tx = OUT.w / 2;
  const texts = lines.map((l, k) => `<text x="${tx}" y="${(y + 52 + size * 0.8 + k * size * 1.22).toFixed(1)}" text-anchor="middle" font-family="${escapeXml(font.family)}" font-weight="700" font-size="${size}" fill="#1A1A1A">${escapeXml(l)}</text>`).join("");
  const tail = `M ${tx - 30} ${y + bh - 4} L ${tx + 40} ${y + bh + 70} L ${tx + 34} ${y + bh - 4} Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT.w}" height="${Math.ceil(bh + 110)}"><path d="${tail}" fill="#FFFFFF" stroke="#1A1A1A" stroke-width="6" stroke-linejoin="round"/><rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="${bh / 2.2}" fill="#FFFFFF" stroke="#1A1A1A" stroke-width="6"/><path d="${tail}" fill="#FFFFFF"/>${texts}</svg>`;
}

/** Frames only where something changes (a cut, a pose, the bubble pop, a word), then ffmpeg with the clip's audio. */
export async function renderIllustrated(plan: Plan, words: Word[], dir: string, out: string, opts: { mouth?: boolean[]; log?: (s: string) => void } = {}): Promise<string> {
  const chunks = chunkWords(words, 3, 16);
  const bubbleTop = SAFE.top + 10, capTop = SAFE.bottom - 190;
  const plate = (f: string) => sharp(f).resize(OUT.w, OUT.h, { fit: "cover" }).png().toBuffer();
  // Each pose, and its mouth-open copy when there is one and the mouth is asked for.
  const plates: Record<string, Array<{ shut: Buffer; open?: Buffer }>> = {};
  // With --mouth a picture that has a mouth pair talks on it: shut between words, open on the voice.
  const withMouth = async (pic: string) => {
    const pair = opts.mouth && existsSync(join(dir, `${pic}-m.png`)) && existsSync(join(dir, `${pic}-s.png`));
    return { shut: await plate(join(dir, `${pic}${pair ? "-s" : ""}.png`)), open: pair ? await plate(join(dir, `${pic}-m.png`)) : undefined };
  };
  for (const s of plan.shots) {
    const id = s.src ?? s.id;
    plates[s.id] = [await withMouth(id)];
    if (existsSync(join(dir, `${id}-b2.png`))) plates[s.id].push(await withMouth(`${id}-b2`));
  }
  const FPS = 30;
  const openAt = (t: number) => !!opts.mouth?.[Math.floor(t * FPS + 1e-6)];
  const bubbles: Record<string, Record<number, { input: Buffer; left: number; dy: number }>> = {};
  for (const s of plan.shots.filter((x) => x.bubble)) {
    const png = await sharp(svgToPng(bubbleSvg(s.bubble))).png().toBuffer();
    const { width = OUT.w, height = 200 } = await sharp(png).metadata();
    bubbles[s.id] = {};
    for (const [, k] of POP) {
      const bw = Math.round(width * k), bh = Math.round(height * k);
      const img = await sharp(png).resize(bw, bh).png().toBuffer();
      bubbles[s.id][k] = bw > OUT.w
        ? { input: await sharp(img).extract({ left: Math.round((bw - OUT.w) / 2), top: 0, width: OUT.w, height: bh }).png().toBuffer(), left: 0, dy: Math.round((height - bh) / 2) }
        : { input: img, left: Math.round((OUT.w - bw) / 2), dy: Math.round((height - bh) / 2) };
    }
  }
  const times = new Set<number>([0, plan.end]);
  for (const s of plan.shots) { times.add(s.t); for (const [d] of POP) times.add(+(s.t + 0.25 + d).toFixed(3)); }
  for (const c of chunks) { for (const w of c.words) times.add(+w.start.toFixed(2)); times.add(+c.end.toFixed(2)); }
  opts.mouth?.forEach((v, f) => { if (f && v !== opts.mouth![f - 1]) times.add(+(f / FPS).toFixed(4)); });
  const ts = [...times].filter((t) => t >= 0 && t <= plan.end).sort((a, b) => a - b);
  const fdir = join(dir, "frames");
  mkdirSync(fdir, { recursive: true });
  const list: string[] = [], cache = new Map<string, string>();
  for (let i = 0; i < ts.length - 1; i++) {
    const t = ts[i], d = ts[i + 1] - t;
    if (d < 0.005) continue;
    const shot = [...plan.shots].reverse().find((s) => s.t <= t + 1e-6)!;
    const ci = chunks.findIndex((c) => t >= c.start - 1e-6 && t < c.end + 0.25);
    const wi = ci < 0 ? -1 : chunks[ci].words.reduce((k, w, j) => (t >= w.start - 1e-6 ? j : k), 0);
    const shotEnd = plan.shots.find((x) => x.t > shot.t + 1e-6)?.t ?? plan.end;
    const pose = poseAt(chunks, ci, shot.t, plates[shot.id].length, Math.max(0, wi), shotEnd);
    const pop = popScale(t - (shot.t + 0.25));
    const pl = plates[shot.id][pose];
    const open = !!pl.open && openAt(t + 1e-4);
    const key = `${shot.id}|${pose}|${open}|${pop}|${ci}|${wi}`;
    let file = cache.get(key);
    if (!file) {
      const layers: sharp.OverlayOptions[] = [];
      if (pop && shot.bubble) { const b = bubbles[shot.id][pop]; layers.push({ input: b.input, top: bubbleTop + b.dy, left: b.left }); }
      if (ci >= 0) layers.push({ input: svgToPng(captionSvg(chunks[ci], wi)), top: capTop, left: 0 });
      file = join(fdir, `f${String(cache.size).padStart(4, "0")}.png`).replace(/\\/g, "/");
      await sharp(open ? pl.open! : pl.shut).composite(layers).png().toFile(file);
      cache.set(key, file);
    }
    list.push(`file '${file}'\nduration ${d.toFixed(3)}`);
  }
  list.push(list[list.length - 1].split("\n")[0]);
  const listFile = join(dir, "frames.txt");
  writeFileSync(listFile, list.join("\n"));
  const r = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-i", plan.clip, "-map", "0:v", "-map", "1:a", "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "medium", ...DELIVERY, "-t", String(plan.end), out], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  opts.log?.(`${out}: ${cache.size} distinct frames`);
  return out;
}
