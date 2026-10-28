/**
 * Thin wrapper over the ffmpeg and ffprobe binaries. Set FFMPEG_PATH and
 * FFPROBE_PATH when they are not on PATH (e.g. a Windows install).
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export class MotionError extends Error {
  constructor(
    message: string,
    readonly stderr = "",
  ) {
    super(message);
    this.name = "MotionError";
  }
}

export const ffmpegPath = () => process.env.FFMPEG_PATH || "ffmpeg";
export const ffprobePath = () => process.env.FFPROBE_PATH || "ffprobe";

export function run(bin: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((ok, fail) => {
    const p = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) =>
      fail(new MotionError(`Could not start ${bin}: ${e.message}. Install ffmpeg or set FFMPEG_PATH / FFPROBE_PATH.`)),
    );
    p.on("close", (code) => {
      if (code === 0) return ok({ stdout, stderr });
      const tail = stderr.trim().split(/\r?\n/).slice(-8).join("\n");
      fail(new MotionError(`${bin} exited with ${code}:\n${tail}`, stderr));
    });
  });
}

/**
 * Settings for an mp4 a phone downloads: H.264 High at about 1.1 Mbps at most
 * (flat comic pictures look the same as at crf 18 and the file is half the
 * size), a keyframe every 2 s, AAC 128k, and the index at the front so it
 * starts playing before it has finished loading. Put after the encoder's own
 * options: the later -crf wins.
 */
export const DELIVERY = ["-profile:v", "high", "-pix_fmt", "yuv420p", "-crf", "23", "-maxrate", "1100k", "-bufsize", "2200k", "-g", "60", "-keyint_min", "30", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"];

/**
 * Runs ffmpeg in `cwd`. Filters refer to text and font files by bare names in
 * that directory, so no path (with a Windows drive colon) ever needs
 * filtergraph escaping.
 */
export const ffmpeg = (args: string[], cwd?: string) =>
  run(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", ...args], cwd);

let decoders: Promise<string> | undefined;

/** True when this ffmpeg build can decode SVG (librsvg); Windows builds often cannot. */
export async function canDecodeSvg(): Promise<boolean> {
  decoders ??= run(ffmpegPath(), ["-hide_banner", "-decoders"]).then((r) => r.stdout, () => "");
  return /\b(librsvg|svg)\b/.test(await decoders);
}

const FONT_CANDIDATES = [
  "packages/svg-text/fonts/BeVietnamPro-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
  "C:/Windows/Fonts/arialbd.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/Library/Fonts/Arial Bold.ttf",
];

/**
 * A bold font with Vietnamese glyphs for titles burnt into the video. Prefers
 * the repo's Be Vietnam Pro (from the svg-text package), found by walking up
 * from the working directory, then common system fonts.
 */
export function findFont(explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (process.env.HOISAU_FONT) return process.env.HOISAU_FONT;
  for (const c of FONT_CANDIDATES) {
    if (c.startsWith("/") || /^[A-Z]:/.test(c)) {
      if (existsSync(c)) return c;
      continue;
    }
    for (let dir = resolve("."); ; dir = dirname(dir)) {
      const p = join(dir, c);
      if (existsSync(p)) return p;
      if (dirname(dir) === dir) break;
    }
  }
  return undefined;
}

/** Copies the title font into `workDir` as font.ttf and returns that bare name. */
export function stageFont(workDir: string, explicit?: string): string | undefined {
  const font = findFont(explicit);
  if (!font) return undefined;
  copyFileSync(font, join(workDir, "font.ttf"));
  return "font.ttf";
}
