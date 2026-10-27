/**
 * The picture set a character talks with, drawn once and kept in
 * characters/<slug>/talk/: a base shot, one picture per gesture (chained
 * Muse Image edits of the base, so framing and background stay put), and for
 * each gesture a mouth-open and a blink frame with only that feature changed.
 * SAM 3.1 finds the mouth and the eyes so only they are pasted from the edit.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { characterRefs, generateSoftly, styleReference, styleText, type StudioContext } from "@hoi-sau/studio";
import type { Sam } from "@hoi-sau/dance";
import { GESTURES, type Gesture } from "./gestures.js";
import { changedBox, maskBox, patchFeature, readRgb, unionBox, writePng, type Box, type Raster } from "./patch.js";

const EXPIRED = /referenced response not found|expired/i;

export const TALK_SIZE = "1024x1536";

export interface GestureArt {
  /** Muse Image response the gesture was drawn in, so edits chain from it. */
  response: string;
  file: string;
  mouth?: { file: string; box: Box };
  blink?: { file: string; box: Box };
  /** The character alone (white = character), from SAM 3.1, for placing it on a photo. */
  mask?: string;
}

export interface TalkArt {
  slug: string;
  base: { response: string; file: string };
  gestures: Record<string, GestureArt>;
}

export const talkDir = (charactersDir: string, slug: string) => join(charactersDir, slug, "talk");

export function loadArt(dir: string): TalkArt | undefined {
  const f = join(dir, "talk.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as TalkArt) : undefined;
}

const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`;

const KEEP = "Keep everything else exactly as it is: the same character, the same size and position in the frame, the same camera, background, lighting, colours and line style. Do not add text.";

export function basePrompt(ctx: StudioContext, slug: string): string {
  const p = ctx.profiles.get(slug);
  if (!p) throw new Error(`No character "${slug}".`);
  return [
    `Vertical picture for a short talking video. ${p.name}: ${p.look.description}`,
    `Signature features: ${p.look.signature.join("; ")}. Draw exactly these and nothing extra.`,
    "Medium shot from the waist up: the character sits behind the edge of an office desk, centred, facing the viewer and talking to the camera like a vlogger, arms relaxed and resting on the desk, mouth closed, calm friendly face. The head is in the middle of the picture and the body fills the lower half.",
    "Behind: a bright, tidy Vietnamese office corner, simple and softly out of focus, a window with daylight and a plant. The top fifth of the picture is plain wall with nothing on it.",
    "No text, letters, logos, captions or speech bubbles anywhere.",
    ctx.style ? styleText(ctx.style) : p.look.style,
  ].join(" ");
}

export const gesturePrompt = (g: Gesture) => `Redraw this exact picture with the character in a new pose: ${g.pose}. Mouth closed. ${KEEP}`;
export const MOUTH_PROMPT = `Change only the mouth: open it mid-word as if talking, a small open mouth showing a little of the inside. Do not move the head, eyes, eyebrows, arms or anything else. ${KEEP}`;
export const BLINK_PROMPT = `Change only the eyes: gently closed in the middle of a blink, drawn as two soft curved lines. Do not move the head, mouth, eyebrows, arms or anything else. ${KEEP}`;

/** The feature `phrase` names in `img`, or where `edit` changed it when SAM finds nothing. */
async function featureBox(sam: Sam | undefined, phrase: string, png: Buffer, img: Raster, edit: Raster, log?: (s: string) => void): Promise<Box | undefined> {
  if (sam) {
    try {
      const segs = (await sam.segment(phrase, dataUrl(png), img.width, img.height)).filter((s) => (s.score ?? 1) >= 0.3);
      const box = unionBox(segs.map((s) => maskBox(s.mask, s.width, s.height)).filter((b): b is Box => !!b));
      // A mouth or eyes box bigger than a fifth of the picture is a wrong find.
      if (box && box.w < img.width * 0.45 && box.h < img.height * 0.2) return box;
      log?.(`SAM did not find "${phrase}" cleanly; using where the edit changed.`);
    } catch (e) {
      log?.(`SAM failed for "${phrase}" (${(e as Error).message}); using where the edit changed.`);
    }
  }
  return changedBox(img, edit);
}

export interface DrawOptions {
  sam?: Sam;
  /** Only these gestures (ids); all by default. */
  only?: string[];
  /** Redraw pictures that already exist. */
  force?: boolean;
  log?: (s: string) => void;
}

export async function drawTalkArt(ctx: StudioContext, slug: string, dir: string, opts: DrawOptions = {}): Promise<TalkArt> {
  const log = opts.log ?? ctx.log;
  mkdirSync(dir, { recursive: true });
  const art: TalkArt = (!opts.force && loadArt(dir)) || { slug, base: { response: "", file: "" }, gestures: {} };
  const save = () => writeFileSync(join(dir, "talk.json"), JSON.stringify(art, null, 2) + "\n");
  const refs = [...characterRefs(ctx, slug), styleReference(ctx.style)].filter((x): x is string => Boolean(x));
  if (!refs.length) log?.(`${slug} has no locked model sheet; drawing from the description alone.`);

  if (!art.base.response || !existsSync(join(dir, art.base.file))) {
    log?.("drawing the base shot");
    const res = await generateSoftly(ctx.image, { prompt: basePrompt(ctx, slug), size: TALK_SIZE, references: refs }, log);
    writeFileSync(join(dir, "base.png"), res.image);
    art.base = { response: res.id, file: "base.png" };
    art.gestures = {};
    save();
  }
  const basePng = readFileSync(join(dir, art.base.file));

  for (const g of GESTURES.filter((g) => !opts.only || opts.only.includes(g.id))) {
    // Muse Image forgets old responses; an edit chained to a forgotten gesture redraws that gesture once.
    for (let attempt = 0; ; attempt++) {
      try {
        let ga = art.gestures[g.id];
        if (!ga || !existsSync(join(dir, ga.file))) {
          log?.(`drawing gesture ${g.id}`);
          const res = await generateSoftly(ctx.image, { prompt: gesturePrompt(g), size: TALK_SIZE, previousResponseId: art.base.response, references: [dataUrl(basePng)] }, log);
          writeFileSync(join(dir, `${g.id}.png`), res.image);
          ga = art.gestures[g.id] = { response: res.id, file: `${g.id}.png` };
          save();
        }
        const png = readFileSync(join(dir, ga.file));
        const img = await readRgb(png);
        const variants: Array<["mouth" | "blink", string, string]> = [["mouth", MOUTH_PROMPT, "the mouth"]];
        if (g.blink) variants.push(["blink", BLINK_PROMPT, "the eyes"]);
        for (const [kind, prompt, phrase] of variants) {
          if (ga[kind] && existsSync(join(dir, ga[kind]!.file))) continue;
          log?.(`drawing ${g.id} with ${kind === "mouth" ? "the mouth open" : "the eyes closed"}`);
          const res = await generateSoftly(ctx.image, { prompt, size: TALK_SIZE, previousResponseId: ga.response, references: [dataUrl(png)] }, log);
          writeFileSync(join(dir, `${g.id}.${kind}.raw.png`), res.image);
          const edit = await readRgb(res.image);
          const feature = await featureBox(opts.sam, phrase, png, img, edit, log);
          if (!feature) {
            log?.(`${g.id} ${kind}: the edit changed nothing; skipped.`);
            continue;
          }
          const patched = patchFeature(img, edit, feature);
          writeFileSync(join(dir, `${g.id}.${kind}.png`), await writePng(patched.image));
          ga[kind] = { file: `${g.id}.${kind}.png`, box: patched.box };
          save();
        }
        break;
      } catch (e) {
        if (attempt || !EXPIRED.test((e as Error).message)) throw e;
        log?.(`${g.id}: Muse Image no longer has this gesture's response; drawing it again.`);
        delete art.gestures[g.id];
      }
    }
  }
  save();
  return art;
}

