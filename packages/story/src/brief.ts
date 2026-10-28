/**
 * What the writer sees: the canon picked for this episode, and the craft
 * rules for a four-beat office comic.
 *
 * storyBrief() replaces studio's bibleBrief(). Same inputs plus memory, and
 * instead of "the last 20 canon facts" it picks what this episode needs:
 * facts about this cast that relate to the direction, the last episodes in
 * full with how the previous one ended, the open threads worth paying off,
 * the act of the season this episode sits in, and running gags that have
 * rested long enough.
 */

import { existsSync, readFileSync } from "node:fs";
import { actFor, availableGags, emptyMemory, memoryFile, milestonesFor, SERIES_DIR } from "./memory.js";
import type { BibleLike, SeasonPlan, StoryMemory } from "./schema.js";
import { jaccard, keywords } from "./text.js";

export interface BriefInput {
  memory?: StoryMemory;
  plan?: SeasonPlan;
  /** Defaults to the episode after the last one remembered. */
  episodeNumber?: number;
  /** Used to pull in related canon. */
  direction?: string;
  maxFacts?: number;
  recentEpisodes?: number;
}

/** Synchronous load for prompt building; a missing file is an empty memory. */
export function loadMemorySync(dir = SERIES_DIR): StoryMemory {
  const f = memoryFile(dir);
  return existsSync(f) ? { ...emptyMemory(), ...JSON.parse(readFileSync(f, "utf8")) } : emptyMemory();
}

export function storyBrief(b: BibleLike, characters: string[], input: BriefInput = {}): string {
  const memory = input.memory ?? emptyMemory();
  const n = input.episodeNumber ?? memory.episodes.reduce((m, e) => Math.max(m, e.number), 0) + 1;
  const cast = new Set(characters);
  const onlyCast = (list: string[]) => list.filter((c) => cast.has(c));
  const want = keywords(input.direction ?? "");

  // Canon: this cast only, ranked by relation to the direction, then recency;
  // shown in the order it happened.
  const facts = b.canon
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.characters.some((c) => cast.has(c)))
    .map(({ f, i }) => ({ f, i, rank: 2 * jaccard(want, keywords(f.fact)) + i / Math.max(1, b.canon.length) + (f.characters.includes(characters[0]) ? 0.3 : 0) }))
    .sort((x, y) => y.rank - x.rank)
    .slice(0, input.maxFacts ?? 20)
    .sort((x, y) => x.i - y.i)
    .map(({ f }) => ({ episode: f.episode, fact: f.fact, characters: onlyCast(f.characters) }));

  const past = memory.episodes.filter((e) => e.number < n);
  const recent = past.slice(-(input.recentEpisodes ?? 4));
  const older = past.slice(0, past.length - recent.length);
  const last = past[past.length - 1];

  const threads = memory.threads
    .filter((t) => t.status === "open" && (!t.characters.length || t.characters.some((c) => cast.has(c))))
    .slice(0, 6)
    .map((t) => ({ id: t.id, text: t.text, since: t.opened }));

  let season: Record<string, unknown>;
  if (input.plan) {
    const act = actFor(input.plan, n);
    season = {
      arc: b.season.arc,
      episode: n,
      of: input.plan.episodes,
      act: { title: act.title, episodes: act.episodes, goal: act.goal, must_happen: act.must_happen, avoid: act.avoid },
      ask_the_audience: act.audience_question,
      ...(n >= input.plan.episodes ? { finale: input.plan.finale } : {}),
    };
  } else {
    const m = milestonesFor(b.season.milestones, n);
    season = { arc: b.season.arc, episode: n, milestones_now: m.now, next_milestone: m.next };
  }

  return JSON.stringify({
    premise: b.premise,
    tone: b.tone,
    audience: b.audience,
    world: b.world,
    rules: b.rules,
    format: b.format,
    relationships: b.relationships.filter((r) => cast.has(r.a) && cast.has(r.b)),
    season,
    previously: last ? { episode: last.number, title: last.title, ended_on: last.hook } : null,
    story_so_far: [
      ...(older.length ? [`Các tập trước: ${older.map((e) => `#${e.number} ${e.title}`).join("; ")}`] : []),
      ...recent.map((e) => `#${e.number} ${e.title}: ${e.summary}`),
    ],
    canon: facts,
    open_threads: threads,
    running_gags: availableGags(input.plan, memory, n, characters)
      .slice(0, 3)
      .map((g) => ({ id: g.id, text: g.text })),
    lessons_from_audience: memory.lessons.map((l) => ({ kind: l.kind, text: l.text })),
    coworkers_from_audience: memory.cameos.slice(-4).map((c) => ({ name: c.name, look: c.look, since: c.firstEpisode })),
  });
}

/**
 * Craft rules for the writer's system prompt. Written from what makes a
 * four-panel office strip land with Vietnamese readers on a phone.
 */
export const WRITER_GUIDE = [
  "How to write a Hồi Sau episode:",
  "- Build the episode on one trigger moment every office worker has lived through, made specific (a time, an object, a message: \"em ơi\" at 22h, a meeting with no agenda, a file sent at 16h59). Specific is funny; general is not.",
  "- Picture first: the situation and the drawing carry the comedy. The punchline must read from the panel alone; at least one panel has no dialogue.",
  "- Four beats: setup (normal day, one detail off) → build (it gets worse, the character reacts in their own way) → turn (a reversal the reader did not see coming but that fits the character) → punch (one line or one look, then stop).",
  "- The joke comes from the character's flaw meeting the situation. Characters tease each other and have flaws; they never insult, and never mock a body, a region or a gender.",
  "- First panel must make a scroller stop: start in the middle of the moment, no introductions.",
  "- Dialogue: short spoken Vietnamese the way 22–32 year olds text at work (\"dạ\", \"ủa\", \"thôi xong\", \"căng\"), within the bible's word and bubble limits. Rarely say a character's name; readers know them by shape and habit.",
  "- The direction may list voice patterns learned from how young readers write on Threads (a sentence frame, a slang phrase). Use at most one per episode, only where it fits the moment, in the character's own Hà Nội voice; never quote the source line and never explain the slang.",
  "- Each character sounds like their voice and catchphrases; use a catchphrase at most once per episode, where it lands hardest.",
  "- Respect canon and never contradict a fact. If `previously.ended_on` is set, the first beat answers or nods to it.",
  "- Pay off one open thread when it fits naturally; open at most one new small question at the end for \"hồi sau\".",
  "- Use at most one running gag, and only one listed in running_gags.",
  "- A credited commenter appears as a named coworker who does or says the thing they suggested; keep them kind and likeable.",
  "- Last panel: the punchline, or a question the audience can answer in one comment. Never explain the joke.",
  "- lessons_from_audience come from how past episodes did: follow \"do\", stay away from \"avoid\", and try a \"test\" when it fits.",
].join("\n");
