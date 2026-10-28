/**
 * Puts the talk video together: every frame is the right gesture picture
 * (mouth and eyes patched in), shown whole on a soft blurred fill of itself,
 * with the caption and title laid on top, streamed into ffmpeg with the sound.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { ffmpeg } from "@hoi-sau/motion";
import type { TalkArt } from "./art.js";
import { CAPTION_BAND, CaptionCache, titleOverlay, type Overlay } from "./captions.js";
import { pasteOval, readRgb, type Raster } from "./patch.js";
import { FPS, OUT, PICTURE, type Chunk, type Frame } from "./timeline.js";
import { wavBytes, type Voice } from "./voice.js";

/**
 * A talk picture laid out in the 9:16 frame: whole and full width, on a
 * blurred, darkened copy of itself filling the bands above and below.
 */
async function toFrame(png: Buffer): Promise<Raster> {
  const fill = await sharp(png).removeAlpha().resize(OUT.w, OUT.h, { fit: "cover" }).blur(40).modulate({ brightness: 0.7 }).png().toBuffer();
  const pic = await sharp(png).removeAlpha().resize(PICTURE.w, PICTURE.h, { fit: "cover" }).png().toBuffer();
  return flatten(fill, [{ input: pic, left: PICTURE.x, top: PICTURE.y }]);
}

async function flatten(base: Buffer, layers: sharp.OverlayOptions[]): Promise<Raster> {
  const { data, info } = await sharp(base).composite(layers).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Where the cut-out character stands on a photo: bottom-centred, this share of the frame height (a waist-up cut is taller and touches the bottom). */
export const ON_PHOTO = { height: 0.44, bottom: 0.15, cutHeight: 0.36 };

/** A background photo filling the frame, out of focus so the character reads first. */
/** Gaussian sigma for the backdrop, in output pixels. */
export const BACKDROP_BLUR = 6;

export async function photoBackdrop(photo: string): Promise<Buffer> {
  // Out of focus like a shallow camera, so the sharp cut-out character carries the frame.
  const plate = await sharp(photo).rotate().removeAlpha().resize(OUT.w, OUT.h, { fit: "cover" }).blur(BACKDROP_BLUR).png().toBuffer();
  return finishBackdrop(plate);
}

/**
 * The backdrop only, never the character: a touch warmer, a fine paper grain
 * and soft dark corners, so the cut-out character is the brightest, cleanest
 * thing in the frame. The grain is fixed because the backdrop never moves.
 */
export async function finishBackdrop(plate: Buffer, opts: { grain?: number; vignette?: number } = {}): Promise<Buffer> {
  const N = OUT.w * OUT.h;
  let s = 11;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const amp = (opts.grain ?? 0.035) * 255 * 2.5;
  const noise = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) {
    const v = Math.max(0, Math.min(255, 128 + (rand() - 0.5) * 2 * amp));
    noise[i * 4] = noise[i * 4 + 1] = noise[i * 4 + 2] = v;
    noise[i * 4 + 3] = 255;
  }
  const vig = `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT.w}" height="${OUT.h}"><defs><radialGradient id="v" cx="50%" cy="50%" r="75%"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#2a1a0e" stop-opacity="${opts.vignette ?? 0.3}"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#v)"/></svg>`;
  const warm = await sharp(plate).removeAlpha().linear([1.03, 1.0, 0.94], [4, 2, 0]).png().toBuffer();
  const grained = await sharp(warm).composite([{ input: await sharp(noise, { raw: { width: OUT.w, height: OUT.h, channels: 4 } }).png().toBuffer(), blend: "soft-light" }]).png().toBuffer();
  return sharp(grained).composite([{ input: Buffer.from(vig) }]).removeAlpha().png().toBuffer();
}

/**
 * A plain backdrop made in code, no image model: one soft colour, a little
 * light behind the character's head, a faint dot pattern and a gentle
 * vignette, so it reads as a deliberate studio wall rather than empty.
 */
export function plainBackdrop(color = "#CFE3EE"): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT.w}" height="${OUT.h}">
  <defs>
    <radialGradient id="light" cx="50%" cy="42%" r="55%"><stop offset="0" stop-color="#fff" stop-opacity="0.45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <radialGradient id="edge" cx="50%" cy="50%" r="75%"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.12"/></radialGradient>
    <pattern id="dots" width="44" height="44" patternUnits="userSpaceOnUse"><circle cx="22" cy="22" r="3" fill="#fff" fill-opacity="0.35"/></pattern>
  </defs>
  <rect width="100%" height="100%" fill="${color}"/>
  <rect width="100%" height="100%" fill="url(#dots)"/>
  <rect width="100%" height="100%" fill="url(#light)"/>
  <rect width="100%" height="100%" fill="url(#edge)"/>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** --bg plain or plain:#hex gives a plain backdrop; anything else is a picture file. */
