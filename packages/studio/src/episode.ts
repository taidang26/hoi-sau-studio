/**
 * One episode, step by step, each step saved to episodes/<id>/<step>.json:
 *
 *   premise → beats → script → storyboard → panels → review → letter → canon
 *
 * A step reads only what earlier steps saved, so any step can be rerun alone
 * (`--from script` reruns script and everything after it). Writing steps use
 * Muse Spark with a JSON schema; drawing uses Muse Image with each
 * character's locked model sheet as a reference; self-review uses Muse Spark
 * vision against the same sheet and asks Muse Image to fix only what is wrong.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { BUBBLE_KINDS, composePanel, imageSize, snugBubble, svgToPng, type BubbleKind, type DialogueLine } from "@hoi-sau/svg-text";
import {
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
import { CHARACTERS_DIR, type Profile } from "./profile.js";
import { iconLine } from "./prompts.js";
import { type SeriesStyle, styleReference, styleText } from "./style.js";
import { officeBrief, officePanelText, type Office } from "./office.js";

export const EPISODES_DIR = fileURLToPath(new URL("../../../episodes", import.meta.url));

export const EPISODE_STEPS = ["premise", "beats", "script", "storyboard", "panels", "review", "letter", "canon"] as const;
export type EpisodeStep = (typeof EPISODE_STEPS)[number];

export interface EpisodeSpec {
  id: string;
  lead: string;
  characters: string[];
  /** Where the story goes, usually picked from comments. */
  direction: string;
  /** Commenters to credit; they may appear as coworkers drawn from text only. */
  credits: Array<{ name: string; comment: string }>;
  /** "carousel" (default): 4–6 panels posted one by one. "strip3": exactly three panels, the rule of three, posted one by one too. */
  format?: EpisodeFormat;
  createdAt: string;
}

export const EPISODE_FORMATS = ["carousel", "strip3"] as const;
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
  /** Redraw attempts per failed panel. */
  maxRedraws?: number;
  log?: (s: string) => void;
  saveBible?: (b: SeriesBible) => void;
  saveMemory?: (slug: string, facts: string[], episode: string) => void;
}

const PANEL_SIZE = "1024x1280";

