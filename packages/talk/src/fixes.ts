/**
 * Fixing a clip the way the owner would tell a person: one note in plain
 * Vietnamese ("câu đầu là Mẹ không phải Mày", "Rico quay lưng mà có ghim
 * sao", "thiếu tranh cho câu Taeyang"), optionally with the second the video
 * was paused at. Muse Spark reads the note against the plan and small copies
 * of every picture and answers with concrete edits; the dashboard shows them
 * with evidence before anything is changed.
 *
 * Also here: stretches where the voice speaks but no subtitle line covers it
 * (the recogniser missed a line), found from the sound itself.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { S, type ChatMessage, type StudioContext } from "@hoi-sau/studio";
import type { Plan } from "./illustrate.js";
import { voicedRegions } from "./sync.js";
import { RATE } from "./voice.js";

export const FIX_KINDS = ["line_text", "line_time", "add_line", "drop_line", "bubble", "fix_detail", "redraw", "add_shot", "redo_pose", "one_pose", "no_mouth"] as const;
export type FixKind = (typeof FIX_KINDS)[number];

/** One edit. Fields a kind does not use are empty ("" or -1). */
export interface FixAction {
  do: FixKind;
  shot: string;
  line: number;
  text: string;
  start: number;
  end: number;
  /** English instruction for the picture (fix_detail, redraw, add_shot). */
  what: string;
  /** English phrase naming the thing to change, so it can be found in the picture (fix_detail). */
  find: string;
  /** One short Vietnamese sentence the owner reads. */
  say: string;
}

export interface FixPlan {
  /** Short Vietnamese answer: what will be done, or the question when the note is unclear. */
  reply: string;
  actions: FixAction[];
}

const ACTION = S.obj({
  do: S.enum([...FIX_KINDS]),
  shot: S.str("shot id such as s03, or empty"),
  line: S.int("index of the subtitle line, or -1"),
  text: S.str("new subtitle or bubble text in Vietnamese exactly as it should read, or empty"),
  start: S.num("seconds, or -1"),
  end: S.num("seconds, or -1"),
  what: S.str("English instruction for the picture, or empty"),
  find: S.str("short English noun phrase naming the thing to change in the picture, or empty"),
  say: S.str("one short Vietnamese sentence describing this edit for the owner"),
});
const FIX_PLAN = S.obj({ reply: S.str("short Vietnamese answer"), actions: S.arr(ACTION, 0, 12) });

const shotEnd = (plan: Plan, i: number) => plan.shots[i + 1]?.t ?? plan.end;

/** The plan as the model reads it: every shot with its time, picture description and the lines in it. */
export function describePlan(plan: Plan): string {
  const lines = plan.lines.map((l, k) => `  line ${k} [${l.start.toFixed(2)}–${l.end.toFixed(2)}s]: "${l.text}"`).join("\n");
  const shots = plan.shots
    .map((s, i) => `  ${s.id} [${s.t.toFixed(2)}–${shotEnd(plan, i).toFixed(2)}s]${s.src ? ` reuses ${s.src}` : ""}: ${s.act}${s.pose ? ` | pose 2: ${s.pose}` : " | one pose"}${s.bubble ? ` | bubble: "${s.bubble}"` : ""}`)
    .join("\n");
  return `Clip ${plan.end.toFixed(2)} s long.\nSubtitle lines:\n${lines || "  (none)"}\nShots (each shows its picture from its start until the next shot):\n${shots}`;
}

