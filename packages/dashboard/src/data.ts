/**
 * Everything the dashboard shows, read from the files the other packages
 * already write: character profiles, Muse Image test runs, the publish
 * journal and the pulled comments. The dashboard owns one file of its own,
 * directions.json: comments picked as the next episode's direction.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { channelStates, loadBrands, parseJournalKey, type Brand, type ChannelState, type Comment, type Conversation, type JournalEntry, type Platform } from "@hoi-sau/channel";
import { listCharacters, loadProfile, nameVi, type ConsistencyRun, type Profile } from "@hoi-sau/studio";
import { lang } from "./i18n.js";
import { emptyMemory, measureEpisodes, memoryFile, SERIES_DIR, type EpisodeStats, type Lesson, type PostInsights, type StoryMemory } from "@hoi-sau/story";

export interface Paths {
  /** CHANNEL_DATA_DIR: publish-journal.json, comments.json, directions.json. */
  dataDir: string;
  /** output/characters, where `studio sheet` writes its runs. */
  runsDir: string;
  charactersDir?: string;
  /** series/: story-memory.json with the coach's lessons. */
  seriesDir?: string;
  /** Studio episodes folder, for the comic pages and covers. */
  episodesDir?: string;
  /** Page profile pictures and covers: <brandArtDir>/<brand>/avatar.png, cover.png. Defaults to output/brand-art. */
  brandArtDir?: string;
  /** channels.yaml; defaults to the one at the repo root. */
  brandsFile?: string;
  /** Where to look up the .env names in channels.yaml. Only whether each is set is shown. */
  env?: Record<string, string | undefined>;
}

export interface Episode {
  key: string;
  episodeId: string;
  /** Character slug: the brand's character, else from the "<slug>-ep-NNN" episode id. */
  character: string;
  /** Brand id from channels.yaml whose account has the post. */
  brand: string;
  platform: Platform;
  format: string;
  state: "publishing" | "published";
  postId?: string;
  permalink?: string;
  at: string;
}

export interface Direction {
  commentId: string;
  pickedAt: string;
}

/** A made episode as pictures: lettered pages, and the motion comic when there is one. URLs are dashboard paths. */
export interface Comic {
  id: string;
  title: string;
  logline?: string;
  lead: string;
  characters: string[];
  pages: string[];
  cover?: string;
  reel?: string;
}

export function loadComics(episodesDir?: string): Map<string, Comic> {
  const comics = new Map<string, Comic>();
  if (!episodesDir || !existsSync(episodesDir)) return comics;
  for (const d of readdirSync(episodesDir, { withFileTypes: true })) {
    const dir = join(episodesDir, d.name);
    if (!d.isDirectory() || !existsSync(join(dir, "episode.json"))) continue;
    const ep = readJson<{ lead: string; characters: string[] }>(join(dir, "episode.json"), { lead: "", characters: [] });
    const premise = readJson<{ title?: string; logline?: string }>(join(dir, "premise.json"), {});
    const url = (f: string) => `/studio-media/${encodeURIComponent(d.name)}/${f}`;
    const finals = existsSync(join(dir, "final")) ? readdirSync(join(dir, "final")).filter((f) => /^\d+\.png$/.test(f)).sort() : [];
    comics.set(d.name, {
      id: d.name,
      title: premise.title ?? d.name,
      logline: premise.logline,
      lead: ep.lead,
      characters: ep.characters ?? [],
      // Episodes lettered before 27/10 have a combined strip page; newer ones post each panel.
      pages: existsSync(join(dir, "final", "page.png")) ? [url("final/page.png")] : finals.map((f) => url(`final/${f}`)),
      cover: existsSync(join(dir, "motion", "cover.jpg")) ? url("motion/cover.jpg") : finals[0] ? url(`final/${finals[0]}`) : undefined,
      reel: existsSync(join(dir, "motion", "reel.mp4")) ? url("motion/reel.mp4") : undefined,
    });
  }
  return comics;
}

