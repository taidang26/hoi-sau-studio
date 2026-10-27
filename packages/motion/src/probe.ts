/**
 * Checks a rendered video against what Reels (Facebook, Instagram) and
 * Threads accept, before anything is uploaded.
 */

import { ffprobePath, run } from "./ffmpeg.js";

export interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  videoCodec?: string;
  pixFmt?: string;
  audioCodec?: string;
  sizeBytes: number;
}

export async function probeVideo(file: string): Promise<VideoInfo> {
  const { stdout } = await run(ffprobePath(), [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt:format=duration,size",
    "-of", "json", file,
  ]);
  const j = JSON.parse(stdout) as {
    streams: { codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string; pix_fmt?: string }[];
    format: { duration: string; size: string };
  };
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  const [n, d] = (v?.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    duration: Number(j.format.duration),
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    fps: d ? n / d : 0,
    videoCodec: v?.codec_name,
    pixFmt: v?.pix_fmt,
    audioCodec: a?.codec_name,
    sizeBytes: Number(j.format.size),
  };
}

/** Problems that would make Meta reject the video or crop it badly. Empty means fine. */
export function reelsProblems(v: VideoInfo): string[] {
  const out: string[] = [];
  if (v.videoCodec !== "h264") out.push(`video codec is ${v.videoCodec}, Reels needs H.264`);
  if (v.pixFmt !== "yuv420p") out.push(`pixel format is ${v.pixFmt}, Reels needs yuv420p`);
  if (Math.abs(v.width / v.height - 9 / 16) > 0.01) out.push(`aspect is ${v.width}x${v.height}, Reels needs 9:16`);
  if (v.width < 540) out.push(`width ${v.width} is below 540`);
  if (v.fps < 23 || v.fps > 60) out.push(`frame rate ${v.fps} is outside 23–60`);
  if (v.duration < 3) out.push(`duration ${v.duration.toFixed(1)}s is under 3s`);
  // Facebook Reels caps at 90 s; Instagram allows more, so 90 is the shared limit.
  if (v.duration > 90) out.push(`duration ${v.duration.toFixed(1)}s is over 90s (Facebook Reels limit)`);
  if (v.audioCodec !== "aac") out.push(`audio is ${v.audioCodec ?? "missing"}, use AAC`);
  if (v.sizeBytes > 1_000_000_000) out.push("file is over 1 GB");
  return out;
}
