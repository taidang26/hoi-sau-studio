/**
 * Shapes this package reads and writes. The series bible and character
 * profiles belong to @hoi-sau/studio; they are described here structurally
 * (only the fields used), so this package never imports studio and studio can
 * import it.
 */

import type { Platform } from "@hoi-sau/channel";

// ── read from studio ───────────────────────────────────────────────────────

export interface BibleLike {
  title: string;
  premise: string;
  tone: string;
  audience: string;
  world: { company: string; places: string[]; recurring_extras: string[] };
  rules: string[];
  format: { panels: { min: number; max: number }; aspect: string; ending: string };
  cast: string[];
  relationships: Array<{ a: string; b: string; dynamic: string }>;
  season: { arc: string; milestones: string[] };
  canon: Array<{ episode: string; fact: string; characters: string[] }>;
}

export interface ProfileLike {
  slug: string;
  name: string;
  species?: string;
  office_type?: string;
  core_gag?: string;
  personality?: string[];
  voice?: { register?: string; speech_pattern?: string; catchphrases?: string[]; sample_lines?: string[] };
  never_says?: string[];
  look?: { expressions?: Record<string, string> };
}

/** The fields of studio's EpisodeSpec that listening fills in. */
export interface SpecDirection {
  direction: string;
  credits: Array<{ name: string; comment: string }>;
}

// ── season plan: series/season-<n>.yaml, written by hand ───────────────────

export interface Act {
  id: string;
  title: string;
  /** Inclusive episode numbers. */
  episodes: [number, number];
  goal: string;
  must_happen: string[];
  avoid: string[];
  /** What the caption asks the audience during this act. */
  audience_question: string;
}

export interface RunningGag {
  id: string;
  /** Characters the gag belongs to; empty means anyone. */
  characters: string[];
  text: string;
  /** Words that show the gag is in a script, matched without diacritics. */
  cues: string[];
  /** Episodes to rest between uses, so a gag does not go stale. */
  cooldown: number;
}

export interface SeasonPlan {
  season: number;
  title: string;
  theme: string;
  episodes: number;
  acts: Act[];
  running_gags: RunningGag[];
  finale: string;
}

// ── story memory: series/story-memory.json, grown after every episode ──────

export interface EpisodeMemory {
  id: string;
  number: number;
  lead: string;
  characters: string[];
  title: string;
  /** Two or three sentences, Vietnamese. */
  summary: string;
  /** The open question the last panel leaves for "hồi sau". */
  hook: string;
  /** Comment ids the episode was written from. */
  fromComments: string[];
  at: string;
}

export interface StoryThread {
  id: string;
  text: string;
  characters: string[];
  opened: string;
  status: "open" | "closed";
  closed?: string;
}

/** A commenter written in as a coworker, drawn from words only, never from a photo. */
export interface Cameo {
  id: string;
  /** First name or handle only. */
  name: string;
  role: string;
  /** English, how to draw them as an animal coworker. */
  look: string;
  credit: { platform: Platform; commentId: string; authorName: string };
  firstEpisode: string;
}

/** What the audience showed works, learned from published episodes by the coach. */
export interface Lesson {
  id: string;
  kind: "do" | "avoid" | "test";
  /** One Vietnamese sentence the writer can act on. */
  text: string;
  /** Episodes whose numbers back it. */
  evidence: string[];
}

export interface StoryMemory {
  episodes: EpisodeMemory[];
  threads: StoryThread[];
  cameos: Cameo[];
  /** Running gag id → episode number it was last used in. */
  gagsUsed: Record<string, number>;
  /** Lessons the editor approved; the writer and the comment scorer use only these. */
  lessons: Lesson[];
  lessonsAt?: string;
  /** The latest coach run, waiting for the editor. Replaced on every run. */
  pendingLessons?: Lesson[];
  pendingAt?: string;
}

// ── coach: how each published episode did ─────────────────────────────────

/** Optional per-post numbers the channel can add later (data/insights.json). */
export interface PostInsights {
  postId: string;
  reactions?: number;
  shares?: number;
  saves?: number;
  reach?: number;
}

export interface EpisodeStats {
  episodeId: string;
  number?: number;
  title?: string;
  platforms: string[];
  comments: number;
  /** Distinct people commenting: the signal that best predicts the next episode's pull. */
  authors: number;
  replies: number;
  /** Comments the rule screen kept (not spam, toxic, duplicate or empty). */
  kept: number;
  reactions: number;
  shares: number;
  saves: number;
  reach: number;
  /** Weighted engagement, comparable across episodes. */
  score: number;
}

// ── listening ──────────────────────────────────────────────────────────────

export type RejectReason = "spam" | "toxic" | "duplicate" | "too-short" | "self";

export type Verdict = "idea" | "reaction" | "question" | "off-character" | "unsafe";

export interface ScoredComment {
  commentId: string;
  verdict: Verdict;
  /** The idea rewritten as one Vietnamese sentence; empty unless verdict is "idea". */
  idea: string;
  /** Short kebab-case label; comments that want the same thing share it. */
  cluster: string;
  /** 0–5 each. fit = in character and inside the season act. */
  scores: { fun: number; fit: number; fresh: number };
  reason: string;
}

export interface IdeaCluster {
  key: string;
  idea: string;
  commentIds: string[];
  authors: number;
  /** Replies under the cluster's comments, a cheap "I want this too" signal. */
  support: number;
  score: number;
  /** The comment whose author gets the credit. */
  bestCommentId: string;
}

export interface ListenReport {
  at: string;
  /** Episodes whose comments were read; empty means all. */
  episodes: string[];
  lead: string;
  episodeNumber: number;
  model: string;
  totals: Record<RejectReason | Verdict | "pulled", number>;
  rejected: Array<{ commentId: string; reason: RejectReason; detail: string }>;
  scored: ScoredComment[];
  clusters: IdeaCluster[];
  pick: {
    source: "audience" | "editor" | "season";
    /** Same fields as studio's EpisodeSpec, so it drops straight in. */
    spec: SpecDirection;
    why: string;
    commentIds: string[];
    cameo: Cameo | null;
  };
}
