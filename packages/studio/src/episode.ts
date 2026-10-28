/**
 * One episode, step by step, each step saved to episodes/<id>/<step>.json:
 *
 *   premise → beats → script → safety → storyboard → panels → review → letter → canon
 *
 * A step reads only what earlier steps saved, so any step can be rerun alone
 * (`--from script` reruns script and everything after it). Writing steps use
 * Muse Spark with a JSON schema; drawing uses Muse Image with each
 * character's locked model sheet as a reference; self-review uses Muse Spark
 * vision against the same sheet and asks Muse Image to fix only what is wrong.
 *
 * `safety` is a gate: every text of the episode is checked by rule and by Muse
 * Spark against series/safety.yaml and the cast's never_says, and nothing is
 * drawn unless it passes. Every step written is logged with its hash in
 * provenance.jsonl, and `approveEpisode` (approve.ts) is the owner's sign-off
 * that `channel publish` checks.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { BOLD_FONT_PATH, BUBBLE_KINDS, composePanel, escapeXml, renderSpeech, imageSize, snugBubble, svgToPng, type BubbleKind, type DialogueLine } from "@hoi-sau/svg-text";
import {
  AUDIENCE_DATA_RULE,
  BANNED_RULE,
  type EpisodeText,
  gateEpisode,
  loadSafety,
  ruleCheck,
  SAFETY_SCHEMA,
  type SafetyPolicy,
  type SafetyVerdict,
  episodeNumber,
  type Llm,
  loadMemorySync,
  loadSeason,
  readEpisodeFiles,
  recap,
  RECAP_SCHEMA,
  remember,
  saveMemory,
  storyBrief,
  WRITER_GUIDE,
} from "@hoi-sau/story";
import { addCanon, SERIES_DIR, type CanonFact, type SeriesBible } from "./bible.js";
import { generateSoftly, type MuseImage } from "./muse-image.js";
import { type ChatMessage, type MuseSpark, S } from "./muse-spark.js";
import { CHARACTERS_DIR, nameVi, type Profile } from "./profile.js";
import { finishPanel, recolourPanel, type Segmenter } from "./finish.js";
import { iconLine } from "./prompts.js";
import { type SeriesStyle, styleReference, styleText } from "./style.js";
import { officeBrief, officePanelText, type Office } from "./office.js";
import { sha256 } from "@hoi-sau/channel";
import { type EpisodeSource, logProvenance, whoAmI } from "./provenance.js";

export const EPISODES_DIR = fileURLToPath(new URL("../../../episodes", import.meta.url));

export const EPISODE_STEPS = ["premise", "beats", "script", "safety", "storyboard", "panels", "review", "letter", "canon"] as const;
export type EpisodeStep = (typeof EPISODE_STEPS)[number];

export interface EpisodeSpec {
  id: string;
  lead: string;
  characters: string[];
  /** Where the story goes, usually picked from comments. */
  direction: string;
  /** Commenters to credit; they may appear as coworkers drawn from text only. */
  credits: Array<{ name: string; comment: string }>;
  /** "carousel" (default): 4–6 panels posted one by one. "strip3": exactly three panels, the rule of three, posted one by one too. "single": one panel that carries the whole joke. */
  format?: EpisodeFormat;
  /** A one-line quote card: this text sits in a band above the panel, the drawing and short lines below it. */
  headline?: string;
  /** Where the direction came from; also the first line of provenance.jsonl. */
  source?: EpisodeSource;
  createdAt: string;
}

export const EPISODE_FORMATS = ["carousel", "strip3", "single"] as const;
export type EpisodeFormat = (typeof EPISODE_FORMATS)[number];

export interface Premise {
  title: string;
  logline: string;
  setup: string;
  twist: string;
  hook: string;
  /** The everyday moment readers recognise; the episode is built around it. */
  trigger?: string;
  cameo: { name: string; description: string } | null;
}

export interface Beats {
  beats: Array<{ purpose: "setup" | "escalation" | "twist" | "punchline" | "hook"; what_happens: string }>;
}

export interface ScriptPanel {
  beat: number;
  setting: string;
  characters: string[];
  action: string;
  expressions: Array<{ character: string; expression: string }>;
  /** kind: said aloud, thought, shouted or whispered; it picks the balloon. Older scripts have none (speech). */
  dialogue: Array<{ speaker: string; text: string; kind?: BubbleKind }>;
}

export interface Script {
  title: string;
  panels: ScriptPanel[];
}

export type Position = "left" | "center" | "right";

export interface BoardPanel {
  shot: "wide" | "medium" | "close-up" | "extreme close-up";
  angle: "eye level" | "high angle" | "low angle";
  /** English, goes to Muse Image. */
  composition: string;
  staging: Array<{ character: string; position: Position }>;
}

export interface Storyboard {
  panels: BoardPanel[];
}

export interface PanelRender {
  n: number;
  file: string;
  responseId: string;
  prompt: string;
  /** Files of earlier renders replaced by a redraw. */
  history: string[];
}

export interface PanelReview {
  n: number;
  pass: boolean;
  issues: Array<{ character: string; feature: string; problem: string }>;
  fix: string;
  redrawn: boolean;
  /** Where each character's head is in the final panel, as shares of width and height; tails aim here. */
  heads?: Array<{ character: string; x: number; y: number }>;
}

export interface StudioContext {
  spark: MuseSpark;
  image: MuseImage;
  bible: SeriesBible;
  /** series/style.yaml; without it panels use the lead's look.style. */
  style?: SeriesStyle;
  /** series/office.yaml: who sits where and the background coworkers. */
  office?: Office;
  profiles: Map<string, Profile>;
  dir?: string;
  charactersDir?: string;
  /** Where bible.yaml, season-<n>.yaml and story-memory.json live. */
  seriesDir?: string;
  /** series/safety.yaml; loaded from seriesDir when not given. */
  safety?: SafetyPolicy;
  /** Redraw attempts per failed panel. */
  maxRedraws?: number;
  /** SAM 3.1: when set, lettering first runs the focus pass (finish.ts) on each panel. */
  segmenter?: Segmenter;
  /** Recolour each approved panel with Muse Image (soft shading, one muted tone) before lettering. */
  recolour?: boolean;
  log?: (s: string) => void;
  saveBible?: (b: SeriesBible) => void;
  saveMemory?: (slug: string, facts: string[], episode: string) => void;
}

