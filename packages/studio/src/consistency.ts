/**
 * Character consistency test: one character sheet, then three panels chained
 * from it in the same conversation. Writes images, the exact prompts, response
 * ids and token usage, and a contact sheet to review against the signature.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { imageSize } from "@hoi-sau/svg-text";
import type { MuseImage, Usage } from "./muse-image.js";
import type { Profile } from "./profile.js";
import { characterSheetPrompt, consistencyBeats, panelPrompt, poseSheetPrompt } from "./prompts.js";

export interface RunImage {
  id: string;
  file: string;
  prompt: string;
  size: string;
  responseId: string;
  previousResponseId?: string;
  usage: Usage;
  note: string;
}

export interface ConsistencyRun {
  slug: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  mock: boolean;
  images: RunImage[];
  signature: string[];
}

const ext = (data: Buffer) => {
  try {
    return imageSize(data).mime.split("/")[1].replace("jpeg", "jpg");
  } catch {
    return "bin";
  }
};

export async function runConsistency(
  client: MuseImage,
  profile: Profile,
  outDir: string,
  opts: {
    model: string;
    mock: boolean;
    log?: (s: string) => void;
    /** Series style sentence and its locked reference image (data URL), from series/style.yaml. */
    style?: string;
    styleRef?: string;
  },
): Promise<ConsistencyRun> {
  const log = opts.log ?? (() => {});
  mkdirSync(outDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const images: RunImage[] = [];

  const save = (id: string, data: Buffer) => {
    const file = `${id}.${ext(data)}`;
    writeFileSync(join(outDir, file), data);
    return file;
  };

  const sheetPrompt = characterSheetPrompt(profile, opts.style);
  log(`${profile.slug}: character sheet`);
  // The locked style render rides with the first turn; later turns chain from it.
  const sheet = await client.generate({ prompt: sheetPrompt, size: "1536x1024", references: opts.styleRef ? [opts.styleRef] : undefined });
  images.push({ id: "sheet", file: save("sheet", sheet.image), prompt: sheetPrompt, size: "1536x1024", responseId: sheet.id, usage: sheet.usage, note: sheet.note });

  const posePrompt = poseSheetPrompt(profile, opts.style);
  log(`${profile.slug}: pose sheet`);
  const poses = await client.generate({ prompt: posePrompt, size: "1536x1024", previousResponseId: sheet.id });
  images.push({ id: "poses", file: save("poses", poses.image), prompt: posePrompt, size: "1536x1024", responseId: poses.id, previousResponseId: sheet.id, usage: poses.usage, note: poses.note });

  // Each panel chains from the previous turn, so the sheet and poses stay in context.
  let previous = poses.id;
  for (const beat of consistencyBeats(profile)) {
    const prompt = panelPrompt(profile, beat.scene, opts.style);
    log(`${profile.slug}: panel ${beat.id}`);
    const res = await client.generate({ prompt, size: beat.size, previousResponseId: previous });
    images.push({ id: beat.id, file: save(beat.id, res.image), prompt, size: beat.size, responseId: res.id, previousResponseId: previous, usage: res.usage, note: res.note });
    previous = res.id;
  }

  const run: ConsistencyRun = {
    slug: profile.slug,
    model: opts.model,
    startedAt,
    finishedAt: new Date().toISOString(),
    mock: opts.mock,
    images,
    signature: profile.look.signature,
  };
  writeFileSync(join(outDir, "run.json"), JSON.stringify(run, null, 2));
  writeFileSync(join(outDir, "review.html"), reviewPage(profile, run));
  return run;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A static page: every image with a checkbox per signature feature, for a quick human pass. */
function reviewPage(p: Profile, run: ConsistencyRun): string {
  const cards = run.images
    .map(
      (img) => `<figure><img src="${esc(img.file)}" alt="${esc(img.id)}"><figcaption><b>${esc(img.id)}</b> · ${esc(img.size)} · ${img.usage.total_tokens ?? "?"} tokens
<ul>${run.signature.map((s) => `<li><label><input type="checkbox"> ${esc(s)}</label></li>`).join("")}</ul>
<details><summary>prompt</summary><pre>${esc(img.prompt)}</pre></details></figcaption></figure>`,
    )
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>${esc(p.name)} consistency</title>
<style>body{font:15px system-ui;margin:24px;background:#faf7f0;color:#222}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:20px}
figure{margin:0;background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px}img{width:100%;border-radius:4px}pre{white-space:pre-wrap;font-size:12px}ul{padding-left:18px}</style>
<h1>${esc(p.name)} · Muse Image consistency test${run.mock ? " (mock)" : ""}</h1>
<p>${esc(run.model)} · ${esc(run.startedAt)} · tick each feature that matches the sheet.</p>
<main>${cards}</main>`;
}