/**
 * SAM 3.1 cuts the character out of every gesture picture, so it can stand
 * on a real photo. Mouth and blink frames share their gesture's cut: only the
 * face changes, inside the body.
 */
export async function cutTalkArt(sam: Sam, dir: string, art: TalkArt, phrase: string, opts: { force?: boolean; log?: (s: string) => void } = {}): Promise<TalkArt> {
  for (const [id, ga] of Object.entries(art.gestures)) {
    if (ga.mask && existsSync(join(dir, ga.mask)) && !opts.force) continue;
    const png = readFileSync(join(dir, ga.file));
    const img = await readRgb(png);
    const segs = (await sam.segment(phrase, dataUrl(png), img.width, img.height)).filter((x) => (x.score ?? 1) >= 0.3);
    if (!segs.length) {
      opts.log?.(`SAM found no "${phrase}" in ${id}; it keeps its drawn background.`);
      continue;
    }
    // The biggest find is the character; anything it holds is part of it.
    const mask = Buffer.alloc(img.width * img.height);
    const main = segs.reduce((a, b) => (b.area > a.area ? b : a));
    for (let i = 0; i < mask.length; i++) if (main.mask[i]) mask[i] = 255;
    const file = `${id}.mask.png`;
    writeFileSync(join(dir, file), await sharp(mask, { raw: { width: img.width, height: img.height, channels: 1 } }).blur(1.2).png().toBuffer());
    ga.mask = file;
    opts.log?.(`${id}: cut out (${Math.round((100 * main.area) / mask.length)}% of the picture)`);
  }
  writeFileSync(join(dir, "talk.json"), JSON.stringify(art, null, 2) + "\n");
  return art;
}