export interface CharacterView {
  profile: Profile;
  run?: ConsistencyRun;
  episodes: number;
  comments: number;
}

/** One daily run of the automation (packages/pipeline), from data/pipeline/runs.json. */
export interface Run {
  id: string;
  date: string;
  mode: "mock" | "live";
  status: "running" | "done" | "partial" | "failed";
  startedAt: string;
  finishedAt?: string;
  episodeId?: string;
  direction?: { text: string; source: string; commentIds: string[]; credits: Array<{ name: string; comment: string }>; lead: string; characters: string[] };
  stages: Array<{ name: string; status: "running" | "done" | "warn" | "skipped" | "failed"; startedAt: string; finishedAt?: string; note?: string; error?: string }>;
  posts: Array<{ platform: string; format: string; status: "published" | "failed" | "skipped"; postId?: string; permalink?: string; error?: string }>;
  /** Relative to the episodes folder. */
  video?: string;
  cover?: string;
  error?: string;
}

/** A brand from channels.yaml with what it has posted and heard back. */
export interface BrandView {
  brand: Brand;
  channels: ChannelState[];
  /** Distinct published episodes. */
  episodes: number;
  posts: number;
  comments: number;
  lastPostAt?: string;
  character?: CharacterView;
  /** Dashboard URLs of the page's profile picture and cover, when drawn. */
  art?: { avatar?: string; cover?: string };
}

export interface State {
  brands: BrandView[];
  /** Episode id → its pages, from the Studio folder. */
  comics: Map<string, Comic>;
  characters: CharacterView[];
  episodes: Episode[];
  comments: Comment[];
  directions: Direction[];
  /** Newest conversation first. */
  inbox: Conversation[];
  /** postId → episode, to label comments. */
  byPost: Map<string, Episode>;
  /** Newest first. */
  runs: Run[];
  /** Published episodes scored by the story coach, best first. */
  stats: EpisodeStats[];
  lessons: Lesson[];
  lessonsAt?: string;
  /** Days in a row, ending today or yesterday (Hanoi), with at least one published post. */
  streak: number;
}

export const brandArtDir = (paths: Paths) => paths.brandArtDir ?? join(paths.runsDir, "..", "brand-art");

const HANOI = 7 * 3600_000;
const day = (iso: string) => new Date(Date.parse(iso) + HANOI).toISOString().slice(0, 10);

