/**
 * After studio writes an episode, recap it into story memory: a short
 * summary, how it ended, which open threads it answered, which running gags
 * it used, and the credited commenter as a coworker.
 *
 * Reads studio's saved steps (episodes/<id>/episode.json, premise.json,
 * beats.json, script.json, and listen.json when the episode came from
 * `--from-listen`). Muse Spark writes the summary and spots answered threads;
 * gag use is matched on each gag's cue words, which needs no model.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { askJson, type Llm } from "./llm.js";
import type { Remembered } from "./memory.js";
import type { Cameo, SeasonPlan, StoryMemory } from "./schema.js";
import { fold, hasPhrase } from "./text.js";

/** The parts of studio's step files this reads. */
export interface EpisodeFiles {
  spec: { id: string; lead: string; characters: string[]; direction: string; credits: Array<{ name: string; comment: string }> };
  premise: { title: string; logline: string; setup?: string; twist?: string; hook: string; cameo: { name: string; description: string } | null };
  beats?: { beats: Array<{ purpose: string; what_happens: string }> };
  script?: { title: string; panels: Array<{ action: string; dialogue: Array<{ speaker: string; text: string }> }> };
  listen?: { commentIds: string[]; cameo: Cameo | null };
}

export function readEpisodeFiles(episodesDir: string, id: string): EpisodeFiles {
  const read = (name: string) => {
    const f = join(episodesDir, id, `${name}.json`);
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;
  };
  const spec = read("episode");
  const premise = read("premise");
  if (!spec) throw new Error(`no episode ${id} in ${episodesDir}`);
  if (!premise) throw new Error(`episode ${id} has no premise yet; run studio first`);
  return { spec, premise, beats: read("beats"), script: read("script"), listen: read("listen") };
}

export const scriptText = (ep: EpisodeFiles) =>
  [
    ep.premise.title,
    ep.premise.logline,
    ...(ep.beats?.beats ?? []).map((b) => b.what_happens),
    ...(ep.script?.panels ?? []).flatMap((p) => [p.action, ...p.dialogue.map((d) => d.text)]),
  ].join("\n");

export const RECAP_TASK = "story.recap";

/** Strict JSON schema for the recap, for clients that constrain output (studio's MuseSpark.json). */
export const RECAP_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Vietnamese, 2–3 sentences" },
    threads_closed: { type: "array", items: { type: "string", description: "id of an open thread this episode answers" } },
    threads_opened: { type: "array", items: { type: "string", description: "Vietnamese, a new open question" }, maxItems: 2 },
  },
  required: ["summary", "threads_closed", "threads_opened"],
  additionalProperties: false,
} as const;

export function recapPrompt(ep: EpisodeFiles, memory: StoryMemory): { system: string; user: string } {
  const open = memory.threads.filter((t) => t.status === "open");
  return {
    system: [
      "Bạn giữ sổ ghi nhớ của một bộ truyện tranh hài văn phòng ra mỗi ngày.",
      "Đọc tập vừa viết và trả về JSON:",
      '{"summary": "2–3 câu tiếng Việt: chuyện gì xảy ra và kết thế nào", "threads_closed": ["id các tuyến còn mở mà tập này đã trả lời"], "threads_opened": ["câu hỏi mới tập này để ngỏ, tối đa 2, tiếng Việt"]}',
      "Chỉ đóng tuyến khi tập này thật sự trả lời nó. Chỉ dùng id có trong danh sách.",
    ].join("\n"),
    user: [
      `OPEN_THREADS_JSON: ${JSON.stringify(open.map((t) => ({ id: t.id, text: t.text })))}`,
      `HOOK: ${ep.premise.hook}`,
      `EPISODE:\n${scriptText(ep)}`,
    ].join("\n\n"),
  };
}

export function checkRecap(value: unknown, openIds: string[]): { summary: string; threads_closed: string[]; threads_opened: string[] } {
  const v = value as Record<string, unknown>;
  if (typeof v?.summary !== "string" || !v.summary.trim()) throw new Error("summary is required");
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && !!s.trim()) : []);
  return {
    summary: v.summary.trim(),
    threads_closed: list(v.threads_closed).filter((id) => openIds.includes(id)),
    threads_opened: list(v.threads_opened).slice(0, 2),
  };
}

export async function recap(llm: Llm, ep: EpisodeFiles, memory: StoryMemory, plan: SeasonPlan | undefined, number: number): Promise<Remembered> {
  const openIds = memory.threads.filter((t) => t.status === "open").map((t) => t.id);
  const { system, user } = recapPrompt(ep, memory);
  const r = await askJson(llm, { task: RECAP_TASK, system, user, temperature: 0.2 }, (v) => checkRecap(v, openIds));
  const text = fold(scriptText(ep));
  const gags = (plan?.running_gags ?? []).filter((g) => g.cues.some((c) => hasPhrase(text, fold(c)))).map((g) => g.id);

  const cameos: Cameo[] = [];
  if (ep.listen?.cameo) {
    // The writer may have described the coworker better than the default animal.
    const look = ep.premise.cameo && ep.premise.cameo.name === ep.listen.cameo.name ? ep.premise.cameo.description : ep.listen.cameo.look;
    cameos.push({ ...ep.listen.cameo, look });
  }
  // The hook is always an open question; extra ones come from the model.
  const opened = [ep.premise.hook, ...r.threads_opened.filter((t) => t !== ep.premise.hook)].filter(Boolean).slice(0, 2);

  return {
    episode: {
      id: ep.spec.id,
      number,
      lead: ep.spec.lead,
      characters: ep.spec.characters,
      title: ep.script?.title ?? ep.premise.title,
      summary: r.summary,
      hook: ep.premise.hook,
      fromComments: ep.listen?.commentIds ?? [],
    },
    threadsOpened: opened.map((text) => ({ text, characters: ep.spec.characters })),
    threadsClosed: r.threads_closed,
    gags,
    cameos,
  };
}
