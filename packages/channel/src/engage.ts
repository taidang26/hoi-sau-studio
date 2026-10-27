/**
 * Talking back to the audience, and reading how a post did.
 *
 * - Outgoing comments (data/replies.json): a first comment under a new post,
 *   or the character's reply to a commenter. Drafts are written elsewhere
 *   (@hoi-sau/story); only `approved` ones are sent, each at most once.
 * - Post insights (data/insights.json): reactions, shares, saves, reach per
 *   post, for the coach and the dashboard.
 */

import type { GraphClient } from "./graph.js";
import type { Platform } from "./index.js";

export interface OutgoingComment {
  id: string;
  /** "first" = a comment under our own post; "reply" = an answer to a commenter. */
  kind: "first" | "reply";
  platform: Platform;
  /** Post the comment belongs to. */
  postId: string;
  /** For replies: the comment being answered. */
  commentId?: string;
  /** Character slug the line is written for. */
  speaker: string;
  /** Brand whose account posted the post (channels.yaml); left out for the main brand. */
  brand?: string;
  text: string;
  status: "draft" | "approved" | "sent" | "rejected" | "failed";
  /** Why a draft looks the way it does, or why sending failed. */
  note?: string;
  createdAt: string;
  sentAt?: string;
  /** Platform id of the comment once sent. */
  sentId?: string;
}

export interface EngageTargets {
  page: GraphClient;
  igUserId?: string;
  threads?: { client: GraphClient; userId: string };
}

/** Facebook and Instagram cap comments well above this; a character line should be short anyway. */
export const MAX_COMMENT_CHARS = 500;

/** Posts one approved comment. Returns the new comment's id. */
export async function sendComment(t: EngageTargets, c: OutgoingComment): Promise<string> {
  const text = c.text.trim();
  if (!text) throw new Error("empty comment");
  if (text.length > MAX_COMMENT_CHARS) throw new Error(`comment longer than ${MAX_COMMENT_CHARS} characters`);
  const target = c.kind === "reply" ? c.commentId : c.postId;
  if (!target) throw new Error("reply without a comment id");

  if (c.platform === "facebook") {
    // A reply to a comment is a comment on that comment.
    const { id } = await t.page.post<{ id: string }>(`${target}/comments`, { message: text });
    return id;
  }
  if (c.platform === "instagram") {
    const path = c.kind === "reply" ? `${target}/replies` : `${target}/comments`;
    const { id } = await t.page.post<{ id: string }>(path, { message: text });
    return id;
  }
  if (!t.threads) throw new Error("Threads is not connected");
  // On Threads a comment is a text post replying to the post or the reply.
  const { id: container } = await t.threads.client.post<{ id: string }>(`${t.threads.userId}/threads`, {
    media_type: "TEXT",
    text,
    reply_to_id: target,
  });
  const { id } = await t.threads.client.post<{ id: string }>(`${t.threads.userId}/threads_publish`, { creation_id: container });
  return id;
}

/**
 * Sends every approved comment that has not been sent, in order. A failure is
 * recorded on that comment and the rest still go out. Returns the updated list.
 */
export async function sendApproved(
  t: EngageTargets | ((c: OutgoingComment) => EngageTargets),
  list: OutgoingComment[],
  now = () => new Date(),
): Promise<{ list: OutgoingComment[]; sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const out: OutgoingComment[] = [];
  for (const c of list) {
    if (c.status !== "approved") {
      out.push(c);
      continue;
    }
    try {
      const id = await sendComment(typeof t === "function" ? t(c) : t, c);
      out.push({ ...c, status: "sent", sentId: id, sentAt: now().toISOString(), note: undefined });
      sent++;
    } catch (e) {
      out.push({ ...c, status: "failed", note: (e as Error).message });
      failed++;
    }
  }
  return { list: out, sent, failed };
}

// ── insights ───────────────────────────────────────────────────────────────

export interface PostInsights {
  postId: string;
  platform: Platform;
  reactions?: number;
  shares?: number;
  saves?: number;
  reach?: number;
  at: string;
}

const value = (data: Array<{ name: string; values?: Array<{ value: number }>; total_value?: { value: number } }>, name: string) => {
  const m = data.find((d) => d.name === name);
  return m?.total_value?.value ?? m?.values?.[0]?.value;
};

/** Reads a metric list, skipping metrics the platform refuses for this post (old posts, reels vs carousels). */
async function metrics(g: GraphClient, path: string, names: string[]) {
  const out: Array<{ name: string; values?: Array<{ value: number }>; total_value?: { value: number } }> = [];
  for (const metric of names) {
    try {
      const { data } = await g.get<{ data: typeof out }>(path, { metric });
      out.push(...data);
    } catch {
      // One unsupported metric must not hide the others.
    }
  }
  return out;
}

export async function fetchInsights(t: EngageTargets, platform: Platform, postId: string, now = new Date()): Promise<PostInsights> {
  const at = now.toISOString();
  if (platform === "facebook") {
    const post = await t.page.get<{ reactions?: { summary?: { total_count?: number } }; shares?: { count?: number } }>(postId, {
      fields: "reactions.summary(total_count).limit(0),shares",
    });
    const m = await metrics(t.page, `${postId}/insights`, ["post_impressions_unique"]);
    return { postId, platform, reactions: post.reactions?.summary?.total_count ?? 0, shares: post.shares?.count ?? 0, reach: value(m, "post_impressions_unique"), at };
  }
  if (platform === "instagram") {
    const m = await metrics(t.page, `${postId}/insights`, ["reach", "likes", "saved", "shares"]);
    return { postId, platform, reactions: value(m, "likes"), shares: value(m, "shares"), saves: value(m, "saved"), reach: value(m, "reach"), at };
  }
  if (!t.threads) throw new Error("Threads is not connected");
  const m = await metrics(t.threads.client, `${postId}/insights`, ["views", "likes", "reposts", "quotes", "shares"]);
  const sum = (...k: string[]) => k.reduce((n, x) => n + (value(m, x) ?? 0), 0);
  return { postId, platform, reactions: value(m, "likes"), shares: sum("reposts", "quotes", "shares"), reach: value(m, "views"), at };
}