const PANEL_SIZE = "1024x1280";

/** How many panels a format takes. */
export function panelRange(ep: Pick<EpisodeSpec, "format">, bible: SeriesBible): { min: number; max: number } {
  if (ep.format === "single") return { min: 1, max: 1 };
  return ep.format === "strip3" ? { min: 3, max: 3 } : bible.format.panels;
}

/**
 * Every panel is 4:5 and posts as its own image, in both formats. Feeds are
 * read on phones, and three panels shrunk onto one page made the lettering
 * too small to read there.
 */
export function panelSize(_ep: Pick<EpisodeSpec, "format">, _n: number): string {
  return PANEL_SIZE;
}

/** A posted image, 4:5. Lettering is sized against it. */
export const POST_SIZE = { width: 1080, height: 1350 };

/**
 * Bring a panel to the post size before lettering. A panel near 4:5 is
 * centre-cropped. One far from it (an old wide panel) is shown whole over a
 * blurred, darkened copy of itself, so nothing in the drawing is cut.
 */
export async function fitPost(image: Buffer, size = POST_SIZE): Promise<Buffer> {
  const { width, height } = size;
  try {
    const meta = await sharp(image).metadata();
    const ratio = (meta.width ?? width) / (meta.height ?? height);
    if (Math.abs(Math.log(ratio / (width / height))) < 0.25) {
      return await sharp(image).resize(width, height, { fit: "cover", position: "centre" }).png().toBuffer();
    }
    const back = await sharp(image).resize(width, height, { fit: "cover" }).blur(30).modulate({ brightness: 0.7 }).toBuffer();
    const front = await sharp(image).resize(width, height, { fit: "inside" }).toBuffer();
    return await sharp(back).composite([{ input: front, gravity: "centre" }]).png().toBuffer();
  } catch {
    // Not an image sharp can read (test stubs); letter it as it is.
    return image;
  }
}

/** Paper card for a quote: the headline in a band on top, the lettered panel framed below. Same size as the panel. */
export function headlineCard(panel: Buffer, size: { width: number; height: number }, headline: string): string {
  const { width: W, height: H } = size;
  const band = Math.round(H * 0.27);
  const margin = Math.round(W * 0.05);
  const ph = H - band - margin;
  const pw = Math.round((ph * W) / H);
  const px = Math.round((W - pw) / 2);
  const text = renderSpeech(headline, { x: margin, y: Math.round(H * 0.03), width: W - 2 * margin, height: band - Math.round(H * 0.05), shape: "rect", draw: false }, {
    fontPath: BOLD_FONT_PATH,
    color: "#1d1d1f",
    maxFontSize: Math.round(W * 0.06),
    minFontSize: Math.round(W * 0.036),
  }).svg;
  const href = `data:image/png;base64,${panel.toString("base64")}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="#f5f3ee"/>` +
    text +
    `<image href="${escapeXml(href)}" xlink:href="${escapeXml(href)}" x="${px}" y="${band}" width="${pw}" height="${ph}"/>` +
    `<rect x="${px}" y="${band}" width="${pw}" height="${ph}" fill="none" stroke="#1d1d1f" stroke-width="${Math.max(3, Math.round(W / 270))}"/>` +
    "</svg>"
  );
}

/** Sets or clears the headline of an existing episode, through the pipeline so approval sees it. Re-run from letter after. */
export function setHeadline(id: string, headline: string | undefined, dir?: string, safety: SafetyPolicy = loadSafety()): EpisodeSpec {
  const ep = readStep<EpisodeSpec>(id, "episode", dir);
  if (!ep) throw new Error(`no episode ${id}`);
  if (headline) {
    const early = ruleCheck([{ where: "headline", text: headline }], safety);
    if (early.length) throw new Error(`headline refused by the safety rules:\n${early.map((i) => `  - ${i.topic} (${i.detail})`).join("\n")}`);
  }
  const next = { ...ep, headline: headline?.trim() || undefined };
  writeStep(id, "episode", next, dir);
  return next;
}

// ── storage ────────────────────────────────────────────────────────────────

export const episodeDir = (id: string, dir = EPISODES_DIR) => join(dir, id);
const file = (id: string, name: string, dir?: string) => join(episodeDir(id, dir), `${name}.json`);

export function readStep<T>(id: string, step: string, dir?: string): T | undefined {
  const f = file(id, step, dir);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : undefined;
}

function writeStep(id: string, step: string, value: unknown, dir?: string): void {
  mkdirSync(episodeDir(id, dir), { recursive: true });
  const text = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(file(id, step, dir), text);
  logProvenance(episodeDir(id, dir), { event: step, sha256: sha256(text) });
}

export function createEpisode(spec: Omit<EpisodeSpec, "createdAt">, dir?: string, safety: SafetyPolicy = loadSafety()): EpisodeSpec {
  if (!/^[a-z0-9-]+$/.test(spec.id)) throw new Error("episode id: lowercase letters, digits and dashes only");
  // Cheap early stop: an injected or banned direction never reaches the writer. The safety step checks it all again.
  const early = ruleCheck([{ where: "direction", text: spec.direction }, ...(spec.headline ? [{ where: "headline", text: spec.headline }] : []), ...spec.credits.flatMap((c, i) => [{ where: `credit ${i + 1}`, text: `${c.name}: ${c.comment}` }])], safety);
  if (early.length) throw new Error(`episode ${spec.id} refused by the safety rules:\n${early.map((i) => `  - ${i.where}: ${i.topic} (${i.detail})`).join("\n")}`);
  if (existsSync(file(spec.id, "episode", dir))) throw new Error(`episode ${spec.id} already exists`);
  if (spec.format && !EPISODE_FORMATS.includes(spec.format)) throw new Error(`format must be one of ${EPISODE_FORMATS.join(", ")}`);
  const full = { ...spec, characters: [...new Set([spec.lead, ...spec.characters])], source: spec.source ?? { kind: "manual" as const, by: whoAmI() }, createdAt: new Date().toISOString() };
  mkdirSync(episodeDir(spec.id, dir), { recursive: true });
  logProvenance(episodeDir(spec.id, dir), { event: "created", by: full.source.by, source: full.source, detail: full.direction });
  writeStep(spec.id, "episode", full, dir);
  return full;
}

