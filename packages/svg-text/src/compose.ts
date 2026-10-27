/**
 * Panel + dialogue → one SVG, and SVG → PNG. The panel image is never touched:
 * editing a line means re-running this step only.
 */

import { Resvg } from "@resvg/resvg-js";
import { ALL_FONT_PATHS, loadFont } from "./font.js";
import { type Bubble, bubbleFont, escapeXml, fontFace, renderSpeech, type SpeechOptions } from "./render.js";

export interface PanelImage {
  data: Buffer;
  /** e.g. "image/webp", "image/png". */
  mime: string;
  width: number;
  height: number;
}

export interface DialogueLine {
  /** Speaker slug, kept for the script ↔ panel record; not drawn. */
  speaker?: string;
  text: string;
  bubble: Bubble;
  options?: SpeechOptions;
}

export interface ComposeResult {
  svg: string;
  /** Lines that did not fit at the minimum font size. Self-review should fail these. */
  overflow: DialogueLine[];
}

export function composePanel(panel: PanelImage, lines: DialogueLine[], defaults: SpeechOptions = {}): ComposeResult {
  const overflow: DialogueLine[] = [];
  const textFonts = new Set<string>();
  const layers = lines.map((line) => {
    const opts = { ...defaults, ...line.options };
    const { svg, fit } = renderSpeech(line.text, line.bubble, opts);
    if (!fit.fits) overflow.push(line);
    if (opts.mode === "text") textFonts.add(opts.fontPath ?? bubbleFont(line.bubble));
    return svg;
  });

  // Only embed fonts when some line uses live text.
  const style = textFonts.size ? `<style>${[...textFonts].map((p) => fontFace(loadFont(p))).join("")}</style>` : "";

  const href = `data:${escapeXml(panel.mime)};base64,${panel.data.toString("base64")}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${panel.width}" height="${panel.height}" viewBox="0 0 ${panel.width} ${panel.height}">` +
    style +
    `<image href="${href}" xlink:href="${href}" x="0" y="0" width="${panel.width}" height="${panel.height}"/>` +
    layers.join("") +
    "</svg>";
  return { svg, overflow };
}

export function svgToPng(svg: string, opts: { width?: number; fontFiles?: string[] } = {}): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: opts.width ? { mode: "width", value: opts.width } : { mode: "original" },
    font: { loadSystemFonts: false, fontFiles: opts.fontFiles ?? ALL_FONT_PATHS },
  });
  return resvg.render().asPng();
}

/** Read width and height from a PNG, JPEG or WebP header, so callers do not need an image library. */
export function imageSize(data: Buffer): { width: number; height: number; mime: string } {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), mime: "image/png" };
  }
  if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") {
    const chunk = data.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3), mime: "image/webp" };
    if (chunk === "VP8L") {
      const b = data.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, mime: "image/webp" };
    }
    if (chunk === "VP8 ") return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff, mime: "image/webp" };
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i < data.length) {
      if (data[i] !== 0xff) break;
      const marker = data[i + 1];
      const len = data.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: data.readUInt16BE(i + 7), height: data.readUInt16BE(i + 5), mime: "image/jpeg" };
      }
      i += 2 + len;
    }
  }
  throw new Error("Unsupported image format (expected PNG, JPEG or WebP)");
}
