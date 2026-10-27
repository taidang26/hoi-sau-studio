/**
 * Series art style: series/style.yaml. One look shared by every character and
 * panel, so the comic reads as one series instead of four prompts that happen
 * to sit together. `studio style` draws the same test scene in each variant;
 * `studio style approve <id>` locks one render as series/style-ref.*, which is
 * attached as a reference image to every model sheet and episode.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { parse, parseDocument } from "yaml";
import { imageSize } from "@hoi-sau/svg-text";
import { SERIES_DIR } from "./bible.js";
import type { MuseImage, Usage } from "./muse-image.js";

export interface StyleVariant {
  id: string;
  /** Vietnamese, for the person choosing. */
  label: string;
  /** English, appended to `base`. */
  prompt: string;
}

export interface SeriesStyle {
  chosen: string | null;
  /** File name under the series folder, set on approve. */
  reference: string | null;
  base: string;
  avoid: string[];
  variants: StyleVariant[];
  test_scene: string;
}

export const STYLE_TEST_SIZE = "1024x1280";

/** undefined when the series has no style file yet; panels then use each profile's look.style. */
export function loadStyle(dir = SERIES_DIR): SeriesStyle | undefined {
  const file = join(dir, "style.yaml");
  if (!existsSync(file)) return undefined;
  const s = parse(readFileSync(file, "utf8")) as SeriesStyle;
  const errors: string[] = [];
  if (typeof s?.base !== "string" || !s.base.trim()) errors.push("base is required");
  if (!Array.isArray(s?.variants) || !s.variants.length || !s.variants.every((v) => v?.id && v?.prompt)) errors.push("variants need { id, label, prompt }");
  if (s?.chosen != null && !s.variants?.some((v) => v.id === s.chosen)) errors.push(`chosen "${s.chosen}" is not a variant`);
  if (errors.length) throw new Error(`series/style.yaml: ${errors.join("; ")}`);
  return { ...s, avoid: s.avoid ?? [], chosen: s.chosen ?? null, reference: s.reference ?? null };
}

/** The style sentence for prompts: base plus the chosen variant (or the one given). */
export function styleText(style: SeriesStyle, variant = style.chosen): string {
  const v = style.variants.find((x) => x.id === variant);
  return [style.base, v?.prompt, style.avoid.length ? `Avoid: ${style.avoid.join("; ")}.` : ""].filter(Boolean).join(" ");
}

/** The locked style render as a data URL, ready for MuseImage references. */
export function styleReference(style: SeriesStyle | undefined, dir = SERIES_DIR): string | undefined {
  if (!style?.reference) return undefined;
  const f = join(dir, style.reference);
  if (!existsSync(f)) return undefined;
  const data = readFileSync(f);
  return `data:${imageSize(data).mime};base64,${data.toString("base64")}`;
}

export interface StyleRender {
  id: string;
  label: string;
  file: string;
  prompt: string;
  responseId: string;
  usage: Usage;
}

/** Draw the test scene once per variant, each as a fresh conversation, plus a review page. */
export async function runStyleTest(client: MuseImage, style: SeriesStyle, outDir: string, opts: { mock: boolean; log?: (s: string) => void }): Promise<StyleRender[]> {
  mkdirSync(outDir, { recursive: true });
  const renders: StyleRender[] = [];
  for (const v of style.variants) {
    const prompt = `${style.test_scene.trim()}\nSingle comic panel. Style: ${styleText(style, v.id)}`;
    opts.log?.(`style: ${v.id}`);
    const res = await client.generate({ prompt, size: STYLE_TEST_SIZE });
    const file = `${v.id}.${imageSize(res.image).mime.split("/")[1].replace("jpeg", "jpg")}`;
    writeFileSync(join(outDir, file), res.image);
    renders.push({ id: v.id, label: v.label, file, prompt, responseId: res.id, usage: res.usage });
  }
  writeFileSync(join(outDir, "run.json"), JSON.stringify({ mock: opts.mock, renders }, null, 2));
  writeFileSync(join(outDir, "review.html"), reviewPage(renders, opts.mock));
  return renders;
}

/** Lock one variant: copy its render to series/style-ref.* and record it in style.yaml, comments kept. */
export function approveStyle(id: string, runDir: string, dir = SERIES_DIR): string {
  const style = loadStyle(dir);
  if (!style) throw new Error(`no series/style.yaml in ${dir}`);
  if (!style.variants.some((v) => v.id === id)) throw new Error(`unknown style "${id}"; one of ${style.variants.map((v) => v.id).join(", ")}`);
  const src = existsSync(runDir) ? readdirSync(runDir).find((f) => f.startsWith(`${id}.`) && /\.(png|jpe?g|webp)$/.test(f)) : undefined;
  if (!src) throw new Error(`no render for ${id} in ${runDir}; run \`studio style\` first`);
  const name = `style-ref${extname(src)}`;
  copyFileSync(join(runDir, src), join(dir, name));
  const file = join(dir, "style.yaml");
  const doc = parseDocument(readFileSync(file, "utf8"));
  doc.set("chosen", id);
  doc.set("reference", name);
  writeFileSync(file, doc.toString());
  return name;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function reviewPage(renders: StyleRender[], mock: boolean): string {
  const cards = renders
    .map(
      (r) => `<figure><img src="${esc(r.file)}" alt="${esc(r.id)}"><figcaption><b>${esc(r.label)}</b><br><code>studio style approve ${esc(r.id)}</code>
<details><summary>prompt</summary><pre>${esc(r.prompt)}</pre></details></figcaption></figure>`,
    )
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>Series style</title>
<style>body{font:15px system-ui;margin:24px;background:#faf7f0;color:#222}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px}
figure{margin:0;background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px}img{width:100%;border-radius:4px}pre{white-space:pre-wrap;font-size:12px}</style>
<h1>Chọn phong cách cho cả series${mock ? " (mock)" : ""}</h1>
<p>Cùng một cảnh, mỗi kiểu vẽ một lần. Chọn kiểu đọc rõ nhất ở cỡ điện thoại.</p>
<main>${cards}</main>`;
}