export function listEpisodes(dir = EPISODES_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "episode.json")))
    .map((d) => d.name)
    .sort();
}

/** Steps already saved, in pipeline order. */
export function doneSteps(id: string, dir?: string): EpisodeStep[] {
  return EPISODE_STEPS.filter((s) => existsSync(file(id, s, dir)));
}

// ── prompts ────────────────────────────────────────────────────────────────

function castBrief(ctx: StudioContext, slugs: string[]): string {
  return JSON.stringify(
    slugs.map((s) => {
      const p = ctx.profiles.get(s)!;
      return {
        slug: p.slug,
        // The episode is written in Vietnamese, so it uses the Vietnamese name; the English one is kept for reference.
        name: nameVi(p),
        global_name: p.name,
        species: p.species,
        office_type: p.office_type,
        core_gag: p.core_gag,
        want: p.want,
        fear: p.fear,
        contradiction: p.contradiction,
        edge: p.edge,
        life: p.life,
        comic_engine: p.comic_engine,
        relationships: p.relationships?.filter((r) => slugs.includes(r.with)),
        personality: p.personality,
        voice: p.voice,
        never_says: p.never_says,
        expressions: Object.keys(p.look.expressions),
        recent_memory: p.memory.episodes.slice(-5),
      };
    }),
  );
}

/** Canon picked for this episode: cast, direction, season act, story so far, open threads. */
function seriesBrief(ctx: StudioContext, ep: EpisodeSpec): string {
  const dir = ctx.seriesDir ?? SERIES_DIR;
  const memory = loadMemorySync(dir);
  return storyBrief(ctx.bible, ep.characters, { memory, plan: loadSeason(dir), direction: ep.direction, episodeNumber: episodeNumber(ep.id, memory) });
}

/** Lets @hoi-sau/story ask Muse Spark through the Studio client, with a strict schema. */
function sparkAsLlm(spark: MuseSpark, name: string, schema: Record<string, unknown>): Llm {
  return {
    model: spark.model,
    complete: async (req) => ({
      text: JSON.stringify(await spark.json(name, schema, [{ role: "system", content: req.system }, { role: "user", content: req.user }])),
    }),
  };
}

function writerMessages(ctx: StudioContext, ep: EpisodeSpec, task: string, earlier: Record<string, unknown>): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are the head writer of a daily Vietnamese office-comedy comic. Write all story text in natural Vietnamese that young office workers use. Characters tease each other and have flaws, but never insult anyone.",
        WRITER_GUIDE,
        `Series bible: ${seriesBrief(ctx, ep)}`,
        `Cast for this episode: ${castBrief(ctx, ep.characters)}`,
        "Use only the cast slugs given above in character and speaker fields.",
        namesRule(ctx),
        BANNED_RULE(safetyOf(ctx)),
        AUDIENCE_DATA_RULE,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
    {
      role: "user",
      content: [`Episode ${ep.id}. Lead: ${ep.lead}. Direction from the audience: ${ep.direction}`, ep.credits.length ? `Credit these commenters: ${JSON.stringify(ep.credits)}` : "", ...Object.entries(earlier).map(([k, v]) => `${k}: ${JSON.stringify(v)}`), task]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
}

/** The bible and notes may use the global names; Vietnamese text always uses the Vietnamese ones. */
function namesRule(ctx: StudioContext): string {
  const pairs = [...ctx.profiles.values()].filter((p) => nameVi(p) !== p.name).map((p) => `${p.name} → ${nameVi(p)}`);
  return pairs.length ? `Names: in every Vietnamese text (titles, captions, dialogue) call the characters by their Vietnamese names: ${pairs.join(", ")}. The other names in the bible and notes are the same characters.` : "";
}

const safetyOf = (ctx: StudioContext) => (ctx.safety ??= loadSafety(ctx.seriesDir ?? SERIES_DIR));

/** Every text the episode carries, from the audience's direction to each line of dialogue. */
export function episodeTexts(id: string, dir?: string): EpisodeText[] {
  const ep = readStep<EpisodeSpec>(id, "episode", dir);
  const premise = readStep<Premise>(id, "premise", dir);
  const beats = readStep<Beats>(id, "beats", dir);
  const script = readStep<Script>(id, "script", dir);
  const out: EpisodeText[] = [];
  const add = (where: string, text: string | undefined | null) => text?.trim() && out.push({ where, text });
  add("direction", ep?.direction);
  add("headline", ep?.headline);
  ep?.credits.forEach((c, i) => (add(`credit ${i + 1} name`, c.name), add(`credit ${i + 1} comment`, c.comment)));
  if (premise) {
    for (const k of ["title", "logline", "setup", "twist", "hook", "trigger"] as const) add(`premise.${k}`, premise[k]);
    if (premise.cameo) (add("cameo name", premise.cameo.name), add("cameo look", premise.cameo.description));
  }
  beats?.beats.forEach((b, i) => add(`beat ${i + 1}`, b.what_happens));
  add("script title", script?.title);
  script?.panels.forEach((p, i) => {
    add(`panel ${i + 1} setting`, p.setting);
    add(`panel ${i + 1} action`, p.action);
    p.dialogue.forEach((d, j) => add(`panel ${i + 1} line ${j + 1} (${d.speaker})`, d.text));
  });
  return out;
}

/** Hash of the texts the safety step judged, to notice edits made after it. */
export const textsHash = (texts: EpisodeText[]) => sha256(JSON.stringify(texts));

export type SafetyRecord = SafetyVerdict & { textsHash: string };

// ── schemas ────────────────────────────────────────────────────────────────

const premiseSchema = S.obj({
  title: S.str("Vietnamese, under 8 words"),
  logline: S.str("Vietnamese, one sentence"),
  setup: S.str(),
  twist: S.str(),
  hook: S.str("Vietnamese, the question that makes people comment"),
  trigger: S.str("Vietnamese, the real office moment readers will recognise from their own day, e.g. 'tin nhắn \"em ơi\" lúc 22h'"),
  cameo: { anyOf: [S.obj({ name: S.str(), description: S.str("English, how to draw them as an animal coworker") }), { type: "null" }] },
});

