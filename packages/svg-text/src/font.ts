/**
 * Font loading and measuring. Dialogue is measured and drawn with the same
 * font file, so line breaks computed here match what ends up on the panel.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

export interface LoadedFont {
  font: opentype.Font;
  /** Family name used for the `<text>` render mode and @font-face. */
  family: string;
  /** Raw font file, kept for embedding and for PNG export. */
  data: Buffer;
  path: string;
}

/** Be Vietnam Pro (SIL OFL 1.1), shipped in ../fonts with its licence. */
export const DEFAULT_FONT_PATH = fileURLToPath(new URL("../fonts/BeVietnamPro-SemiBold.ttf", import.meta.url));
export const BOLD_FONT_PATH = fileURLToPath(new URL("../fonts/BeVietnamPro-Bold.ttf", import.meta.url));

const cache = new Map<string, LoadedFont>();

export function loadFont(path: string = DEFAULT_FONT_PATH): LoadedFont {
  const hit = cache.get(path);
  if (hit) return hit;
  const data = readFileSync(path);
  const font = opentype.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  const family = font.names.fontFamily?.en ?? "Dialogue";
  const loaded = { font, family, data, path };
  cache.set(path, loaded);
  return loaded;
}

export function measure(font: LoadedFont, text: string, size: number): number {
  return font.font.getAdvanceWidth(text, size, { kerning: true });
}

/**
 * Characters the font has no glyph for. A missing glyph would render as a box
 * or fall back to another font, which is exactly the broken-diacritic look the
 * text layer exists to avoid, so callers should refuse to render.
 */
export function missingGlyphs(font: LoadedFont, text: string): string[] {
  const missing = new Set<string>();
  for (const ch of text.normalize("NFC")) {
    if (/\s/u.test(ch)) continue;
    if (font.font.charToGlyphIndex(ch) === 0) missing.add(ch);
  }
  return [...missing];
}

export interface FontMetrics {
  ascender: number;
  descender: number;
}

/** Ascender and descender in px at `size`. Descender is negative. */
export function metrics(font: LoadedFont, size: number): FontMetrics {
  const scale = size / font.font.unitsPerEm;
  return { ascender: font.font.ascender * scale, descender: font.font.descender * scale };
}
