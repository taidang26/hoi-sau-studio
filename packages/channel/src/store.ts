/**
 * Local storage for the channel data: plain JSON files in a data directory
 * (comments, inbox, publish journal). Each write lands in a sibling temp file
 * and is renamed over the old one, so a crash mid-write leaves the previous
 * version intact.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Comment } from "./comments.js";
import type { OutgoingComment } from "./engage.js";
import type { Conversation } from "./inbox.js";
import type { PostMetrics } from "./insights.js";
import type { JournalEntry, PublishJournal } from "./publish.js";

class JsonFile<T> {
  constructor(
    readonly path: string,
    private readonly empty: () => T,
  ) {}

  async read(): Promise<T> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return this.empty();
      throw e;
    }
    return JSON.parse(text) as T;
  }

  async write(value: T): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temp, this.path);
  }

  async update(change: (value: T) => void): Promise<void> {
    const value = await this.read();
    change(value);
    await this.write(value);
  }
}

type Published = Extract<JournalEntry, { state: "published" }>;

/** Publish journal kept in one JSON object, keyed by journal key. */
export class FileJournal implements PublishJournal {
  private readonly file: JsonFile<Record<string, JournalEntry>>;

  constructor(path: string) {
    this.file = new JsonFile(path, () => ({}));
  }

  async get(key: string): Promise<JournalEntry | undefined> {
    return (await this.file.read())[key];
  }

  set(key: string, entry: JournalEntry): Promise<void> {
    return this.file.update((all) => {
      all[key] = entry;
    });
  }

  clear(key: string): Promise<void> {
    return this.file.update((all) => {
      delete all[key];
    });
  }

  async published(): Promise<Published[]> {
    return (await this.publishedByKey()).map(([, entry]) => entry);
  }

  /** Published entries with their journal keys, which carry the post format. */
  async publishedByKey(): Promise<[string, Published][]> {
    const all = await this.file.read();
    return Object.entries(all).filter((pair): pair is [string, Published] => pair[1].state === "published");
  }
}

export const commentsPath = (dataDir: string) => join(dataDir, "comments.json");
export const journalPath = (dataDir: string) => join(dataDir, "publish-journal.json");
export const inboxPath = (dataDir: string) => join(dataDir, "inbox.json");
export const insightsPath = (dataDir: string) => join(dataDir, "insights.json");

const list = <T>(path: string) => new JsonFile<T[]>(path, () => []);

export const loadComments = (dataDir: string) => list<Comment>(commentsPath(dataDir)).read();
export const saveComments = (dataDir: string, comments: Comment[]) => list<Comment>(commentsPath(dataDir)).write(comments);

export const loadInbox = (dataDir: string) => list<Conversation>(inboxPath(dataDir)).read();
export const saveInbox = (dataDir: string, conversations: Conversation[]) =>
  list<Conversation>(inboxPath(dataDir)).write(conversations);

export const loadInsights = (dataDir: string) => list<PostMetrics>(insightsPath(dataDir)).read();
export const saveInsights = (dataDir: string, rows: PostMetrics[]) => list<PostMetrics>(insightsPath(dataDir)).write(rows);

/** Drafted and sent character comments (written by @hoi-sau/story, sent by `send-replies`). */
export const repliesPath = (dataDir: string) => join(dataDir, "replies.json");
export const loadReplies = (dataDir: string) => list<OutgoingComment>(repliesPath(dataDir)).read();
export const saveReplies = (dataDir: string, replies: OutgoingComment[]) => list<OutgoingComment>(repliesPath(dataDir)).write(replies);