type Range = { min: number; max: number };

const beatsSchema = (n: Range) =>
  S.obj({
    beats: S.arr(S.obj({ purpose: S.enum(["setup", "escalation", "twist", "punchline", "hook"]), what_happens: S.str("Vietnamese") }), n.min, n.max),
  });

const scriptSchema = (n: Range) =>
  S.obj({
    title: S.str(),
    panels: S.arr(
      S.obj({
        beat: S.int("index into beats, from 0"),
        setting: S.str("Vietnamese, a place from the bible"),
        characters: S.arr(S.str("cast slug"), 1, 3),
        action: S.str("Vietnamese, what we see. The joke should read from the picture alone."),
        expressions: S.arr(S.obj({ character: S.str(), expression: S.str("a key from that character's expressions") }), 0, 3),
        dialogue: S.arr(
          S.obj({
            speaker: S.str("cast slug"),
            text: S.str("Vietnamese, at most 12 words. Avoid calling characters by name."),
            kind: S.enum(BUBBLE_KINDS, "speech: said aloud. thought: only in their head. shout: loud, short. whisper: quiet aside."),
          }),
          0,
          2,
        ),
      }),
      n.min,
      n.max,
    ),
  });

const storyboardSchema = (n: Range) =>
  S.obj({
    panels: S.arr(
      S.obj({
        shot: S.enum(["wide", "medium", "close-up", "extreme close-up"]),
        angle: S.enum(["eye level", "high angle", "low angle"]),
        composition: S.str("English, one or two sentences for the illustrator: setting, poses, props, what draws the eye. Lighting fits the scene and stays cheerful: daytime by default; evening or night only when the story needs it, then warm and lively, never gloomy. Tension comes from poses and faces, not lighting. Push the acting to cartoon extremes: squash and stretch, extreme faces, big dynamic poses, drawn comic effects (sweat drops, motion lines, shock lines, steam). Name one muted background tone for the panel's mood (e.g. sage green, warm beige, night navy) and only one or two props that tell the story; background coworkers only when the joke needs them, small and far back. Leave soft, simple background (wall, window, ceiling) in the top third for dialogue. Never a thought cloud or speech bubble: thoughts and lines are lettered later."),
        staging: S.arr(S.obj({ character: S.str("cast slug"), position: S.enum(["left", "center", "right"]) }), 1, 3),
      }),
      n.min,
      n.max,
    ),
  });

const reviewSchema = S.obj({
  pass: S.bool(),
  issues: S.arr(S.obj({ character: S.str(), feature: S.str("which signature feature"), problem: S.str() })),
  fix: S.str("English edit instruction naming only what to change, or empty if pass"),
  heads: S.arr(S.obj({ character: S.str("cast slug"), x: S.num("head centre, share of panel width 0-1"), y: S.num("head centre, share of panel height 0-1") })),
  counts: S.arr(S.obj({ character: S.str("cast slug"), count: S.num("how many times this character is drawn in the panel") })),
});

const canonSchema = S.obj({
  facts: S.arr(S.obj({ fact: S.str("Vietnamese, one established fact later episodes must respect"), characters: S.arr(S.str("cast slug"), 1) }), 0, 5),
});

// ── steps ──────────────────────────────────────────────────────────────────

/** Keep the model's output inside the cast and the bible's limits. */
function sanitizeScript(script: Script, ep: EpisodeSpec, bible: SeriesBible): Script {
  const cast = new Set(ep.characters);
  const fix = (s: string) => (cast.has(s) ? s : ep.lead);
  const panels = script.panels.slice(0, panelRange(ep, bible).max).map((p) => ({
    ...p,
    characters: [...new Set(p.characters.map(fix))],
    expressions: p.expressions.filter((e) => cast.has(e.character)),
    dialogue: p.dialogue.slice(0, 2).map((d) => ({ speaker: fix(d.speaker), text: d.text.trim(), kind: BUBBLE_KINDS.includes(d.kind!) ? d.kind : "speech" })),
  }));
  return { ...script, panels };
}

function sanitizeBoard(board: Storyboard, script: Script): Storyboard {
  const panels = script.panels.map((sp, i) => {
    const b = board.panels[i] ?? { shot: "medium", angle: "eye level", composition: sp.action, staging: [] };
    // Every character in the script panel needs a place on stage, and only them.
    const placed = b.staging.filter((s) => sp.characters.includes(s.character));
    const free: Position[] = (["left", "right", "center"] as Position[]).filter((p) => !placed.some((s) => s.position === p));
    for (const c of sp.characters) if (!placed.some((s) => s.character === c)) placed.push({ character: c, position: free.shift() ?? "center" });
    return { ...b, staging: placed };
  });
  return { panels };
}

function sheetImage(ctx: StudioContext, slug: string, name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  const f = join(ctx.charactersDir ?? CHARACTERS_DIR, slug, name);
  if (!existsSync(f)) return undefined;
  const data = readFileSync(f);
  return `data:${imageSize(data).mime};base64,${data.toString("base64")}`;
}

function modelSheet(ctx: StudioContext, slug: string): string | undefined {
  return sheetImage(ctx, slug, ctx.profiles.get(slug)?.look.character_sheet);
}

/** Model sheet, then pose sheet when one is locked. */
export function characterRefs(ctx: StudioContext, slug: string): string[] {
  const p = ctx.profiles.get(slug);
  return [modelSheet(ctx, slug), sheetImage(ctx, slug, p?.look.pose_sheet)].filter((x): x is string => Boolean(x));
}

/** The style sentence every panel gets: the series style when set, else the lead's own. */
export function panelStyle(ctx: StudioContext, ep: EpisodeSpec): string {
  return ctx.style ? styleText(ctx.style) : ctx.profiles.get(ep.lead)!.look.style;
}

