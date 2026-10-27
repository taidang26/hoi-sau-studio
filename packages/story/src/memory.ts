/**
 * Story memory and the season plan.
 *
 * The series bible (series/bible.yaml, owned by studio) keeps canon facts.
 * This file keeps what facts alone do not: what each episode was about, the
 * questions still open, commenters who became coworkers, and when each
 * running gag was last used. It lives in series/story-memory.json and is
 * grown by remember() after an episode's script is written.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Act, Cameo, EpisodeMemory, RunningGag, SeasonPlan, StoryMemory } from "./schema.js";

export const SERIES_DIR = fileURLToPath(new URL("../../../series", import.meta.url));

export const emptyMemory = (): StoryMemory => ({ episodes: [], threads: [], cameos: [], gagsUsed: {}, lessons: [] });

export const memoryFile = (dir = SERIES_DIR) => join(dir, "story-memory.json");

export async function loadMemory(dir = SERIES_DIR): Promise<StoryMemory> {
  try {
    return { ...emptyMemory(), ...JSON.parse(await readFile(memoryFile(dir), "utf8")) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyMemory();
    throw e;
  }
}

export async function saveMemory(memory: StoryMemory, dir = SERIES_DIR): Promise<void> {
  const path = memoryFile(dir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(memory, null, 2) + "\n", "utf8");
  await rename(`${path}.tmp`, path);
}

export function loadSeason(dir = SERIES_DIR, season = 1): SeasonPlan | undefined {
  const file = join(dir, `season-${season}.yaml`);
  return existsSync(file) ? (parse(readFileSync(file, "utf8")) as SeasonPlan) : undefined;
}

/** "cu-li-ep-007" → 7; ids without a number get the next free number. */
export function episodeNumber(id: string, memory: StoryMemory): number {
  const known = memory.episodes.find((e) => e.id === id);
  if (known) return known.number;
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : memory.episodes.reduce((n, e) => Math.max(n, e.number), 0) + 1;
}

export const nextNumber = (memory: StoryMemory) => memory.episodes.reduce((n, e) => Math.max(n, e.number), 0) + 1;

/** The act an episode falls in; after the last act, the last act. */
export function actFor(plan: SeasonPlan, episode: number): Act {
  return plan.acts.find((a) => episode >= a.episodes[0] && episode <= a.episodes[1]) ?? plan.acts[plan.acts.length - 1];
}

/**
 * The bible's milestones are free text like "Tập 10 sếp giao dự án Tết" or
 * "Tập 1–5 …". Returns the milestones that cover this episode, and the next one.
 */
export function milestonesFor(milestones: string[], episode: number): { now: string[]; next?: string } {
  const parsed = milestones.map((text) => {
    const m = /tập\s*(\d+)(?:\s*[–-]\s*(\d+))?/i.exec(text);
    return m ? { text, from: Number(m[1]), to: Number(m[2] ?? m[1]) } : { text, from: Infinity, to: Infinity };
  });
  const now = parsed.filter((p) => episode >= p.from && episode <= p.to).map((p) => p.text);
  const next = parsed.filter((p) => p.from > episode).sort((a, b) => a.from - b.from)[0];
  return { now, next: next?.text };
}

/** Running gags rested long enough to use in this episode, for these characters. */
export function availableGags(plan: SeasonPlan | undefined, memory: StoryMemory, episode: number, characters: string[]): RunningGag[] {
  return (plan?.running_gags ?? []).filter((g) => {
    const last = memory.gagsUsed[g.id];
    const rested = last === undefined || episode - last > g.cooldown;
    return rested && (!g.characters.length || g.characters.some((c) => characters.includes(c)));
  });
}

const nextId = (prefix: string, ids: string[]) =>
  `${prefix}${ids.reduce((n, id) => Math.max(n, Number(id.slice(prefix.length)) || 0), 0) + 1}`;

export interface Remembered {
  episode: Omit<EpisodeMemory, "at">;
  threadsOpened: Array<{ text: string; characters: string[] }>;
  /** Ids of open threads this episode answers. */
  threadsClosed: string[];
  gags: string[];
  cameos: Cameo[];
}

/**
 * Folds one episode into memory. Remembering the same episode again replaces
 * the first copy (threads it opened, threads it closed, its cameos), so
 * rerunning a step never duplicates memory.
 */
export function remember(memory: StoryMemory, r: Remembered, now = new Date()): StoryMemory {
  const m: StoryMemory = structuredClone(memory);
  const id = r.episode.id;
  m.episodes = m.episodes.filter((e) => e.id !== id);
  m.threads = m.threads.filter((t) => t.opened !== id);
  for (const t of m.threads) if (t.closed === id) (t.status = "open"), delete t.closed;
  m.cameos = m.cameos.filter((c) => c.firstEpisode !== id);

  m.episodes.push({ ...r.episode, at: now.toISOString() });
  m.episodes.sort((a, b) => a.number - b.number);
  for (const tid of r.threadsClosed) {
    const t = m.threads.find((x) => x.id === tid && x.status === "open");
    if (t) (t.status = "closed"), (t.closed = id);
  }
  for (const t of r.threadsOpened)
    m.threads.push({ id: nextId("t", m.threads.map((x) => x.id)), text: t.text, characters: t.characters, opened: id, status: "open" });
  for (const g of r.gags) m.gagsUsed[g] = r.episode.number;
  for (const c of r.cameos) if (!m.cameos.some((x) => x.credit.commentId === c.credit.commentId)) m.cameos.push({ ...c, firstEpisode: id });
  return m;
}