export const backdropFor = (bg: string) => (bg === "plain" || bg.startsWith("plain:") ? plainBackdrop(bg.slice(6) || undefined) : photoBackdrop(bg));

/**
 * The character cut out with its SAM mask and stood on the photo, with a soft
 * contact shadow under it.
 */
export async function onPhoto(png: Buffer, mask: Buffer, backdrop: Buffer): Promise<Raster> {
  const meta = await sharp(png).metadata();
  const w0 = meta.width!;
  const h0 = meta.height!;
  // Trim to the character so its height, not the picture's, sets the size.
  const m = await sharp(mask).resize(w0, h0).greyscale().raw().toBuffer();
  let top = h0, bottom = 0, left = w0, right = 0;
  for (let y = 0; y < h0; y++)
    for (let x = 0; x < w0; x++)
      if (m[y * w0 + x] > 128) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
  if (bottom <= top) return toFrame(png);
  // RGBA by hand: sharp's joinChannel drops the band when written straight to PNG.
  const rgb = await sharp(png).removeAlpha().resize(w0, h0).raw().toBuffer();
  const px = Buffer.alloc(w0 * h0 * 4);
  for (let i = 0; i < w0 * h0; i++) {
    px[i * 4] = rgb[i * 3];
    px[i * 4 + 1] = rgb[i * 3 + 1];
    px[i * 4 + 2] = rgb[i * 3 + 2];
    // Pull the soft edge in a pixel or so, so no light fringe of the old background shows.
    px[i * 4 + 3] = Math.max(0, Math.min(255, ((m[i] - 96) * 255) / 128));
  }
  const rgba = sharp(px, { raw: { width: w0, height: h0, channels: 4 } });
  // The cut includes the desk in front (it spans the picture's width): keep the
  // drawing's own framing, full frame width, standing on the bottom edge.
  let deskRow = 0;
  for (let x = 0; x < w0; x++) if (m[bottom * w0 + x] > 128) deskRow++;
  if (deskRow > w0 * 0.8) {
    const height = Math.round((h0 * OUT.w) / w0);
    const whole = await rgba.resize(OUT.w, height).png().toBuffer();
    return flatten(backdrop, [{ input: whole, left: 0, top: OUT.h - height }]);
  }
  const box = { left, top, width: right - left + 1, height: bottom - top + 1 };
  // A body cut straight across runs off the bottom of the frame like a vlogger, with no shadow.
  let base = 0;
  for (let x = left; x <= right; x++) if (m[bottom * w0 + x] > 128) base++;
  const cutOff = base > box.width * 0.4;
  const cut = await rgba.extract(box).png().toBuffer();
  let height = Math.round(OUT.h * (cutOff ? ON_PHOTO.cutHeight : ON_PHOTO.height));
  let width = Math.round((box.width * height) / box.height);
  // Raised arms can make a pose wider than the frame.
  if (width > OUT.w * 0.96) {
    height = Math.round((height * OUT.w * 0.96) / width);
    width = Math.round(OUT.w * 0.96);
  }
  const sized = await sharp(cut).resize(width, height).png().toBuffer();
  const x = Math.round((OUT.w - width) / 2);
  const y = cutOff ? OUT.h - height : Math.round(OUT.h * (1 - ON_PHOTO.bottom) - height);
  if (cutOff) return flatten(backdrop, [{ input: sized, left: x, top: y }]);
  const shadow = await sharp({ create: { width: Math.round(width * 0.8), height: Math.round(height * 0.06), channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width * 0.8)}" height="${Math.round(height * 0.06)}"><ellipse cx="50%" cy="50%" rx="48%" ry="40%" fill="black" fill-opacity="0.35"/></svg>`) }])
    .blur(8)
    .png()
    .toBuffer();
  return flatten(backdrop, [
    { input: shadow, left: x + Math.round(width * 0.1), top: y + height - Math.round(height * 0.04) },
    { input: sized, left: x, top: y },
  ]);
}

/** The four faces of each gesture (plain, mouth, blink, both) on the canvas. */
export class Pictures {
  private readonly cache = new Map<string, Promise<Raster>>();
  constructor(
    private readonly art: TalkArt,
    private readonly dir: string,
    /** A backdrop photo (from photoBackdrop): characters with a cut stand on it. */
    private readonly backdrop?: Buffer,
  ) {}
  get(gesture: string, mouth: boolean, blink: boolean): Promise<Raster> {
    const key = `${gesture}:${mouth}:${blink}`;
    let p = this.cache.get(key);
    if (!p) this.cache.set(key, (p = this.make(gesture, mouth, blink)));
    return p;
  }
  private async make(gesture: string, mouth: boolean, blink: boolean): Promise<Raster> {
    const g = this.art.gestures[gesture];
    if (!g) throw new Error(`No picture for gesture ${gesture}. Draw it: npm run talk -- art ${this.art.slug}`);
    const read = (f: string) => readFileSync(join(this.dir, f));
    let png: Buffer;
    if (mouth && blink && g.mouth && g.blink) {
      // Mouth and blink pictures are both lined up with the gesture, so the mouth oval drops straight onto the blink frame.
      const both = pasteOval(await readRgb(read(g.blink.file)), await readRgb(read(g.mouth.file)), g.mouth.box);
      png = await sharp(both.data, { raw: { width: both.width, height: both.height, channels: 3 } }).png().toBuffer();
    } else png = read(mouth && g.mouth ? g.mouth.file : blink && g.blink ? g.blink.file : g.file);
    return this.backdrop && g.mask ? onPhoto(png, read(g.mask), this.backdrop) : toFrame(png);
  }
}

async function compose(base: Buffer, overlays: Overlay[]): Promise<Buffer> {
  if (!overlays.length) return base;
  return sharp(base, { raw: { width: OUT.w, height: OUT.h, channels: 3 } })
    .composite(overlays.map((o) => ({ input: o.data, raw: { width: o.width, height: o.height, channels: 4 as const }, top: o.top, left: 0 })))
    .removeAlpha()
    .raw()
    .toBuffer();
}

export interface RenderInput {
  art: TalkArt;
  artDir: string;
  frames: Frame[];
  chunks: Chunk[];
  title?: string;
  voice: Voice;
  out: string;
  /** The finished soundtrack (a lip-synced sound) instead of the voice track. */
  audio?: string;
  /** A photo to stand the character on (needs `talk cut`); the drawn background otherwise. */
  background?: string;
  /** Background music, looped under the voice. */
  music?: string;
  musicVolume?: number;
  log?: (s: string) => void;
}

export async function renderTalk(r: RenderInput): Promise<{ video: string; seconds: number }> {
  let wav = r.audio;
  if (!wav) {
    wav = r.out.replace(/\.mp4$/, "") + ".voice.wav";
    writeFileSync(wav, wavBytes(r.voice.pcm, r.voice.rate));
  }
  const pics = new Pictures(r.art, r.artDir, r.background ? await backdropFor(r.background) : undefined);
  // On a backdrop the character stands in the middle, so the words sit on the ground under it, clear of the body.
  const captions = new CaptionCache(r.chunks, r.background ? OUT.h - CAPTION_BAND.h - 40 : CAPTION_BAND.y);
  const title = r.title ? await titleOverlay(r.title) : undefined;

  const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${OUT.w}x${OUT.h}`, "-r", String(FPS), "-i", "pipe:0", "-i", wav];
  let audio = "1:a";
  // A lip-synced sound is used as it is.
  if (r.music && existsSync(r.music)) {
    args.push("-stream_loop", "-1", "-i", r.music);
    args.push("-filter_complex", `[2:a]volume=${r.musicVolume ?? 0.12}[m];[1:a][m]amix=inputs=2:duration=first:dropout_transition=0,aresample=48000[a]`);
    audio = "[a]";
  }
  args.push("-map", "0:v", "-map", audio, "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", r.out);
  const ff = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  ff.stderr.on("data", (d) => (stderr += d));
  // A dead ffmpeg surfaces through `close`; don't also crash on the broken pipe.
  ff.stdin.on("error", () => {});
  const done = new Promise<void>((ok, fail) => {
    ff.on("error", (e) => fail(new Error(`Could not start ffmpeg: ${e.message}`)));
    ff.on("close", (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split(/\r?\n/).slice(-5).join("\n")}`))));
  });

  const frameAt = async (f: number) => {
    const fr = r.frames[f];
    const base = (await pics.get(fr.gesture, fr.mouth, fr.blink)).data;
    const overlays: Overlay[] = [];
    if (title) overlays.push(title);
    if (fr.chunk !== undefined && fr.word !== undefined) overlays.push(await captions.get(fr.chunk, fr.word));
    return compose(base, overlays);
  };
  // A few frames in flight at once; written strictly in order.
  const AHEAD = 6;
  const pending: Promise<Buffer>[] = [];
  for (let f = 0; f < Math.min(AHEAD, r.frames.length); f++) pending.push(frameAt(f));
  for (let f = 0; f < r.frames.length; f++) {
    const buf = await pending.shift()!;
    if (f + AHEAD < r.frames.length) pending.push(frameAt(f + AHEAD));
    if (!ff.stdin.write(buf)) await new Promise((ok) => ff.stdin.once("drain", ok));
    if (f % (FPS * 5) === 0) r.log?.(`frame ${f}/${r.frames.length}`);
  }
  ff.stdin.end();
  await done;
  return { video: r.out, seconds: r.frames.length / FPS };
}

/** A copy without sound, for posting with the same sound picked from the app's library. */
export async function silentCopy(video: string): Promise<string> {
  const out = video.replace(/\.mp4$/, "") + ".silent.mp4";
  await ffmpeg(["-i", video, "-an", "-c:v", "copy", "-movflags", "+faststart", out]);
  return out;
}
