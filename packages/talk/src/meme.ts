/**
 * Text memes: the silent kind of clip, next to the illustrated voice-over.
 * The joke is two lines of big text in two beats (the set-up, then the
 * punchline), over one or two pictures of our own character in the Hồi Sau
 * office. The character moves between two poses of the same picture on a
 * still background, and the sound is instrumental music from Meta's MusicGen.
 *
 * The owner writes the words and, if they want, a note per scene
 * (`meme.json` in the clip's folder). Muse Spark turns that into the shots;
 * drawing, second poses and the still background are the same steps as
 * `talk illustrate`, so the same checks run on every picture.
 *
 *   plan    meme.json → plan.json: lines are the two beats, one shot per scene (Muse Spark)
 *   music   MusicGen (facebook/musicgen-small, local) → music.wav; skipped when the prompt is empty
 *   render  1080x1920, 30 fps CFR: poses alternate, the set-up shows first, the punchline pops in
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { DELIVERY } from "@hoi-sau/motion";
import { S, type ChatMessage, type StudioContext } from "@hoi-sau/studio";
import { COMIC_FONT_PATH, escapeXml, loadFont, measure, svgToPng } from "@hoi-sau/svg-text";
import { lowerPicture } from "./cover.js";
import { popScale, type Line, type Plan, type Shot } from "./illustrate.js";
import { OUT, SAFE } from "./timeline.js";
import { python } from "./voice.js";

export interface MemeSpec {
  /** The set-up, shown from the start. */
  top: string;
  /** The punchline, shown under it from `punchAt`. */
  punch: string;
  /** One or two notes on what each scene shows (any language); empty notes let Muse Spark choose. */
  scenes: string[];
  /** English prompt for MusicGen; empty for no music. */
  music: string;
  seconds: number;
}

export const MEME_SECONDS = { min: 10, max: 20, default: 14 };
/** Each beat of text stays readable on a phone: at most this many characters. */
export const MEME_TEXT_MAX = 90;

/** Problems with what the owner typed, in Vietnamese for the dashboard; empty when it is fine. */
export function memeProblems(spec: MemeSpec): string[] {
  const out: string[] = [];
  if (!spec.top.trim()) out.push("Thiếu dòng chữ 1.");
  if (!spec.punch.trim()) out.push("Thiếu dòng chữ 2 (câu chốt).");
  if (spec.top.length > MEME_TEXT_MAX || spec.punch.length > MEME_TEXT_MAX) out.push(`Mỗi dòng chữ tối đa ${MEME_TEXT_MAX} ký tự.`);
  if (!(spec.seconds >= MEME_SECONDS.min && spec.seconds <= MEME_SECONDS.max)) out.push(`Độ dài từ ${MEME_SECONDS.min} đến ${MEME_SECONDS.max} giây.`);
  if (spec.scenes.length < 1 || spec.scenes.length > 2) out.push("Một hoặc hai cảnh.");
  return out;
}

/** When the punchline comes in: the start of scene 2, or a little before the middle with one scene. */
export function punchTime(seconds: number, scenes: number): number {
  return +(scenes > 1 ? seconds * 0.45 : seconds * 0.4).toFixed(2);
}

const MEME_PLAN = S.obj({
  shots: S.arr(
    S.obj({
      act: S.str("English, one or two sentences: what the picture shows, with the lead character big and on-model, in the Hồi Sau office unless the note says otherwise, 1-3 simple props"),
      pose: S.str("English: the next moment of the same picture, a small real movement (a blink, a hand moving, money being flicked, a head turn); same place, same props"),
      cast: S.arr(S.str("slug of another cast member, only if the joke needs one"), 0, 2),
      moving: S.arr(S.str("English noun for SAM: what moves between the two poses (the character, what it holds)"), 1, 4),
    }),
    1,
    2,
  ),
});

