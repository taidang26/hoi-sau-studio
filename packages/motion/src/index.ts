/**
 * Motion comic: lettered panels → a 9:16 MP4 for Reels and Threads, with a
 * cover image and subtitles. Needs ffmpeg (FFMPEG_PATH / FFPROBE_PATH).
 */

export * from "./camera.js";
export * from "./episode.js";
export { canDecodeSvg, ffmpeg, findFont, MotionError } from "./ffmpeg.js";
export * from "./probe.js";
export * from "./render.js";
export { toSrt, type Cue } from "./srt.js";
export { readingSeconds, wrap } from "./text.js";
