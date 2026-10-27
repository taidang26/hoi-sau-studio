/**
 * One illustration per character of its `edge`: the rebellious or weird side
 * behind the good behaviour. Drawn against the locked model and pose sheets,
 * so it shows the same character, and never redraws the sheets.
 *
 *   npm run studio -- edge [slug…] [--mock]
 *
 * Writes output/edge/<slug>.png (4:5) and output/edge/index.html, a page with
 * every picture next to its edge in Vietnamese.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { characterRefs, type StudioContext } from "./episode.js";
import { generateSoftly, type Usage } from "./muse-image.js";
import { iconLine } from "./prompts.js";
import { styleReference, styleText } from "./style.js";
import { SERIES_DIR } from "./bible.js";

export const EDGE_SIZE = { width: 1080, height: 1350 };

export function edgePrompt(ctx: StudioContext, slug: string): string {
  const p = ctx.profiles.get(slug)!;
  const scene = p.look.expressions.edge ?? p.look.expressions.default;
  const style = ctx.style ? styleText(ctx.style) : p.look.style;
  return [
    `A single full comic illustration revealing the secret side of the character from the sheet: ${p.name} (${p.species}), ${scene}.`,
    `Keep the character exactly as on the sheet: ${p.look.signature.join("; ")}. ${iconLine(p)}`,
    "Make it the dramatic reveal panel of a comic: exaggerated cartoon acting, squash and stretch, a strong line of action, drawn comic effects (motion lines, sparkles, steam, shock lines) as pictures. The character fills most of the frame, with a simple background that tells where we are.",
    `Style: ${style}`,
    "No text, no letters, no numbers, no logos, no speech bubbles, no captions.",
  ]
    .filter(Boolean)
    .join(" ");
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function galleryPage(ctx: StudioContext, done: string[]): string {
  const cards = done
    .map((slug) => {
      const p = ctx.profiles.get(slug)!;
      return `<figure><img src="${esc(slug)}.png" alt="${esc(p.name)}"><figcaption><b>${esc(p.name)}</b> · ${esc(p.species)}<p>${esc(p.edge ?? "")}</p></figcaption></figure>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mặt dị của từng nhân vật</title>
<style>body{font-family:system-ui,sans-serif;background:#fffaf0;margin:0;padding:16px}h1{font-size:22px}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}figure{margin:0;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 10px #0002}img{width:100%;display:block}figcaption{padding:10px 12px;font-size:14px}figcaption p{margin:6px 0 0;color:#444}</style>
<h1>Mặt dị của từng nhân vật</h1><main>${cards}</main>`;
}

export async function makeEdgeArt(ctx: StudioContext, slugs: string[], outDir: string, log: (s: string) => void = () => {}): Promise<{ files: string[]; usage: Usage[] }> {
  mkdirSync(outDir, { recursive: true });
  const usage: Usage[] = [];
  const done: string[] = [];
  const styleRef = styleReference(ctx.style, ctx.seriesDir ?? SERIES_DIR);
  for (const slug of slugs) {
    if (!ctx.profiles.has(slug)) throw new Error(`no character ${slug}`);
    log(`${slug}: edge`);
    const references = [...(styleRef ? [styleRef] : []), ...characterRefs(ctx, slug)];
    let res;
    try {
      res = await generateSoftly(ctx.image, { prompt: edgePrompt(ctx, slug), size: "1024x1280", references }, log);
    } catch (e) {
      log(`${slug}: skipped (${(e as Error).message})`);
      continue;
    }
    if (res.usage) usage.push(res.usage);
    const png = await sharp(res.image).resize(EDGE_SIZE.width, EDGE_SIZE.height, { fit: "cover", position: "centre" }).png().toBuffer();
    writeFileSync(join(outDir, `${slug}.png`), png);
    done.push(slug);
  }
  writeFileSync(join(outDir, "index.html"), galleryPage(ctx, done));
  return { files: done.map((s) => join(outDir, `${s}.png`)), usage };
}