/** Muse Spark writes the shots; the words become the plan's two lines. */
export async function planMeme(ctx: StudioContext, slug: string, spec: MemeSpec): Promise<Plan> {
  const p = ctx.profiles.get(slug);
  if (!p) throw new Error(`No character "${slug}".`);
  const cast = [...ctx.profiles.values()].filter((c) => c.slug !== slug).map((c) => `${c.slug} = ${c.name} (${c.species}, ${c.role})`).join("; ");
  // "Sếp" in a joke is the most senior cast member (the director), never just any colleague.
  const boss = [...ctx.profiles.values()].find((c) => c.slug !== slug && /giám đốc|director|founder/i.test(c.role));
  const scenes = spec.scenes.map((n, i) => `Scene ${i + 1}: ${n.trim() || "(your choice)"}`).join("\n");
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        `A silent Vietnamese text meme is being made with our cartoon character ${p.name} (${p.species}, ${p.role}). The joke is two lines of text shown in two beats; the pictures only act it out. Write exactly ${spec.scenes.length} shot(s).`,
        `Text 1 (set-up): ${spec.top}\nText 2 (punchline): ${spec.punch}`,
        scenes,
        `Rules: ${p.name} wears the usual outfit from the reference sheet; the setting is the Hồi Sau office unless a scene note says otherwise; one clear action and a strong expression; nothing with lettering on it (no shirts, signs or screens with words); no clocks; every scene has the same time of day and lighting (daytime office unless a note says night). Call ${p.name} by name, never "he" or "she". Other cast if needed: ${cast}.${boss ? ` When the text says "sếp" (the boss), the boss is ${boss.name} (${boss.slug}): put ${boss.slug} in cast and draw ${boss.name}, not another colleague.` : ""}`,
      ].join("\n\n"),
    },
  ];
  const r = await ctx.spark.json<{ shots: Array<Pick<Shot, "act" | "pose" | "cast" | "moving">> }>("meme_plan", MEME_PLAN, messages);
  const punchAt = punchTime(spec.seconds, spec.scenes.length);
  const lines: Line[] = [
    { text: spec.top.trim(), start: 0, end: punchAt },
    { text: spec.punch.trim(), start: punchAt, end: spec.seconds },
  ];
  const shots: Shot[] = spec.scenes.map((_, i) => ({
    id: `s${String(i + 1).padStart(2, "0")}`,
    t: i === 0 ? 0 : punchAt,
    act: `${r.shots[i]?.act ?? r.shots[0]?.act ?? ""} ${MEME_FRAME}`,
    pose: r.shots[i]?.pose ?? "",
    bubble: "",
    cast: r.shots[i]?.cast ?? [],
    moving: r.shots[i]?.moving?.length ? r.shots[i].moving : undefined,
  }));
  return { slug, clip: "", end: spec.seconds, lines, shots };
}

/** Added to every meme picture: room for the text on top, and none of what went wrong in tests. */
export const MEME_FRAME = "The top third of the frame is plain empty office wall with nothing on it (big text goes there); the characters sit in the lower two thirds. No clocks.";

const MUSICGEN = fileURLToPath(new URL("../scripts/musicgen.py", import.meta.url));

/** Instrumental music from MusicGen, on the GPU; slightly longer than the clip so it never runs out. */
export function makeMusic(prompt: string, seconds: number, out: string, log?: (s: string) => void): string {
  log?.(`music: MusicGen "${prompt}"`);
  const r = spawnSync(python(), [MUSICGEN, out, String(seconds + 1), prompt], { encoding: "utf8" });
  if (r.status !== 0 || !existsSync(out)) throw new Error(`MusicGen failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ")}`);
  return out;
}

/** Words wrapped to a width at a size. */
function wrap(text: string, size: number, maxW: number): string[] {
  const font = loadFont(COMIC_FONT_PATH);
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && measure(font, next, size) > maxW) (lines.push(cur), (cur = w));
    else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** The narrowest width that keeps the same number of lines, so the last line is not one lonely word. */
function balance(text: string, size: number, maxW: number): string[] {
  const n = wrap(text, size, maxW).length;
  let lo = maxW * 0.4, hi = maxW;
  for (let k = 0; k < 14; k++) {
    const mid = (lo + hi) / 2;
    if (wrap(text, size, mid).length > n) lo = mid;
    else hi = mid;
  }
  return wrap(text, size, hi);
}

/** The largest size (92 down to 60) at which a beat fits in three lines, lines balanced. */
export function fitText(text: string, maxW = OUT.w - 100): { size: number; lines: string[] } {
  for (let size = 92; size >= 60; size -= 4) {
    if (wrap(text, size, maxW).length <= 3) return { size, lines: balance(text, size, maxW) };
  }
  return { size: 60, lines: balance(text, 60, maxW) };
}