/** Turns the owner's note into edits. `at` is where the video was paused, when it was. */
export async function askFixes(ctx: StudioContext, plan: Plan, dir: string, note: string, at?: number, gaps: Array<{ start: number; end: number }> = []): Promise<FixPlan> {
  const thumbs: ChatMessage["content"] = [];
  for (const s of plan.shots.filter((x) => !x.src)) {
    const f = join(dir, `${s.id}.png`);
    if (!existsSync(f)) continue;
    const jpg = await sharp(f).resize(270, 480, { fit: "cover" }).jpeg({ quality: 70 }).toBuffer();
    thumbs.push({ type: "text", text: `Picture of ${s.id}:` }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpg.toString("base64")}` } });
  }
  const paused = at !== undefined && Number.isFinite(at) ? (() => {
    const i = [...plan.shots.keys()].reverse().find((k) => plan.shots[k].t <= at + 1e-6) ?? 0;
    const l = plan.lines.findIndex((x) => at >= x.start - 0.1 && at <= x.end + 0.1);
    return `The owner paused the video at ${at.toFixed(2)} s: shot ${plan.shots[i].id}${l >= 0 ? `, line ${l}` : ", no subtitle line on screen"}. "Here", "this", "chỗ này" mean that moment.`;
  })() : "";
  const text = [
    "You help the owner fix a short vertical comic video (Vietnamese office comedy, one picture per shot, subtitles from the voice). He writes in Vietnamese what is wrong. Turn it into the fewest edits that do exactly what he asks, nothing more.",
    describePlan(plan),
    gaps.length ? `Stretches where someone speaks but no subtitle line covers it: ${gaps.map((g) => `${g.start.toFixed(2)}–${g.end.toFixed(2)}s`).join(", ")}.` : "",
    paused,
    `His note: """${note.trim()}"""`,
    "Edits you can use:",
    "- line_text(line, text): a subtitle says the wrong words. Keep his exact Vietnamese spelling and only change the words he points at.",
    "- line_time(line, start, end): a subtitle shows too early or late.",
    "- add_line(text, start, end): a spoken line has no subtitle. Use the uncovered stretches above for its time when they match.",
    "- drop_line(line): a subtitle that should not be there.",
    "- bubble(shot, text): the speech bubble text; empty text removes it.",
    "- fix_detail(shot, what, find): one thing in a picture is wrong and the rest is good (a pin on the wrong side, a wrong object, wrong colour). `what` is a short English edit instruction, `find` names something visible in the picture NOW so it can be located, e.g. 'star pin on his back', 'the lightsticks'; to add a thing, `find` is where it goes, e.g. 'Rico's right paw'. Prefer this over redraw.",
    "- redraw(shot, what): the whole picture is wrong (wrong place, wrong character, wrong time of day). `what` says in English what it must show.",
    "- add_shot(start, end, what): a line has no picture of its own; a new shot shows `what` (English, name the characters as in the shots above) from `start` to `end`. Use that line's own start and end times from the list above (not the paused second), and the picture before comes back after `end`. Never a real person or celebrity: a singer or band the words name is only tiny faceless silhouettes on a stage or screen, with our character in front. When that line's subtitle is garbled too, also add line_text for it.",
    "- redo_pose(shot): the second pose jumps or looks broken. one_pose(shot): keep the picture still. no_mouth(shot): the mouth should not move (back view, nobody talks).",
    "Fill every field: shot id or empty, line index or -1, seconds or -1. Write `say` as one short Vietnamese sentence the owner reads, e.g. 'Câu 1: đổi \"Mày\" thành \"Mẹ\"'.",
    "If the note is unclear, return no edits and ask one short question in `reply`. Otherwise `reply` says in one short Vietnamese sentence what WILL be done (nothing is done until he presses the button), e.g. 'Sẽ đổi chữ câu đầu và vẽ thêm một cảnh.'",
  ].filter(Boolean).join("\n\n");
  const r = await ctx.spark.json<FixPlan>("clip_fixes", FIX_PLAN, [{ role: "user", content: [{ type: "text", text }, ...thumbs] }]);
  return { reply: r.reply, actions: r.actions.filter((a) => validAction(plan, a)) };
}

/** Drops edits that point at shots or lines that do not exist, or times outside the clip. */
export function validAction(plan: Plan, a: FixAction): boolean {
  const shot = plan.shots.find((s) => s.id === a.shot);
  const line = plan.lines[a.line];
  const time = (n: number) => n >= 0 && n <= plan.end + 0.01;
  switch (a.do) {
    case "line_text": return !!line && !!a.text.trim();
    case "line_time": return !!line && time(a.start) && time(a.end) && a.end > a.start;
    case "add_line": return !!a.text.trim() && time(a.start) && time(a.end) && a.end > a.start;
    case "drop_line": return !!line;
    case "bubble": return !!shot;
    case "fix_detail": return !!shot && !shot.src && !!a.what.trim();
    case "redraw": return !!shot && !shot.src;
    case "add_shot": return a.start >= 0.3 && a.start <= plan.end - 0.3 && !!a.what.trim() && (a.end < 0 || a.end > a.start + 0.3);
    default: return !!shot && !shot.src;
  }
}

/** Spoken stretches (≥ `min` s) that no subtitle covers: where the recogniser missed words. */
export function speechGaps(pcm: Int16Array, lines: Array<{ start: number; end: number }>, rate = RATE, min = 0.6): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const voiced = voicedRegions(pcm, rate);
  for (const v of voiced) {
    let pieces = [{ start: v.start, end: v.end }];
    for (const l of lines) pieces = pieces.flatMap((p) => (l.end + 0.15 <= p.start || l.start - 0.15 >= p.end ? [p] : [{ start: p.start, end: l.start - 0.15 }, { start: l.end + 0.15, end: p.end }].filter((x) => x.end > x.start)));
    out.push(...pieces.filter((p) => p.end - p.start >= min).map((p) => ({ start: +p.start.toFixed(2), end: +p.end.toFixed(2) })));
  }
  // Music under the voice makes the whole clip "voiced": then this says nothing rather than everything.
  const total = pcm.length / rate, missed = out.reduce((n, g) => n + g.end - g.start, 0);
  return missed > total * 0.35 ? [] : out;
}
