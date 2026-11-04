/**
 * site/public/feed.json: what the home page shows under "Tập mới". Only posts
 * that are both approved (they are on /tai, so their files sit in /media/dl/)
 * and actually published somewhere, so a clip scheduled for tomorrow never
 * shows up early. Written next to /tai before every site deploy.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { journalPath, parseJournalKey, type JournalEntry, type Platform } from "@hoi-sau/channel";
import { taiUrls, type TaiItem } from "./tai.js";

export interface FeedItem {
  id: string;
  kind: "video" | "photos";
  title: string;
  /** Picture for the card: the cover, else the first photo. Absent for a video without a cover. */
  image?: string;
  video?: string;
  /** Number of pictures in a photo post. */
  count?: number;
  publishedAt: string;
  links: { platform: Platform; url: string }[];
}

const ORDER: Platform[] = ["facebook", "instagram", "threads", "tiktok"];

/** Reads each data folder's publish journal; a missing or broken file counts as empty. */
export function readJournals(dataDirs: string[]): [string, JournalEntry][] {
  const out: [string, JournalEntry][] = [];
  for (const dir of dataDirs) {
    const file = journalPath(dir);
    if (!existsSync(file)) continue;
    try {
      out.push(...Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, JournalEntry>));
    } catch {
      /* a half-written journal should not break a deploy */
    }
  }
  return out;
}

/** Approved items that went live, newest first. A Threads still (`<id>-still`) adds its link to the clip it belongs to. */
export function homeFeed(items: TaiItem[], journal: [string, JournalEntry][], limit = 24): FeedItem[] {
  const live = new Map<string, { at: string; links: Map<Platform, string> }>();
  for (const [key, entry] of journal) {
    if (entry.state !== "published" || entry.inbox) continue;
    const id = parseJournalKey(key).episodeId.replace(/-still$/, "");
    const rec = live.get(id) ?? { at: entry.publishedAt, links: new Map() };
    if (entry.publishedAt < rec.at) rec.at = entry.publishedAt;
    if (entry.permalink && !rec.links.has(entry.platform)) rec.links.set(entry.platform, entry.permalink);
    live.set(id, rec);
  }
  const feed: FeedItem[] = [];
  for (const item of items) {
    const rec = live.get(item.id);
    if (!rec) continue;
    const urls = taiUrls(item);
    feed.push({
      id: item.id,
      kind: item.kind,
      title: item.title,
      image: urls.cover ?? (item.kind === "photos" ? urls.media[0] : undefined),
      video: item.kind === "video" ? urls.media[0] : undefined,
      count: item.kind === "photos" ? urls.media.length : undefined,
      publishedAt: rec.at,
      links: ORDER.filter((p) => rec.links.has(p)).map((platform) => ({ platform, url: rec.links.get(platform)! })),
    });
  }
  return feed.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, limit);
}

/** Where each card's small picture is written, under the site folder. */
export const thumbUrl = (id: string) => `/media/home/${id}.webp`;

/**
 * Writes feed.json, plus a small 3:4 WebP per card (the middle of a 9:16 cover
 * or the first comic page), so the home page does not pull full-size covers.
 */
export async function writeHomeFeed(site: string, items: TaiItem[], dataDirs: string[]): Promise<{ file: string; feed: FeedItem[] }> {
  const feed = homeFeed(items, readJournals(dataDirs));
  const byId = new Map(items.map((i) => [i.id, i]));
  mkdirSync(join(site, "media", "home"), { recursive: true });
  for (const f of feed) {
    const item = byId.get(f.id)!;
    const src = item.cover ?? (item.kind === "photos" ? item.media[0] : undefined);
    if (!src) continue;
    try {
      await sharp(src).resize(432, 576, { fit: "cover", position: "centre" }).webp({ quality: 78 }).toFile(join(site, thumbUrl(f.id)));
      f.image = thumbUrl(f.id);
    } catch {
      /* keep the full-size picture if the thumbnail cannot be made */
    }
  }
  const file = join(site, "feed.json");
  writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString(), items: feed }, null, 1));
  return { file, feed };
}