export function episodePanelPrompt(ctx: StudioContext, ep: EpisodeSpec, sp: ScriptPanel, bp: BoardPanel, cameo: Premise["cameo"]): string {
  const who = bp.staging
    .map((s) => {
      const p = ctx.profiles.get(s.character)!;
      const expr = sp.expressions.find((e) => e.character === s.character)?.expression ?? "default";
      return `${p.name} (${p.species}) on the ${s.position}, ${p.look.expressions[expr] ?? p.look.expressions.default}; keep exactly: ${p.look.signature.join("; ")}. ${iconLine(p)}`.trim();
    })
    .join(" ");
  const style = panelStyle(ctx, ep).trim().replace(/\.?$/, ".");
  return [
    `${bp.shot} shot, ${bp.angle}. ${bp.composition}`,
    who,
    cameo && sp.action.includes(cameo.name) ? `Also a coworker: ${cameo.description}.` : "",
    ctx.office ? officePanelText(ctx.office, bp.staging.map((st) => st.character)) : "",
    `Match the character sheets and pose sheets exactly. Single comic panel. Style: ${style} Cheerful lighting that fits the scene (daytime unless the composition says otherwise), never gloomy. Soft airbrushed shading on the characters; the background is one muted tone, simpler and softer than the characters. The scene fills the whole panel edge to edge; the top third shows soft, simple background (wall, window, ceiling) with no busy detail, ready for dialogue added later, never a blank band or a separate strip of plain colour, and keep every character away from the very top and bottom edges (the panel is trimmed slightly there). No text, no letters, no speech bubbles, no thought clouds, no captions. Drawn comic effects are welcome as pictures: sweat drops, motion lines, shock lines, anger veins, steam puffs, sparkles. Exaggerated cartoon acting with squash and stretch and extreme faces.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Dialogue size as a share of panel width, for reading on a phone. */
export const PHONE_FONT = 0.044;
export const PHONE_MIN_FONT = 0.036;

/** The review may name a character by slug, display name or Vietnamese name; letter matches by slug. */
export function slugFor(ctx: StudioContext, who: string): string {
  const k = who.trim().toLowerCase();
  for (const p of ctx.profiles.values()) if ([p.slug, p.name, nameVi(p)].some((n) => n?.toLowerCase() === k)) return p.slug;
  return who;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5));

/** Roughly where a speaker's head is, from staging and shot. Coordinates as shares of the panel. */
function headAt(bp: BoardPanel, pos: Position): { x: number; y: number } {
  const X: Record<Position, number> = { left: 0.27, center: 0.5, right: 0.73 };
  const y = bp.shot === "wide" ? 0.5 : bp.shot === "medium" ? 0.42 : 0.36;
  return { x: X[pos], y };
}

/**
 * Bubbles from staging. Each is sized to its words, sits in the calm top of
 * the panel above its speaker, and aims a short tail (or a trail of puffs for
 * a thought) at the speaker's head. A second line reads after the first:
 * lower, and on its own side when the speakers stand apart. Coordinates in px.
 */
export function bubbleLayout(sp: ScriptPanel, bp: BoardPanel, width: number, height: number, heads: PanelReview["heads"] = []): DialogueLine[] {
  const margin = width * 0.035;
  // A feed image is about 390 pt wide on a phone. 4.4% of the width is about
  // 17 pt there; below 3.6% (14 pt) a line counts as overflow so review flags it.
  const fontSize = Math.round(width * PHONE_FONT);
  const minFontSize = Math.round(width * PHONE_MIN_FONT);
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
  return sp.dialogue.map((d, i) => {
    const kind = d.kind ?? "speech";
    const pos = bp.staging.find((s) => s.character === d.speaker)?.position ?? "center";
    const seen = heads.find((h) => h.character === d.speaker);
    const head = seen ? { x: clamp01(seen.x), y: clamp01(seen.y) } : headAt(bp, pos);
    const two = sp.dialogue.length > 1;
    // Speakers on opposite sides each keep a bubble on their own side, narrower so both fit.
    const sides = sp.dialogue.map((o) => bp.staging.find((s) => s.character === o.speaker)?.position ?? "center");
    // Two speakers in different spots: the one further left takes the left edge, the other the right.
    // Where the review saw the heads wins over the storyboard's left/centre/right.
    const RANK = { left: 0.27, center: 0.5, right: 0.73 } as const;
    const xOf = (j: number) => heads.find((h) => h.character === sp.dialogue[j].speaker)?.x ?? RANK[sides[j]];
    const j = i === 0 ? 1 : 0;
    const apart = two && sp.dialogue[j] !== undefined && sp.dialogue[j].speaker !== d.speaker && Math.abs(xOf(i) - xOf(j)) > 0.12;
    const leftSide = apart && xOf(i) < xOf(j);
    // Bangers is condensed, so shouts get a larger size to read as loud.
    const size = kind === "shout" ? Math.round(fontSize * 1.25) : fontSize;
    const { width: w, height: h } = snugBubble(d.text, kind, { fontSize: size, maxWidth: width * (apart ? 0.44 : two ? 0.52 : 0.62) });
    // Lean towards the reading order: the first of two sits left of its speaker, the second right.
    const lean = two ? (i === 0 ? -0.06 : 0.06) : 0;
    let x = apart ? (leftSide ? margin : width - margin - w) : Math.min(Math.max((head.x + lean) * width - w / 2, margin), width - margin - w);
    let y = height * 0.03 + (two && i > 0 ? height * 0.05 : 0);
    const prev = placed[i - 1];
    if (prev && x < prev.x + prev.w + margin * 0.5 && prev.x < x + w + margin * 0.5) {
      // They would touch: hang the second below the first, nudged aside.
      y = prev.y + prev.h * 0.82;
      if (!apart) x = Math.min(Math.max(prev.x + prev.w * 0.35, margin), width - margin - w);
    }
    placed.push({ x, y, w, h });
    const aim = { x: head.x * width, y: Math.max(head.y * height, y + h + height * 0.04) };
    return { speaker: d.speaker, text: d.text, bubble: { x, y, width: w, height: h, kind, draw: true, tail: aim }, options: { maxFontSize: size, minFontSize, strokeWidth: Math.max(3, width / 300) } };
  });
}

export async function runStep(ctx: StudioContext, id: string, step: EpisodeStep): Promise<void> {
  const dir = ctx.dir;
  const log = ctx.log ?? (() => {});
  const ep = readStep<EpisodeSpec>(id, "episode", dir);
  if (!ep) throw new Error(`no episode ${id}`);
  for (const c of ep.characters) if (!ctx.profiles.has(c)) throw new Error(`unknown character ${c}`);
  const need = <T>(s: EpisodeStep): T => {
    const v = readStep<T>(id, s, dir);
    if (!v) throw new Error(`step ${s} has not run for ${id}`);
    return v;
  };
  log(`${id}: ${step}`);

  switch (step) {
    case "premise": {
      const premise = await ctx.spark.json<Premise>("premise", premiseSchema, writerMessages(ctx, ep, "Write the premise for this episode. Build it around one trigger: a real office moment readers will recognise from their own day. The comedy should come from the situation and the characters' bodies, not from wordplay. If a credited commenter fits, give them a cameo as an animal coworker.", {}));
      return writeStep(id, "premise", premise, dir);
    }
    case "beats": {
      const n = panelRange(ep, ctx.bible);
      const task =
        ep.format === "single"
          ? 'Make it exactly 1 beat (purpose "punchline"): one picture that holds the whole joke. The everyday trigger is visible in the scene itself and the twist lands at a glance, from the drawing first and at most two short lines.'
          : ep.format === "strip3"
          ? 'Break it into exactly 3 beats, the rule of three: beat 1 sets up the everyday trigger, beat 2 repeats the pattern one step worse, beat 3 is the twist (purpose "punchline") and must land from the drawing alone. Each panel is posted as its own swipeable image.'
          : `Break it into ${n.min}–${n.max} beats. Last beat is the hook for "hồi sau".`;
      const beats = await ctx.spark.json<Beats>("beats", beatsSchema(n), writerMessages(ctx, ep, task, { premise: need("premise") }));
      return writeStep(id, "beats", beats, dir);
    }
    case "script": {
      const raw = await ctx.spark.json<Script>(
        "script",
        scriptSchema(panelRange(ep, ctx.bible)),
        writerMessages(ctx, ep, (ep.headline ? `A headline band above the panel already reads: "${ep.headline}". The picture illustrates it; the bubbles must not repeat or explain it, they add the punch. ` : "") + (ep.format === "single" ? "Write the script for one single panel that tells the whole joke: the setting shows the trigger, the characters' poses and faces show the twist, and at most two short bubbles (12 words each) finish it. Write everyday spoken Northern (Hà Nội) Vietnamese: blunt, clipped, colloquial. The last bubble is the punchline and must land on its own; never explain the joke or state its moral. Keep dialogue in each character's voice, never breaking their never_says rules. Characters rarely call each other by name." : "Write the panel script: one panel per beat. Let the pictures carry the joke: at least one panel has no dialogue, and the punchline must read from the drawing alone. Write everyday spoken Northern (Hà Nội) Vietnamese: blunt, clipped, colloquial; never explain the joke or state its moral. Keep dialogue short and in each character's voice, never breaking their never_says rules. Characters rarely call each other by name."), { premise: need("premise"), beats: need("beats") }),
      );
      return writeStep(id, "script", sanitizeScript(raw, ep, ctx.bible), dir);
    }
    case "safety": {
      const texts = episodeTexts(id, dir);
      const cast = ep.characters.map((c) => ctx.profiles.get(c)!);
      const llm: Llm = { model: ctx.spark.model, complete: async (req) => ({ text: JSON.stringify(await ctx.spark.json("safety", SAFETY_SCHEMA, [{ role: "system", content: req.system }, { role: "user", content: req.user }])) }) };
      const verdict = await gateEpisode(llm, texts, safetyOf(ctx), cast);
      writeStep(id, "safety", { ...verdict, textsHash: textsHash(texts) } satisfies SafetyRecord, dir);
      if (!verdict.pass) throw new SafetyError(id, verdict);
      return;
    }
    case "storyboard": {
      // Nothing is drawn unless the safety gate passed on the text as it is now.
      const gate = need<SafetyRecord>("safety");
      if (!gate.pass) throw new SafetyError(id, gate);
      if (gate.textsHash !== textsHash(episodeTexts(id, dir))) throw new Error(`${id}: the story changed after the safety check; rerun with --from safety`);
      const script = need<Script>("script");
      const raw = await ctx.spark.json<Storyboard>(
        "storyboard",
        storyboardSchema(panelRange(ep, ctx.bible)),
        writerMessages(
          ctx,
          ep,
          "Storyboard every script panel: shot size, angle, composition for the illustrator, and where each character stands. Vary shots; end on a close-up when it lands the joke. Follow the office floor plan: characters at their desks sit in their own seats, and the windows, meeting room and pantry stay where the plan puts them.",
          ctx.office ? { script, office: officeBrief(ctx.office) } : { script },
        ),
      );
      return writeStep(id, "storyboard", sanitizeBoard(raw, script), dir);
    }
    case "panels": {
      const script = need<Script>("script");
      const board = need<Storyboard>("storyboard");
      const premise = need<Premise>("premise");
      const out = join(episodeDir(id, dir), "panels");
      mkdirSync(out, { recursive: true });
      const renders: PanelRender[] = [];
      const attached = new Set<string>();
      let previous: string | undefined;
      // The series style render goes with the first panel; later panels chain from it.
      const styleRef = styleReference(ctx.style, ctx.seriesDir ?? SERIES_DIR);
      for (const [i, sp] of script.panels.entries()) {
        const bp = board.panels[i];
        // Attach each character's locked sheets the first time they appear; later
        // panels chain from earlier ones, so the server already holds them.
        const refs = bp.staging.map((s) => s.character).filter((c) => !attached.has(c)).flatMap((c) => {
          const sheets = characterRefs(ctx, c);
          if (sheets.length) attached.add(c);
          return sheets;
        });
        if (i === 0 && styleRef) refs.unshift(styleRef);
        const prompt = episodePanelPrompt(ctx, ep, sp, bp, premise.cameo);
        log(`${id}: panel ${i + 1}${refs.length ? ` (+${refs.length} reference)` : ""}`);
        const res = await generateSoftly(ctx.image, { prompt, size: panelSize(ep, i + 1), previousResponseId: previous, references: refs }, (m) => log(`${id}: panel ${i + 1}: ${m}`));
        const name = `panel-${i + 1}.${imageSize(res.image).mime.split("/")[1]}`;
        writeFileSync(join(out, name), res.image);
        renders.push({ n: i + 1, file: `panels/${name}`, responseId: res.id, prompt, history: [] });
        previous = res.id;
      }
      return writeStep(id, "panels", { renders }, dir);
    }
    case "review": {
      const script = need<Script>("script");
      const { renders } = need<{ renders: PanelRender[] }>("panels");
      const board = readStep<Storyboard>(id, "storyboard", dir);
      const reviews: PanelReview[] = [];
      for (const r of renders) {
        let current = r;
        const numbers = storyNumbers(`${script.panels[r.n - 1].action} ${board?.panels[r.n - 1]?.composition ?? ""}`);
        let verdict = await reviewPanel(ctx, ep, script.panels[r.n - 1], current, dir, numbers);
        let redrawn = false;
        for (let attempt = 0; !verdict.pass && attempt < (ctx.maxRedraws ?? 1) + (isDuplicate(verdict) ? 1 : 0); attempt++) {
          log(`${id}: redraw panel ${r.n}: ${verdict.fix}`);
          const res = await generateSoftly(ctx.image, {
            prompt: `Edit this panel. Change only this: ${verdict.fix}. Keep everything else exactly the same: composition, background, other characters, colours. ${numbers.length ? `No text, except keep the number ${numbers.join(", ")} on its prop as drawn.` : "No text."}`,
            previousResponseId: current.responseId,
            size: panelSize(ep, r.n),
          });
          const name = `panel-${r.n}-fix${attempt + 1}.${imageSize(res.image).mime.split("/")[1]}`;
          writeFileSync(join(episodeDir(id, dir), "panels", name), res.image);
          current = { ...current, history: [...current.history, current.file], file: `panels/${name}`, responseId: res.id };
          redrawn = true;
          verdict = await reviewPanel(ctx, ep, script.panels[r.n - 1], current, dir);
        }
        Object.assign(r, current);
        reviews.push({ n: r.n, ...verdict, redrawn });
      }
      writeStep(id, "panels", { renders }, dir);
      return writeStep(id, "review", { reviews }, dir);
    }
    case "letter": {
      const script = need<Script>("script");
      const board = need<Storyboard>("storyboard");
      const { renders } = need<{ renders: PanelRender[] }>("panels");
      const out = join(episodeDir(id, dir), "final");
      mkdirSync(out, { recursive: true });
      const pages: Array<{ n: number; file: string; overflow: number }> = [];
      for (const r of renders) {
        let drawn: Buffer = readFileSync(join(episodeDir(id, dir), r.file));
        if (ctx.recolour) {
          // Kept beside the panel, so lettering again does not pay for another recolour.
          const recoloured = join(episodeDir(id, dir), "panels", `panel-${r.n}-recoloured.png`);
          if (!existsSync(recoloured)) {
            log(`${id}: recolour panel ${r.n}`);
            writeFileSync(recoloured, (await recolourPanel(ctx.image, drawn, panelSize(ep, r.n), (m) => log(`${id}: recolour ${r.n}: ${m}`))).image);
          }
          drawn = readFileSync(recoloured);
        }
        if (ctx.segmenter) {
          const cast = board.panels[r.n - 1].staging.map((s) => ctx.profiles.get(s.character)).filter((p): p is Profile => !!p);
          drawn = (await finishPanel(drawn, ctx.segmenter, { characters: cast, log })).image;
          writeFileSync(join(episodeDir(id, dir), "panels", `panel-${r.n}-finished.png`), drawn);
        }
        const data = await fitPost(drawn);
        const size = imageSize(data);
        const heads = readStep<{ reviews: PanelReview[] }>(id, "review", dir)?.reviews.find((v) => v.n === r.n)?.heads?.map((h) => ({ ...h, character: slugFor(ctx, h.character) }));
        const lines = bubbleLayout(script.panels[r.n - 1], board.panels[r.n - 1], size.width, size.height, heads);
        const { svg, overflow } = composePanel({ data, ...size }, lines);
        const name = `${String(r.n).padStart(2, "0")}.png`;
        const png = svgToPng(svg);
        writeFileSync(join(out, name), ep.headline && r.n === 1 ? svgToPng(headlineCard(png, size, ep.headline)) : png);
        writeFileSync(join(out, `${String(r.n).padStart(2, "0")}.svg`), svg);
        pages.push({ n: r.n, file: `final/${name}`, overflow: overflow.length });
      }
      return writeStep(id, "letter", { pages }, dir);
    }
    case "canon": {
      const { facts } = await ctx.spark.json<{ facts: Array<{ fact: string; characters: string[] }> }>(
        "canon",
        canonSchema,
        writerMessages(ctx, ep, "List the facts this episode establishes that later episodes must respect (relationships, events, objects, running jokes). Skip anything trivial.", { script: need("script") }),
      );
      const canon: CanonFact[] = facts.map((f) => ({ episode: id, fact: f.fact, characters: f.characters.filter((c) => ep.characters.includes(c)) }));
      const bible = addCanon(ctx.bible, canon);
      ctx.bible = bible;
      ctx.saveBible?.(bible);
      for (const c of ep.characters) {
        const mine = canon.filter((f) => f.characters.includes(c)).map((f) => f.fact);
        ctx.saveMemory?.(c, mine, id);
      }
      // Story memory: summary, how it ended, threads opened and answered, gags, cameos.
      const seriesDir = ctx.seriesDir ?? SERIES_DIR;
      const memory = loadMemorySync(seriesDir);
      const recalled = await recap(sparkAsLlm(ctx.spark, "recap", RECAP_SCHEMA), readEpisodeFiles(dir ?? EPISODES_DIR, id), memory, loadSeason(seriesDir), episodeNumber(id, memory));
      await saveMemory(remember(memory, recalled), seriesDir);
      return writeStep(id, "canon", { facts: canon }, dir);
    }
  }
}

/**
 * Numbers the story needs drawn on a prop ("a queue ticket with 02"): the
 * review lets them through and redraws keep them, so the joke is not erased.
 */
export const storyNumbers = (text: string): string[] => [...new Set(text.match(/(?<![\d.,:%])\d{1,4}(?![\d.,:%])/g) ?? [])];

async function reviewPanel(ctx: StudioContext, ep: EpisodeSpec, sp: ScriptPanel, r: PanelRender, dir?: string, numbers: string[] = []): Promise<Omit<PanelReview, "n" | "redrawn">> {
  const data = readFileSync(join(episodeDir(ep.id, dir), r.file));
  const content: ChatMessage["content"] = [
    {
      type: "text",
      text: [
        "You check comic panels for character consistency and safety before publishing.",
        `The panel should show: ${sp.action}`,
        ...sp.characters.map((c) => {
          const p = ctx.profiles.get(c)!;
          return `${p.name} must have: ${p.look.signature.join("; ")}.${p.look.icon ? ` Its identifying item must be clearly visible: ${p.look.icon}.` : ""} Palette: ${p.look.palette.map((s) => s.hex).join(", ")}.`;
        }),
        "Fail the panel if a signature feature is wrong or missing, a character is off-model, there is drawn text, a speech bubble or a thought cloud, a human figure anywhere (every coworker is an animal), or anything unsafe. The first image is the panel; any others are the locked model sheets.",
        numbers.length ? `The story needs the number ${numbers.join(", ")} drawn on a prop: that is not drawn text, keep it.` : "",
        "Count every cast character: each one must be drawn exactly once. Fail the panel if any of them appears twice or more (for example a second copy in the foreground or background).",
        "Check anatomy: every character has exactly two arms and two hands, and each held object appears once. Fail the panel for an extra arm or hand, a hand coming from nowhere, or the same prop held twice, and name in the fix which hand to erase and where it is.",
        `Also give, for every cast character you can see (by slug: ${sp.characters.map((c) => `${c} = ${ctx.profiles.get(c)!.name}`).join(", ")}), where the centre of their head is in the panel, as shares of its width and height (0 is left or top, 1 is right or bottom). Speech tails will aim there.`,
        `Unsafe means anything on this list, even in the background: ${safetyOf(ctx).topics.map((t) => t.describe).join("; ")}.`,
      ].filter(Boolean).join("\n"),
    },
    { type: "image_url", image_url: { url: `data:${imageSize(data).mime};base64,${data.toString("base64")}` } },
    ...sp.characters.flatMap((c) => {
      const sheet = modelSheet(ctx, c);
      return sheet ? [{ type: "image_url" as const, image_url: { url: sheet } }] : [];
    }),
  ];
  const verdict = await ctx.spark.json<Omit<PanelReview, "n" | "redrawn"> & { counts?: Array<{ character: string; count: number }> }>("review", reviewSchema, [{ role: "user", content }]);
  return withDuplicateCheck(verdict, (c) => ctx.profiles.get(slugFor(ctx, c))?.name ?? c);
}

/** A cast member drawn more than once fails the panel, and the fix says to remove the extra copy. */
export function withDuplicateCheck<
  T extends {
    pass: boolean;
    fix: string;
    issues: Array<{ character: string; feature: string; problem: string }>;
    counts?: Array<{ character: string; count: number }>;
    heads?: Array<{ character: string; x: number; y: number }>;
  },
>(verdict: T, nameOf: (character: string) => string = (c) => c, action = ""): Omit<T, "counts"> {
  const { counts = [], ...rest } = verdict;
  const twice = counts.filter((c) => c.count > 1);
  if (!twice.length) return rest;
  // Where each copy is, from the head positions, so the edit knows which one to erase.
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const remove = twice
    .map((c) => {
      const at = (rest.heads ?? []).filter((h) => h.character === c.character).map((h) => `one with its head about ${pct(h.x)} from the left and ${pct(h.y)} from the top`);
      const where = at.length > 1 ? ` (${at.join("; ")})` : "";
      return `${nameOf(c.character)} is drawn ${c.count} times${where}: keep only the copy doing the scene's action${action ? ` (${action})` : ""} and erase the other${c.count > 2 ? "s" : ""} completely, painting the background over the spot`;
    })
    .join(". ");
  return {
    ...rest,
    pass: false,
    issues: [...rest.issues, ...twice.map((c) => ({ character: c.character, feature: "drawn once", problem: `appears ${c.count} times` }))],
    fix: [remove, rest.fix].filter(Boolean).join(". "),
  };
}

