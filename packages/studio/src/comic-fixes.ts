/**
 * Sửa bằng lời for comics: the owner writes what is wrong with a finished episode the way he
 * would tell a person ("khung 2 Bống nói 'thôi xong' chứ không phải 'xong rồi'", "bỏ cái cốc
 * trên bàn"). Muse Spark reads the note against the script and small copies of the finished
 * panels and answers with concrete edits, which wait on the page until he presses Áp dụng.
 *
 * Applying keeps a copy of what it changes in fix-undo/, so the page can show before and after
 * and put everything back. Changed words go through the safety gate again before lettering;
 * a changed picture is an edit of that panel only, never a new episode.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { imageSize } from "@hoi-sau/svg-text";
import { characterRefs, episodeDir, panelSize, readStep, runStep, writeStep, type EpisodeSpec, type PanelRender, type Script, type StudioContext } from "./episode.js";
import { houseRulesPrompt } from "./house-rules.js";
import { generateSoftly } from "./muse-image.js";
import { S, type ChatMessage } from "./muse-spark.js";
import { maskSwears } from "./swears.js";

export const COMIC_FIX_KINDS = ["line_text", "add_line", "drop_line", "headline", "fix_picture", "redraw"] as const;
export type ComicFixKind = (typeof COMIC_FIX_KINDS)[number];

/** One edit. Fields a kind does not use are empty ("" or -1). Panels count from 1. */
export interface ComicFix {
  do: ComicFixKind;
  panel: number;
  line: number;
  speaker: string;
  text: string;
  /** English instruction for the picture (fix_picture, redraw). */
  what: string;
  /** One short Vietnamese sentence the owner reads. */
  say: string;
}

export interface ComicFixPlan {
  reply: string;
  actions: ComicFix[];
}

const ACTION = S.obj({
  do: S.enum([...COMIC_FIX_KINDS]),
  panel: S.int("panel number from 1, or -1"),
  line: S.int("index of the dialogue line in that panel from 0, or -1"),
  speaker: S.str("cast slug of who says it (add_line), or empty"),
  text: S.str("new Vietnamese words exactly as they should read, or empty"),
  what: S.str("English instruction for the picture, or empty"),
  say: S.str("one short Vietnamese sentence describing this edit for the owner"),
});
const PLAN = S.obj({ reply: S.str("short Vietnamese answer"), actions: S.arr(ACTION, 0, 10) });

const UNDO = "fix-undo";
export const comicUndoDir = (id: string, dir?: string) => join(episodeDir(id, dir), UNDO);

/** The script as the model reads it. */
export function describeComic(script: Script, headline?: string): string {
  const panels = script.panels
    .map((p, i) => `  panel ${i + 1}: ${p.setting}. ${p.action}\n${p.dialogue.map((d, k) => `    line ${k} ${d.speaker}${d.kind && d.kind !== "speech" ? ` (${d.kind})` : ""}: "${d.text}"`).join("\n") || "    (no dialogue)"}`)
    .join("\n");
  return `${headline ? `Headline band above panel 1: "${headline}"\n` : ""}Panels:\n${panels}`;
}

/** Drops edits that point at panels or lines that do not exist. */
export function validComicFix(script: Script, cast: string[], a: ComicFix): boolean {
  const p = script.panels[a.panel - 1];
  switch (a.do) {
    case "headline": return true;
    case "line_text": return !!p && !!p.dialogue[a.line] && !!a.text.trim();
    case "drop_line": return !!p && !!p.dialogue[a.line];
    case "add_line": return !!p && !!a.text.trim() && cast.includes(a.speaker) && p.dialogue.length < 3;
    case "fix_picture":
    case "redraw": return !!p && !!a.what.trim();
  }
}

