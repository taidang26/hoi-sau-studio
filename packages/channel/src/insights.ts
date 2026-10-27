/**
 * Per-post numbers for the coach and the dashboard: reach, reactions,
 * shares, saves and views of every published post, written to
 * data/insights.json. `@hoi-sau/story` reads the same file (its PostInsights is a subset of PostMetrics).
 *
 * Every number is best effort. A metric Meta does not offer for that kind of
 * post, or a permission the token lacks, leaves that field out and is listed
 * in `missing`, so one gap never hides the numbers that did come back.
 */

import { GraphError, type GraphClient } from "./graph.js";
import type { Platform } from "./index.js";

export interface PostMetrics {
  postId: string;
  platform: Platform;
  /** Brand that posted it; absent for the main brand. */
  brand?: string;
  /** Unique accounts reached. Threads has no reach, only views. */
  reach?: number;
  /** Likes on Instagram and Threads, all reactions on Facebook. */
  reactions?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  views?: number;
  fetchedAt: string;
  /** Fields that could not be read, with the reason. */
  missing?: string[];
}

type Numbers = Omit<PostMetrics, "postId" | "platform" | "brand" | "fetchedAt" | "missing">;

/**
 * Facebook Page reach metrics, newest first. Meta has been replacing the
 * impressions metrics with "views" ones, so the first that the API accepts
 * wins. FB_REACH_METRIC in .env overrides the list.
 */
export const FACEBOOK_REACH_METRICS = ["post_total_media_view_unique", "post_impressions_unique"];

interface InsightRow {
  name: string;
  values?: { value?: number }[];
  total_value?: { value?: number };
}

/** Reads `<id>/insights` into { metric: number }. */
async function insightValues(client: GraphClient, id: string, metrics: string[]): Promise<Record<string, number>> {
  const res = await client.get<{ data: InsightRow[] }>(`${id}/insights`, { metric: metrics.join(",") });
  const out: Record<string, number> = {};
  for (const row of res.data ?? []) {
    const value = row.total_value?.value ?? row.values?.[0]?.value;
    if (typeof value === "number") out[row.name] = value;
  }
  return out;
}

const reason = (e: unknown) => (e instanceof GraphError ? `${e.kind}: ${e.message}` : (e as Error).message);

/** Runs one read; a Graph failure becomes a `missing` note instead of an exception. Token errors still throw. */
async function attempt(missing: string[], label: string, read: () => Promise<void>): Promise<void> {
  try {
    await read();
  } catch (e) {
    if (e instanceof GraphError && e.kind === "token") throw e;
    missing.push(`${label} (${reason(e)})`);
  }
}

export async function facebookInsights(page: GraphClient, postId: string, reachMetrics = FACEBOOK_REACH_METRICS): Promise<Numbers & { missing: string[] }> {
  const out: Numbers & { missing: string[] } = { missing: [] };
  await attempt(out.missing, "shares, reactions, comments", async () => {
    const p = await page.get<{
      shares?: { count?: number };
      reactions?: { summary?: { total_count?: number } };
      comments?: { summary?: { total_count?: number } };
    }>(postId, { fields: "shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)" });
    out.shares = p.shares?.count ?? 0;
    out.reactions = p.reactions?.summary?.total_count;
    out.comments = p.comments?.summary?.total_count;
  });
  const errors: string[] = [];
  for (const metric of reachMetrics) {
    try {
      const values = await insightValues(page, postId, [metric]);
      if (metric in values) {
        out.reach = values[metric];
        break;
      }
      errors.push(`${metric}: no value`);
    } catch (e) {
      if (e instanceof GraphError && e.kind === "token") throw e;
      errors.push(`${metric}: ${reason(e)}`);
    }
  }
  if (out.reach === undefined) out.missing.push(`reach (${errors.join("; ")})`);
  return out;
}

export async function instagramInsights(page: GraphClient, mediaId: string, video = false): Promise<Numbers & { missing: string[] }> {
  const out: Numbers & { missing: string[] } = { missing: [] };
  const metrics = ["reach", "likes", "comments", "shares", "saved", ...(video ? ["views"] : [])];
  await attempt(out.missing, metrics.join(", "), async () => {
    const v = await insightValues(page, mediaId, metrics);
    out.reach = v.reach;
    out.reactions = v.likes;
    out.comments = v.comments;
    out.shares = v.shares;
    out.saves = v.saved;
    out.views = v.views;
  });
  return out;
}

export async function threadsInsights(threads: GraphClient, postId: string): Promise<Numbers & { missing: string[] }> {
  const out: Numbers & { missing: string[] } = { missing: [] };
  await attempt(out.missing, "views, likes, replies, reposts, quotes, shares", async () => {
    const v = await insightValues(threads, postId, ["views", "likes", "replies", "reposts", "quotes", "shares"]);
    out.views = v.views;
    out.reactions = v.likes;
    out.comments = v.replies;
    // A repost or a quote passes the post on, like a share.
    const passed = [v.shares, v.reposts, v.quotes].filter((n): n is number => typeof n === "number");
    if (passed.length) out.shares = passed.reduce((a, b) => a + b, 0);
  });
  return out;
}

/** Replaces stored rows by postId with fresh ones and keeps the rest. Sorted by postId for stable diffs. */
export function mergeInsights(existing: PostMetrics[], fresh: PostMetrics[]): PostMetrics[] {
  const byId = new Map(existing.map((r) => [r.postId, r]));
  for (const r of fresh) byId.set(r.postId, r);
  return [...byId.values()].sort((a, b) => (a.postId < b.postId ? -1 : a.postId > b.postId ? 1 : 0));
}
