/**
 * Talking back to the audience.
 *
 * - Outgoing comments (data/replies.json): a first comment under a new post,
 *   or the character's reply to a commenter. Drafts are written elsewhere
 *   (@hoi-sau/story); only `approved` ones are sent, each at most once.
 * Per-post numbers are read in insights.ts.
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