/** How many panels a format takes. */
export function panelRange(ep: Pick<EpisodeSpec, "format">, bible: SeriesBible): { min: number; max: number } {
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

// ── storage ────────────────────────────────────────────────────────────────

export const episodeDir = (id: string, dir = EPISODES_DIR) => join(dir, id);
const file = (id: string, name: string, dir?: string) => join(episodeDir(id, dir), `${name}.json`);

export function readStep<T>(id: string, step: string, dir?: string): T | undefined {
  const f = file(id, step, dir);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : undefined;
}

function writeStep(id: string, step: string, value: unknown, dir?: string): void {
  mkdirSync(episodeDir(id, dir), { recursive: true });
  writeFileSync(file(id, step, dir), JSON.stringify(value, null, 2) + "\n");
}

export function createEpisode(spec: Omit<EpisodeSpec, "createdAt">, dir?: string): EpisodeSpec {
  if (!/^[a-z0-9-]+$/.test(spec.id)) throw new Error("episode id: lowercase letters, digits and dashes only");
  if (existsSync(file(spec.id, "episode", dir))) throw new Error(`episode ${spec.id} already exists`);
  if (spec.format && !EPISODE_FORMATS.includes(spec.format)) throw new Error(`format must be one of ${EPISODE_FORMATS.join(", ")}`);
  const full = { ...spec, characters: [...new Set([spec.lead, ...spec.characters])], createdAt: new Date().toISOString() };
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
        name: p.name,
        species: p.species,
        office_type: p.office_type,
        core_gag: p.core_gag,
        want: p.want,
        fear: p.fear,
        contradiction: p.contradiction,
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
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [`Episode ${ep.id}. Lead: ${ep.lead}. Direction from the audience: ${ep.direction}`, ep.credits.length ? `Credit these commenters: ${JSON.stringify(ep.credits)}` : "", ...Object.entries(earlier).map(([k, v]) => `${k}: ${JSON.stringify(v)}`), task]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
}

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
        composition: S.str("English, one or two sentences for the illustrator: setting, poses, props, what draws the eye. Lighting fits the scene and stays cheerful: daytime by default; evening or night only when the story needs it, then warm and lively, never gloomy. Tension comes from poses and faces, not lighting. Leave soft, simple background (wall, window, ceiling) in the top third for dialogue. Never a thought cloud or speech bubble: thoughts and lines are lettered later."),
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
    `Match the character sheets and pose sheets exactly. Single comic panel. Style: ${style} Cheerful lighting that fits the scene (daytime unless the composition says otherwise), never gloomy. The scene fills the whole panel edge to edge; the top third shows soft, simple background (wall, window, ceiling) with no busy detail, ready for dialogue added later, never a blank band or a separate strip of plain colour, and keep every character away from the very top and bottom edges (the panel is trimmed slightly there). No text, no letters, no speech bubbles, no thought clouds, no captions, no symbols floating above heads.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Dialogue size as a share of panel width, for reading on a phone. */
export const PHONE_FONT = 0.044;
export const PHONE_MIN_FONT = 0.036;

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
export function bubbleLayout(sp: ScriptPanel, bp: BoardPanel, width: number, height: number): DialogueLine[] {
  const margin = width * 0.035;
  // A feed image is about 390 pt wide on a phone. 4.4% of the width is about
  // 17 pt there; below 3.6% (14 pt) a line counts as overflow so review flags it.
  const fontSize = Math.round(width * PHONE_FONT);
  const minFontSize = Math.round(width * PHONE_MIN_FONT);
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
  return sp.dialogue.map((d, i) => {
    const kind = d.kind ?? "speech";
    const pos = bp.staging.find((s) => s.character === d.speaker)?.position ?? "center";
    const head = headAt(bp, pos);
    const two = sp.dialogue.length > 1;
    // Bangers is condensed, so shouts get a larger size to read as loud.
    const size = kind === "shout" ? Math.round(fontSize * 1.25) : fontSize;
    const { width: w, height: h } = snugBubble(d.text, kind, { fontSize: size, maxWidth: width * (two ? 0.52 : 0.62) });
    // Lean towards the reading order: the first of two sits left of its speaker, the second right.
    const lean = two ? (i === 0 ? -0.06 : 0.06) : 0;
    let x = Math.min(Math.max((head.x + lean) * width - w / 2, margin), width - margin - w);
    let y = height * 0.03 + (two && i > 0 ? height * 0.05 : 0);
    const prev = placed[i - 1];
    if (prev && x < prev.x + prev.w + margin * 0.5 && prev.x < x + w + margin * 0.5) {
      // They would touch: hang the second below the first, nudged aside.
      y = prev.y + prev.h * 0.82;
      x = Math.min(Math.max(prev.x + prev.w * 0.35, margin), width - margin - w);
    }
    placed.push({ x, y, w, h });
    const aim = { x: head.x * width, y: Math.max(head.y * height, y + h + height * 0.06) };
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
        ep.format === "strip3"
          ? 'Break it into exactly 3 beats, the rule of three: beat 1 sets up the everyday trigger, beat 2 repeats the pattern one step worse, beat 3 is the twist (purpose "punchline") and must land from the drawing alone. Each panel is posted as its own swipeable image.'
          : `Break it into ${n.min}–${n.max} beats. Last beat is the hook for "hồi sau".`;
      const beats = await ctx.spark.json<Beats>("beats", beatsSchema(n), writerMessages(ctx, ep, task, { premise: need("premise") }));
      return writeStep(id, "beats", beats, dir);
    }
    case "script": {
      const raw = await ctx.spark.json<Script>(
        "script",
        scriptSchema(panelRange(ep, ctx.bible)),
        writerMessages(ctx, ep, "Write the panel script: one panel per beat. Let the pictures carry the joke: at least one panel has no dialogue, and the punchline must read from the drawing alone. Keep dialogue short and in each character's voice, never breaking their never_says rules. Characters rarely call each other by name.", { premise: need("premise"), beats: need("beats") }),
      );
      return writeStep(id, "script", sanitizeScript(raw, ep, ctx.bible), dir);
    }
    case "storyboard": {
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
      const reviews: PanelReview[] = [];
      for (const r of renders) {
        let current = r;
        let verdict = await reviewPanel(ctx, ep, script.panels[r.n - 1], current, dir);
        let redrawn = false;
        for (let attempt = 0; !verdict.pass && attempt < (ctx.maxRedraws ?? 1); attempt++) {
          log(`${id}: redraw panel ${r.n}: ${verdict.fix}`);
          const res = await generateSoftly(ctx.image, {
            prompt: `Edit this panel. Change only this: ${verdict.fix}. Keep everything else exactly the same: composition, background, other characters, colours. No text.`,
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
        const data = await fitPost(readFileSync(join(episodeDir(id, dir), r.file)));
        const size = imageSize(data);
        const lines = bubbleLayout(script.panels[r.n - 1], board.panels[r.n - 1], size.width, size.height);
        const { svg, overflow } = composePanel({ data, ...size }, lines);
        const name = `${String(r.n).padStart(2, "0")}.png`;
        writeFileSync(join(out, name), svgToPng(svg));
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

async function reviewPanel(ctx: StudioContext, ep: EpisodeSpec, sp: ScriptPanel, r: PanelRender, dir?: string): Promise<Omit<PanelReview, "n" | "redrawn">> {
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
      ].join("\n"),
    },
    { type: "image_url", image_url: { url: `data:${imageSize(data).mime};base64,${data.toString("base64")}` } },
    ...sp.characters.flatMap((c) => {
      const sheet = modelSheet(ctx, c);
      return sheet ? [{ type: "image_url" as const, image_url: { url: sheet } }] : [];
    }),
  ];
  return ctx.spark.json("review", reviewSchema, [{ role: "user", content }]);
}

/** Run from `from` (default: first step not yet saved) to the end. */
export async function runEpisode(ctx: StudioContext, id: string, opts: { from?: EpisodeStep; to?: EpisodeStep } = {}): Promise<EpisodeStep[]> {
  const done = doneSteps(id, ctx.dir);
  const start = opts.from ? EPISODE_STEPS.indexOf(opts.from) : EPISODE_STEPS.findIndex((s) => !done.includes(s));
  if (start < 0) return [];
  const end = opts.to ? EPISODE_STEPS.indexOf(opts.to) : EPISODE_STEPS.length - 1;
  const ran: EpisodeStep[] = [];
  for (const step of EPISODE_STEPS.slice(start, end + 1)) {
    await runStep(ctx, id, step);
    ran.push(step);
  }
  return ran;
}