/** One beat of text: dark letters with a thick white outline; the punchline in red. */
export function beatSvg(text: string, punch: boolean): { svg: string; height: number } {
  const font = loadFont(COMIC_FONT_PATH);
  const { size, lines } = fitText(text);
  const lh = size * 1.18, height = Math.ceil(lines.length * lh + size * 0.5);
  const texts = lines
    .map((l, k) => `<text x="${OUT.w / 2}" y="${(size * 0.95 + k * lh).toFixed(1)}" text-anchor="middle" font-family="${escapeXml(font.family)}" font-weight="700" font-size="${size}" fill="${punch ? "#D7261E" : "#1A1A1A"}" stroke="#FFFFFF" stroke-width="${(size * 0.2).toFixed(1)}" stroke-linejoin="round" paint-order="stroke">${escapeXml(l)}</text>`)
    .join("");
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT.w}" height="${height}">${texts}</svg>`, height };
}

/** Which pose shows `since` seconds into a shot: A, then B, back and forth, B a little shorter. */
export function memePose(since: number, poses: number): number {
  if (poses < 2) return 0;
  const cycle = 2.4, a = 1.4;
  return since % cycle < a ? 0 : 1;
}

/** A blink: shut for 0.15 s every 2.4 s, the first at 1.8 s into the shot. */
export const BLINK = { first: 1.8, every: 2.4, shut: 0.15 };
export function blinkShut(since: number): boolean {
  if (since < BLINK.first) return false;
  return (since - BLINK.first) % BLINK.every < BLINK.shut;
}

/**
 * How far a picture moves down so the text sits on the wall above the
 * characters, not on their heads: just enough to put the top of the faces
 * (`faceTop`, from SAM) a little under the text, none when they already are.
 * Without a face, a smaller fixed guess.
 */
export function memeLower(textBottom: number, faceTop?: number): number {
  const want = faceTop === undefined ? textBottom - 420 : textBottom + 140 - faceTop;
  return Math.max(0, Math.min(faceTop === undefined ? 300 : 520, Math.round(want)));
}

/** Where the two beats of text end, in pixels from the top. */
export function memeTextBottom(plan: Plan): number {
  const [top, punch] = plan.lines;
  return SAFE.top + 10 + (top ? beatSvg(top.text, false).height : 0) + 10 + (punch ? beatSvg(punch.text, true).height : 0);
}

const BLINK_PY = fileURLToPath(new URL("../scripts/blink.py", import.meta.url));

/** A shut-eye copy of a picture (`<id>-blink.png`) inside the faces box; false when no eyes are found. */
export function makeBlink(src: string, out: string, box: { x: number; y: number; w: number; h: number }, log?: (s: string) => void): boolean {
  const r = spawnSync(python(), [BLINK_PY, src, out, [box.x, box.y, box.x + box.w, box.y + box.h].map(Math.round).join(",")], { encoding: "utf8" });
  const ok = r.status === 0 && existsSync(out) && /eye at/.test(r.stdout);
  log?.(ok ? `${out}: blink` : `no blink for ${src}: ${(r.stderr || r.stdout || "no eyes found").trim().split("\n").pop()}`);
  return ok;
}

