/**
 * Coach: learn from published episodes what the audience responds to, and
 * feed it back so every episode makes the next one better.
 *
 *   measure  publish journal + comments (+ insights when the channel has them)
 *            → one comparable score per episode
 *   coach    Muse Spark compares the strongest and weakest episodes against
 *            what each one was about, and writes up to five lessons
 *   review   lessons wait in memory.pendingLessons until the editor approves
 *            them (`story lessons approve`), so one bad run cannot steer
 *            the series
 *   use      approved lessons: storyBrief shows them to the writer and
 *            listening shows them to the comment scorer
 */

import type { Comment, JournalEntry } from "@hoi-sau/channel";
import { askJson, type Llm } from "./llm.js";
import { screen } from "./listen.js";
import type { EpisodeStats, Lesson, PostInsights, StoryMemory } from "./schema.js";

/** Weights per signal. Shares and saves mean "I'd show this to a friend"; distinct commenters mean the loop is working. */
export const WEIGHTS = { reactions: 1, comments: 2, authors: 4, replies: 1, shares: 6, saves: 5 };

export interface MeasureInput {
  /** data/publish-journal.json: "<episodeId>:<platform>:<format>" → entry. */
  journal: Record<string, JournalEntry>;
  comments: Comment[];
  insights?: PostInsights[];
  memory: StoryMemory;
  /** Episodes younger than this are left out: they have not had their day yet. */
  minAgeHours?: number;
  now?: Date;
}

export function measureEpisodes(input: MeasureInput): EpisodeStats[] {
  const now = (input.now ?? new Date()).getTime();
  const minAge = (input.minAgeHours ?? 24) * 3600_000;
  const posts = new Map<string, string[]>();
  const platforms = new Map<string, Set<string>>();
  for (const [key, e] of Object.entries(input.journal)) {
    if (e.state !== "published" || now - Date.parse(e.publishedAt) < minAge) continue;
    const episodeId = key.split(":")[0];
    posts.set(episodeId, [...(posts.get(episodeId) ?? []), e.postId]);
    platforms.set(episodeId, (platforms.get(episodeId) ?? new Set()).add(e.platform));
  }
  const insight = new Map((input.insights ?? []).map((i) => [i.postId, i]));

  return [...posts.entries()]
    .map(([episodeId, ids]) => {
      const mine = input.comments.filter((c) => ids.includes(c.postId));
      const sum = (k: keyof Omit<PostInsights, "postId">) => ids.reduce((n, id) => n + (insight.get(id)?.[k] ?? 0), 0);
      const known = input.memory.episodes.find((e) => e.id === episodeId);
      const s = {
        episodeId,
        number: known?.number,
        title: known?.title,
        platforms: [...(platforms.get(episodeId) ?? [])].sort(),
        comments: mine.length,
        authors: new Set(mine.map((c) => c.author.id ?? c.author.name)).size,
        replies: mine.filter((c) => c.parentId).length,
        kept: screen(mine).kept.length,
        reactions: sum("reactions"),
        shares: sum("shares"),
        saves: sum("saves"),
        reach: sum("reach"),
      };
      const score =
        WEIGHTS.reactions * s.reactions + WEIGHTS.comments * s.kept + WEIGHTS.authors * s.authors + WEIGHTS.replies * s.replies + WEIGHTS.shares * s.shares + WEIGHTS.saves * s.saves;
      return { ...s, score };
    })
    .sort((a, b) => b.score - a.score);
}

export const COACH_TASK = "story.coach";

/** Strict schema for clients that constrain output. */
export const COACH_SCHEMA = {
  type: "object",
  properties: {
    lessons: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["do", "avoid", "test"] },
          text: { type: "string", description: "Vietnamese, one sentence a writer can act on" },
          evidence: { type: "array", items: { type: "string", description: "episode id" } },
        },
        required: ["kind", "text", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["lessons"],
  additionalProperties: false,
} as const;