export function postingStreak(episodes: Episode[], now = new Date()): number {
  const days = new Set(episodes.filter((e) => e.state === "published").map((e) => day(e.at)));
  const cursor = new Date(Date.parse(day(now.toISOString())));
  if (!days.has(cursor.toISOString().slice(0, 10))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  let n = 0;
  while (days.has(cursor.toISOString().slice(0, 10))) {
    n++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return n;
}

const readJson = <T>(path: string, fallback: T): T => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback);

export const characterOf = (episodeId: string) => episodeId.replace(/-ep-\d+$/, "");

export function parseJournal(journal: Record<string, JournalEntry>, brands: Brand[] = []): Episode[] {
  return Object.entries(journal)
    .map(([key, e]) => {
      const { episodeId, platform, format, brand } = parseJournalKey(key);
      return {
        key,
        episodeId,
        character: brands.find((b) => b.id === brand)?.character ?? characterOf(episodeId),
        brand,
        platform: platform as Platform,
        format,
        state: e.state,
        postId: e.state === "published" ? e.postId : undefined,
        permalink: e.state === "published" ? e.permalink : undefined,
        at: e.state === "published" ? e.publishedAt : e.startedAt,
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** The profile as the page shows it: the Vietnamese name in Vietnamese, the global name in English. */
const shownProfile = (p: Profile): Profile => (lang() === "vi" ? { ...p, name: nameVi(p) } : p);

export function loadState(paths: Paths): State {
  const journal = readJson<Record<string, JournalEntry>>(join(paths.dataDir, "publish-journal.json"), {});
  let brandList: Brand[] = [];
  try {
    brandList = loadBrands(paths.brandsFile);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const episodes = parseJournal(journal, brandList);
  const comments = readJson<Comment[]>(join(paths.dataDir, "comments.json"), []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const directions = readJson<Direction[]>(join(paths.dataDir, "directions.json"), []);
  const inbox = readJson<Conversation[]>(join(paths.dataDir, "inbox.json"), []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const byPost = new Map(episodes.filter((e) => e.postId).map((e) => [e.postId!, e]));

  const characters = listCharacters(paths.charactersDir).map((slug) => {
    const runFile = join(paths.runsDir, slug, "run.json");
    return {
      profile: shownProfile(loadProfile(slug, paths.charactersDir)),
      run: readJson<ConsistencyRun | undefined>(runFile, undefined),
      episodes: new Set(episodes.filter((e) => e.character === slug && e.state === "published").map((e) => e.episodeId)).size,
      comments: comments.filter((c) => byPost.get(c.postId)?.character === slug).length,
    };
  });
  const runs = readJson<Run[]>(join(paths.dataDir, "pipeline", "runs.json"), []).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const memory = { ...emptyMemory(), ...readJson<Partial<StoryMemory>>(memoryFile(paths.seriesDir ?? SERIES_DIR), {}) };
  const insights = readJson<PostInsights[]>(join(paths.dataDir, "insights.json"), []);
  const stats = measureEpisodes({ journal, comments, insights, memory });
  const env = paths.env ?? process.env;
  const artDir = brandArtDir(paths);
  const artOf = (id: string) => {
    const has = (f: string) => existsSync(join(artDir, id, f));
    return has("avatar.png") || has("cover.png") ? { avatar: has("avatar.png") ? `/brand-art/${id}/avatar.png` : undefined, cover: has("cover.png") ? `/brand-art/${id}/cover.png` : undefined } : undefined;
  };
  const brands = brandList.map((brand): BrandView => {
    const own = episodes.filter((e) => e.brand === brand.id && e.state === "published");
    return {
      brand,
      channels: channelStates(brand, env),
      episodes: new Set(own.map((e) => e.episodeId)).size,
      posts: own.length,
      comments: comments.filter((c) => byPost.get(c.postId)?.brand === brand.id).length,
      lastPostAt: own[0]?.at,
      character: characters.find((c) => c.profile.slug === brand.character),
      art: artOf(brand.id),
    };
  });
  return { brands, comics: loadComics(paths.episodesDir), characters, episodes, comments, directions, inbox, byPost, runs, stats, lessons: memory.lessons, lessonsAt: memory.lessonsAt, streak: postingStreak(episodes) };
}

/** Pick or unpick a comment as the next direction. Returns the new list. */
export async function toggleDirection(dataDir: string, commentId: string, now = new Date()): Promise<Direction[]> {
  const path = join(dataDir, "directions.json");
  let list: Direction[] = [];
  try {
    list = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  list = list.some((d) => d.commentId === commentId)
    ? list.filter((d) => d.commentId !== commentId)
    : [...list, { commentId, pickedAt: now.toISOString() }];
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(list, null, 2) + "\n");
  await rename(`${path}.tmp`, path);
  return list;
}

/** Append a sent message to a stored conversation. */
export async function appendMessage(dataDir: string, conversationId: string, message: Conversation["messages"][number]): Promise<void> {
  const path = join(dataDir, "inbox.json");
  const all = readJson<Conversation[]>(path, []);
  const c = all.find((x) => x.id === conversationId);
  if (!c) throw new Error(`No conversation ${conversationId}`);
  c.messages.push(message);
  c.updatedAt = message.createdAt;
  await writeFile(`${path}.tmp`, JSON.stringify(all, null, 2) + "\n");
  await rename(`${path}.tmp`, path);
}