/** Frames where something changes, then ffmpeg with the music (or silence) at 30 fps CFR. */
export async function renderMeme(plan: Plan, dir: string, music: string | undefined, out: string, log?: (s: string) => void, faceTop: Record<string, number | undefined> = {}): Promise<string> {
  const [top, punch] = plan.lines;
  const topImg = top ? beatSvg(top.text, false) : undefined;
  const punchImg = punch ? beatSvg(punch.text, true) : undefined;
  const textBottom = memeTextBottom(plan);
  // Per shot: pose A, then pose B if it pasted cleanly, else a shut-eye copy of A for blinks.
  const plates: Record<string, Buffer[]> = {}, blinks: Record<string, boolean> = {};
  for (const s of plan.shots) {
    const id = s.src ?? s.id;
    const dy = memeLower(textBottom, faceTop[id]);
    log?.(`${s.id}: lowered ${dy}px`);
    const plate = (f: string) => lowerPicture(f, dy);
    plates[s.id] = [await plate(join(dir, `${id}.png`))];
    if (existsSync(join(dir, `${id}-b2.png`))) plates[s.id].push(await plate(join(dir, `${id}-b2.png`)));
    else if (existsSync(join(dir, `${id}-blink.png`))) (plates[s.id].push(await plate(join(dir, `${id}-blink.png`))), (blinks[s.id] = true));
  }
  const topPng = topImg ? await sharp(svgToPng(topImg.svg)).png().toBuffer() : undefined;
  const punchPng = punchImg ? await sharp(svgToPng(punchImg.svg)).png().toBuffer() : undefined;
  const textTop = SAFE.top + 10;
  const pops: Record<number, { input: Buffer; left: number; dy: number }> = {};
  if (punchPng && punchImg)
    for (const k of [0.82, 1.06, 1]) {
      const w = Math.round(OUT.w * k), h = Math.round(punchImg.height * k);
      const img = await sharp(punchPng).resize(w, h).png().toBuffer();
      pops[k] = w > OUT.w ? { input: await sharp(img).extract({ left: Math.round((w - OUT.w) / 2), top: 0, width: OUT.w, height: h }).png().toBuffer(), left: 0, dy: Math.round((punchImg.height - h) / 2) } : { input: img, left: Math.round((OUT.w - w) / 2), dy: Math.round((punchImg.height - h) / 2) };
    }
  const topShow = 0.3, punchAt = punch ? punch.start + 0.2 : Infinity;
  const times = new Set<number>([0, topShow, plan.end]);
  for (const s of plan.shots) {
    const end = plan.shots.find((x) => x.t > s.t)?.t ?? plan.end;
    times.add(s.t);
    if (blinks[s.id]) for (let t = s.t + BLINK.first; t < end; t += BLINK.every) (times.add(+t.toFixed(3)), times.add(+(t + BLINK.shut).toFixed(3)));
    else for (let t = s.t; t < end; t += 2.4) (times.add(+t.toFixed(3)), times.add(+(t + 1.4).toFixed(3)));
  }
  if (punch) for (const d of [0, 0.05, 0.11]) times.add(+(punchAt + d).toFixed(3));
  const ts = [...times].filter((t) => t >= 0 && t <= plan.end).sort((a, b) => a - b);
  const fdir = join(dir, "meme-frames");
  mkdirSync(fdir, { recursive: true });
  const list: string[] = [], cache = new Map<string, string>();
  for (let i = 0; i < ts.length - 1; i++) {
    const t = ts[i], d = ts[i + 1] - t;
    if (d < 0.005) continue;
    const shot = [...plan.shots].reverse().find((s) => s.t <= t + 1e-6) ?? plan.shots[0];
    const pose = blinks[shot.id] ? (blinkShut(t - shot.t + 1e-4) ? 1 : 0) : memePose(t - shot.t, plates[shot.id].length);
    const showTop = t >= topShow - 1e-6;
    const pop = punch ? popScale(t - punchAt) : null;
    const key = `${shot.id}|${pose}|${showTop}|${pop}`;
    let file = cache.get(key);
    if (!file) {
      const layers: sharp.OverlayOptions[] = [];
      if (showTop && topPng) layers.push({ input: topPng, top: textTop, left: 0 });
      if (pop && punchImg) {
        const b = pops[pop];
        layers.push({ input: b.input, top: textTop + (topImg?.height ?? 0) + 10 + b.dy, left: b.left });
      }
      file = join(fdir, `f${String(cache.size).padStart(4, "0")}.png`).replace(/\\/g, "/");
      await sharp(plates[shot.id][pose]).composite(layers).png().toFile(file);
      cache.set(key, file);
    }
    list.push(`file '${file}'\nduration ${d.toFixed(3)}`);
  }
  list.push(list[list.length - 1].split("\n")[0]);
  const listFile = join(dir, "meme-frames.txt");
  writeFileSync(listFile, list.join("\n"));
  const audio = music && existsSync(music) ? ["-i", music] : ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"];
  const fade = music && existsSync(music) ? ["-af", `afade=t=in:d=0.3,afade=t=out:st=${(plan.end - 1.2).toFixed(2)}:d=1.2`] : [];
  mkdirSync(dirname(out), { recursive: true });
  const r = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile, ...audio, "-map", "0:v", "-map", "1:a", "-vf", "fps=30,format=yuv420p", "-fps_mode", "cfr", "-r", "30", ...fade, "-c:v", "libx264", "-preset", "medium", ...DELIVERY, "-t", String(plan.end), out], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  log?.(`${out}: ${cache.size} distinct frames`);
  return out;
}

export function readMeme(out: string): MemeSpec {
  const f = join(out, "meme.json");
  if (!existsSync(f)) throw new Error(`${f} is missing: write the two lines of text there first.`);
  return JSON.parse(readFileSync(f, "utf8")) as MemeSpec;
}
