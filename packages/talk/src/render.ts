/**
 * Puts the talk video together: every frame is the right gesture picture
 * (mouth and eyes patched in), cropped by the moving camera, with the caption
 * and title laid on top, streamed into ffmpeg with the voice track.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import type { TalkArt } from "./art.js";
import { CaptionCache, titleOverlay, type Overlay } from "./captions.js";
import { pasteOval, readRgb, type Raster } from "./patch.js";
import { CANVAS, cropWindow, FPS, OUT, type Chunk, type Frame } from "./timeline.js";
import { wavBytes, type Voice } from "./voice.js";

/** A picture scaled and centre-cropped to the canvas. */
async function toCanvas(png: Buffer): Promise<Raster> {
  const { data, info } = await sharp(png).removeAlpha().resize(CANVAS.w, CANVAS.h, { fit: "cover" }).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** The four faces of each gesture (plain, mouth, blink, both) on the canvas. */
export class Pictures {
  private readonly cache = new Map<string, Promise<Raster>>();
  constructor(
    private readonly art: TalkArt,
    private readonly dir: string,
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
    if (mouth && blink && g.mouth && g.blink) {
      // Mouth and blink pictures are both lined up with the gesture, so the mouth oval drops straight onto the blink frame.
      const both = pasteOval(await readRgb(read(g.blink.file)), await readRgb(read(g.mouth.file)), g.mouth.box);
      return toCanvas(await sharp(both.data, { raw: { width: both.width, height: both.height, channels: 3 } }).png().toBuffer());
    }
    const f = mouth && g.mouth ? g.mouth.file : blink && g.blink ? g.blink.file : g.file;
    return toCanvas(read(f));
  }
}

/** The camera's crop of the canvas at output size, with sub-pixel motion. */
export async function shoot(img: Raster, frame: Frame): Promise<Buffer> {
  const win = cropWindow(frame.camera);
  const left = Math.floor(win.x);
  const top = Math.floor(win.y);
  const width = Math.min(img.width - left, Math.ceil(win.w) + 2);
  const height = Math.min(img.height - top, Math.ceil(win.h) + 2);
  const z = OUT.w / win.w;
  const part = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } }).extract({ left, top, width, height }).raw().toBuffer();
  const scaled = await sharp(part, { raw: { width, height, channels: 3 } })
    .affine([z, 0, 0, z], { odx: -(win.x - left) * z, ody: -(win.y - top) * z, interpolator: "bicubic" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return sharp(scaled.data, { raw: { width: scaled.info.width, height: scaled.info.height, channels: 3 } })
    .extract({ left: 0, top: 0, width: OUT.w, height: OUT.h })
    .raw()
    .toBuffer();
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
  /** Background music, looped under the voice. */
  music?: string;
  musicVolume?: number;
  log?: (s: string) => void;
}

export async function renderTalk(r: RenderInput): Promise<{ video: string; seconds: number }> {
  const wav = r.out.replace(/\.mp4$/, "") + ".voice.wav";
  writeFileSync(wav, wavBytes(r.voice.pcm, r.voice.rate));
  const pics = new Pictures(r.art, r.artDir);
  const captions = new CaptionCache(r.chunks);
  const title = r.title ? await titleOverlay(r.title) : undefined;

  const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${OUT.w}x${OUT.h}`, "-r", String(FPS), "-i", "pipe:0", "-i", wav];
  let audio = "1:a";
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
    const base = await shoot(await pics.get(fr.gesture, fr.mouth, fr.blink), fr);
    const overlays: Overlay[] = [];
    if (title) overlays.push(title);
    if (fr.chunk !== undefined && fr.word !== undefined) overlays.push(await captions.get(fr.chunk, fr.word, fr.age));
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