/** A failed review is redrawn up to maxRedraws times; a panel with a cast member drawn twice gets one more try. */
export const isDuplicate = (v: { issues: Array<{ feature: string }> }) => v.issues.some((i) => i.feature === "drawn once");

/** The gate said no. The message lists every issue so the editor can fix the direction or the script. */
export class SafetyError extends Error {
  constructor(
    readonly episodeId: string,
    readonly verdict: SafetyVerdict,
  ) {
    super(`${episodeId}: stopped by the safety check:\n${verdict.issues.map((i) => `  - ${i.where}: ${i.topic} (${i.by}) ${i.detail}`).join("\n")}`);
  }
}

/** Run from `from` (default: first step not yet saved) to the end. */
export async function runEpisode(ctx: StudioContext, id: string, opts: { from?: EpisodeStep; to?: EpisodeStep } = {}): Promise<EpisodeStep[]> {
  const done = doneSteps(id, ctx.dir);
  const start = opts.from ? EPISODE_STEPS.indexOf(opts.from) : EPISODE_STEPS.findIndex((s) => !done.includes(s));
  if (start < 0) return [];
  // An episode drawn before the gate existed: check it without redrawing anything.
  if (!opts.from && EPISODE_STEPS[start] === "safety" && done.includes("storyboard")) {
    await runStep(ctx, id, "safety");
    return ["safety", ...(await runEpisode(ctx, id, opts))];
  }
  const end = opts.to ? EPISODE_STEPS.indexOf(opts.to) : EPISODE_STEPS.length - 1;
  const ran: EpisodeStep[] = [];
  for (const step of EPISODE_STEPS.slice(start, end + 1)) {
    await runStep(ctx, id, step);
    ran.push(step);
  }
  return ran;
}