export function coachPrompt(stats: EpisodeStats[], memory: StoryMemory): { system: string; user: string } {
  const rows = stats.map((s) => {
    const e = memory.episodes.find((x) => x.id === s.episodeId);
    const gags = Object.entries(memory.gagsUsed).filter(([, n]) => n === e?.number).map(([g]) => g);
    return {
      id: s.episodeId,
      score: s.score,
      comments: s.kept,
      people: s.authors,
      replies: s.replies,
      shares: s.shares,
      saves: s.saves,
      lead: e?.lead,
      title: e?.title,
      summary: e?.summary,
      ended_on: e?.hook,
      from_audience: !!e?.fromComments.length,
      gags,
    };
  });
  return {
    system: [
      "Bạn là coach nội dung cho một bộ truyện tranh hài văn phòng ra mỗi ngày trên Facebook, Instagram và Threads.",
      "So sánh các tập điểm cao với các tập điểm thấp: khác nhau ở nhân vật chính, kiểu tình huống, gag, cách kết, có viết từ ý khán giả hay không.",
      "Rút tối đa 5 bài học. Mỗi bài học là một câu người viết làm theo được ngay, kèm id các tập làm bằng chứng.",
      'kind: "do" = lặp lại, "avoid" = tránh, "test" = đáng thử vì dữ liệu chưa đủ chắc.',
      "Đừng kết luận từ một tập duy nhất; khi chỉ có một tập làm bằng chứng thì dùng \"test\". Không đoán điều số liệu không cho thấy.",
      'Trả về đúng JSON: {"lessons":[{"kind","text","evidence":[...]}]}',
    ].join("\n"),
    user: `EPISODES_JSON: ${JSON.stringify(rows)}`,
  };
}

export function checkLessons(value: unknown, ids: string[]): Lesson[] {
  const list = (value as { lessons?: unknown })?.lessons;
  if (!Array.isArray(list)) throw new Error('expected {"lessons": [...]}');
  return list
    .filter((l: any) => ["do", "avoid", "test"].includes(l?.kind) && typeof l?.text === "string" && l.text.trim())
    .slice(0, 5)
    .map((l: any, i) => {
      const evidence = (Array.isArray(l.evidence) ? l.evidence : []).filter((e: unknown) => typeof e === "string" && ids.includes(e));
      // One episode is an anecdote, not a pattern.
      const kind = l.kind !== "test" && evidence.length < 2 ? "test" : l.kind;
      return { id: `l${i + 1}`, kind, text: l.text.trim(), evidence };
    });
}

export interface CoachResult {
  stats: EpisodeStats[];
  lessons: Lesson[];
  /** Why no lessons were written, when none were. */
  skipped?: string;
}

/** Needs at least `minEpisodes` measured episodes; fewer is noise. */
export async function coach(llm: Llm, stats: EpisodeStats[], memory: StoryMemory, minEpisodes = 3): Promise<CoachResult> {
  if (stats.length < minEpisodes) return { stats, lessons: [], skipped: `cần ít nhất ${minEpisodes} tập đã đăng quá 24 giờ, mới có ${stats.length}` };
  const { system, user } = coachPrompt(stats, memory);
  const ids = stats.map((s) => s.episodeId);
  const lessons = await askJson(llm, { task: COACH_TASK, system, user, temperature: 0.3 }, (v) => checkLessons(v, ids));
  return { stats, lessons };
}

/** Use lessons right away, skipping review (`story coach --approve`). */
export const withLessons = (memory: StoryMemory, lessons: Lesson[], now = new Date()): StoryMemory => ({ ...memory, lessons, lessonsAt: now.toISOString(), pendingLessons: [], pendingAt: undefined });

/** Park a coach run for review. Earlier approved lessons stay in use meanwhile. */
export const proposeLessons = (memory: StoryMemory, lessons: Lesson[], now = new Date()): StoryMemory => ({ ...memory, pendingLessons: lessons, pendingAt: now.toISOString() });

/**
 * Approve or reject pending lessons by id ("all" = every one). The first
 * approval from a run replaces the lessons in use, since a run looks at every
 * episode again; later approvals from the same run add to them.
 */
export function reviewLessons(memory: StoryMemory, ids: string[], decision: "approve" | "reject", now = new Date()): StoryMemory {
  const pending = memory.pendingLessons ?? [];
  const picked = pending.filter((l) => ids.includes("all") || ids.includes(l.id));
  const left = pending.filter((l) => !picked.includes(l));
  const rest = { ...memory, pendingLessons: left, pendingAt: left.length ? memory.pendingAt : undefined };
  if (decision === "reject" || !picked.length) return rest;
  const sameRun = !!memory.pendingAt && memory.lessonsAt === memory.pendingAt;
  return { ...rest, lessons: [...(sameRun ? memory.lessons : []), ...picked], lessonsAt: memory.pendingAt ?? now.toISOString() };
}