/** Turns the owner's note into edits. Nothing changes until applyComicFixes. */
export async function askComicFixes(ctx: StudioContext, id: string, note: string): Promise<ComicFixPlan> {
  const dir = ctx.dir;
  const ep = readStep<EpisodeSpec>(id, "episode", dir);
  const script = readStep<Script>(id, "script", dir);
  if (!ep || !script) throw new Error(`${id}: no script yet`);
  const pages = readStep<{ pages: Array<{ n: number; file: string }> }>(id, "letter", dir)?.pages ?? [];
  const thumbs: ChatMessage["content"] = [];
  for (const p of pages) {
    const f = join(episodeDir(id, dir), p.file);
    if (!existsSync(f)) continue;
    const jpg = await sharp(f).resize(432, 540, { fit: "inside" }).jpeg({ quality: 70 }).toBuffer();
    thumbs.push({ type: "text", text: `Finished panel ${p.n}:` }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpg.toString("base64")}` } });
  }
  const text = [
    "You help the owner fix a finished Vietnamese office-comedy comic. The pictures are drawn by an image model and the speech bubbles are lettered on top afterwards, so words and pictures are fixed separately. He writes in Vietnamese what is wrong. Turn it into the fewest edits that do exactly what he asks, nothing more.",
    describeComic(script, ep.headline),
    `Cast slugs: ${ep.characters.join(", ")}`,
    `His note: """${note.trim()}"""`,
    "Edits you can use:",
    "- line_text(panel, line, text): a bubble says the wrong words. Keep his exact Vietnamese spelling and change only what he points at.",
    "- add_line(panel, speaker, text): a new bubble. At most three bubbles a panel, 12 words each.",
    "- drop_line(panel, line): a bubble that should go.",
    "- headline(text): the headline band above panel 1; empty text removes it.",
    "- fix_picture(panel, what): one thing in the picture is wrong and the rest is good (a wrong object, a colour, a hand, something to remove or add). `what` is a short English edit instruction. Prefer this over redraw.",
    "- redraw(panel, what): the whole picture is wrong (wrong place, wrong character, wrong moment). `what` says in English what it must show. Never a real person.",
    "Fill every field: panel number or -1, line index or -1, speaker slug or empty. Write `say` as one short Vietnamese sentence, e.g. 'Khung 2: đổi \"xong rồi\" thành \"thôi xong\"'.",
    "If the note is unclear, return no edits and ask one short question in `reply`. Otherwise `reply` says in one short Vietnamese sentence what WILL be done (nothing changes until he presses the button).",
    houseRulesPrompt(["dialogue", "art"]),
  ].filter(Boolean).join("\n\n");
  const r = await ctx.spark.json<ComicFixPlan>("comic_fixes", PLAN, [{ role: "user", content: [{ type: "text", text }, ...thumbs] }]);
  return { reply: r.reply, actions: r.actions.filter((a) => validComicFix(script, ep.characters, a)) };
}

const ROOT_FILES = /^(episode|script|safety|panels|review|letter)\.json$/;
const cacheFiles = (n: number) => [`panel-${n}-recoloured.png`, `panel-${n}-finished.png`];

/** Copies what a fix can change: the step files, the finished pages and the changed panels' colour caches. */
function snapshot(id: string, panels: number[], dir?: string): void {
  const folder = episodeDir(id, dir), undo = comicUndoDir(id, dir);
  rmSync(undo, { recursive: true, force: true });
  mkdirSync(join(undo, "panels"), { recursive: true });
  for (const f of readdirSync(folder)) if (ROOT_FILES.test(f)) copyFileSync(join(folder, f), join(undo, f));
  if (existsSync(join(folder, "final"))) cpSync(join(folder, "final"), join(undo, "final"), { recursive: true });
  for (const n of panels) for (const c of cacheFiles(n)) if (existsSync(join(folder, "panels", c))) copyFileSync(join(folder, "panels", c), join(undo, "panels", c));
  writeFileSync(join(undo, "changed.json"), JSON.stringify({ panels, at: new Date().toISOString() }));
}

/** What the last applied fix changed, while it can still be undone. */
export function comicFixDone(id: string, dir?: string): { panels: number[]; at: string } | undefined {
  const f = join(comicUndoDir(id, dir), "changed.json");
  try {
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Applies the picked edits: words into the script (checked again for safety), pictures as an
 * edit of that panel, then the panels are lettered again. Throws, with everything put back,
 * when the safety gate refuses the new words or a step fails.
 */
export async function applyComicFixes(ctx: StudioContext, id: string, actions: ComicFix[]): Promise<number[]> {
  const dir = ctx.dir;
  const log = ctx.log ?? (() => {});
  const ep = readStep<EpisodeSpec>(id, "episode", dir);
  const script = readStep<Script>(id, "script", dir);
  const panels = readStep<{ renders: PanelRender[] }>(id, "panels", dir);
  if (!ep || !script || !panels) throw new Error(`${id}: nothing drawn yet`);
  const ok = actions.filter((a) => validComicFix(script, ep.characters, a));
  if (!ok.length) throw new Error(`${id}: no edit to apply`);
  const touched = [...new Set(ok.filter((a) => a.panel > 0).map((a) => a.panel))].sort((a, b) => a - b);
  snapshot(id, touched, dir);
  try {
    // Words: drops last and from the end, so earlier line numbers still point at the right bubble.
    let words = false;
    for (const a of ok.filter((x) => x.do === "line_text")) (script.panels[a.panel - 1].dialogue[a.line].text = maskSwears(a.text.trim())), (words = true);
    for (const a of ok.filter((x) => x.do === "add_line")) script.panels[a.panel - 1].dialogue.push({ speaker: a.speaker, text: maskSwears(a.text.trim()), kind: "speech" }), (words = true);
    for (const a of ok.filter((x) => x.do === "drop_line").sort((x, y) => y.line - x.line)) script.panels[a.panel - 1].dialogue.splice(a.line, 1), (words = true);
    const head = ok.find((x) => x.do === "headline");
    if (head) {
      const next = { ...ep } as EpisodeSpec;
      if (head.text.trim()) next.headline = head.text.trim();
      else delete next.headline;
      writeStep(id, "episode", next, dir);
      words = true;
    }
    if (words) {
      writeStep(id, "script", script, dir);
      log(`${id}: checking the new words`);
      await runStep(ctx, id, "safety");
    }
    // Pictures: one edit of the panel as it is, the rest kept.
    for (const n of touched) {
      const edits = ok.filter((x) => x.panel === n && (x.do === "fix_picture" || x.do === "redraw"));
      if (!edits.length) continue;
      const r = panels.renders.find((x) => x.n === n);
      if (!r) continue;
      const png = readFileSync(join(episodeDir(id, dir), r.file));
      const whole = edits.some((x) => x.do === "redraw");
      const ask = edits.map((x) => x.what.trim()).join("; ");
      const prompt = whole
        ? `Redraw the attached panel so it shows: ${ask}. Keep the same characters exactly on-model as in their model sheets, the same art style, colours and framing size. No text, no speech bubbles.`
        : `Edit the attached panel. Change only this: ${ask}. Keep everything else exactly the same: characters, poses, composition, background, colours and line style. No text.`;
      const cast = whole ? [...new Set(script.panels[n - 1].characters)].flatMap((c) => characterRefs(ctx, c)) : [];
      log(`${id}: ${whole ? "redraw" : "fix"} panel ${n}`);
      const res = await generateSoftly(ctx.image, { prompt, size: panelSize(ep, n), references: [`data:image/${imageSize(png).mime.split("/")[1]};base64,${png.toString("base64")}`, ...cast] }, (m) => log(`${id}: panel ${n}: ${m}`));
      const k = r.history.length + 1;
      const name = `panel-${n}-word${k}.${imageSize(res.image).mime.split("/")[1]}`;
      writeFileSync(join(episodeDir(id, dir), "panels", name), res.image);
      Object.assign(r, { history: [...r.history, r.file], file: `panels/${name}`, responseId: res.id, prompt: `${r.prompt}\n\nFix: ${ask}` });
      for (const c of cacheFiles(n)) rmSync(join(episodeDir(id, dir), "panels", c), { force: true });
    }
    writeStep(id, "panels", panels, dir);
    log(`${id}: lettering again`);
    await runStep(ctx, id, "letter");
    return touched;
  } catch (e) {
    undoComicFix(id, dir);
    throw e;
  }
}

/** Puts the step files, finished pages and colour caches back as they were before the last fix. */
export function undoComicFix(id: string, dir?: string): void {
  const folder = episodeDir(id, dir), undo = comicUndoDir(id, dir);
  const done = comicFixDone(id, dir);
  if (!done) throw new Error(`${id}: nothing to undo`);
  for (const f of readdirSync(undo)) if (ROOT_FILES.test(f)) copyFileSync(join(undo, f), join(folder, f));
  if (existsSync(join(undo, "final"))) {
    // File by file: on Windows a picture the page is showing can hold the folder.
    mkdirSync(join(folder, "final"), { recursive: true });
    for (const f of readdirSync(join(undo, "final"))) copyFileSync(join(undo, "final", f), join(folder, "final", f));
  }
  for (const n of done.panels)
    for (const c of cacheFiles(n)) {
      const kept = join(undo, "panels", c);
      if (existsSync(kept)) copyFileSync(kept, join(folder, "panels", c));
      else rmSync(join(folder, "panels", c), { force: true });
    }
  rmSync(undo, { recursive: true, force: true });
}

/** Keeps the fix: the copy from before goes. */
export function keepComicFix(id: string, dir?: string): void {
  rmSync(comicUndoDir(id, dir), { recursive: true, force: true });
}
