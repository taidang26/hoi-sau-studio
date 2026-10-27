/**
 * Comments from published episodes, normalised to one shape for listening.
 * Anything the brand's own Page or account wrote is left out: the character
 * does not get a vote on its own next episode.
 */

import type { GraphClient } from "./graph.js";
import type { Platform } from "./index.js";

export interface Comment {
  /** Platform comment ID, unique per platform; used to dedupe. */
  id: string;
  platform: Platform;
  /** Post (or media) the comment is under. */
  postId: string;
  /** The comment this one answers, for replies. */
  parentId?: string;
  text: string;
  author: { id?: string; name: string; avatarUrl?: string };
  createdAt: string;
}

/** Facebook: replies come back flat thanks to filter=stream, each with its `parent`. */
export async function fetchFacebookComments(page: GraphClient, pageId: string, postId: string): Promise<Comment[]> {
  type Raw = {
    id: string;
    message?: string;
    created_time: string;
    from?: { id: string; name: string; picture?: { data?: { url?: string } } };
    parent?: { id: string };
  };
  const rows = await page.getAll<Raw>(`${postId}/comments`, {
    filter: "stream",
    order: "chronological",
    limit: 100,
    fields: "id,message,created_time,parent{id},from{id,name,picture}",
  });

  const out: Comment[] = [];
  for (const row of rows) {
    if (!row.message || row.from?.id === pageId) continue;
    out.push({
      id: row.id,
      platform: "facebook",
      postId,
      parentId: row.parent?.id,
      text: row.message,
      // Meta omits `from` when the commenter's privacy settings hide them.
      author: { id: row.from?.id, name: row.from?.name ?? "Facebook user", avatarUrl: row.from?.picture?.data?.url },
      createdAt: row.created_time,
    });
  }
  return out;
}

/** Instagram: top-level comments, with their replies nested one level down. */
export async function fetchInstagramComments(page: GraphClient, igUserId: string, mediaId: string): Promise<Comment[]> {
  type Raw = {
    id: string;
    text?: string;
    timestamp: string;
    username?: string;
    from?: { id: string; username?: string };
    replies?: { data: Raw[] };
  };
  const base = "id,text,timestamp,username,from{id,username}";
  const rows = await page.getAll<Raw>(`${mediaId}/comments`, { limit: 50, fields: `${base},replies{${base}}` });

  const toComment = (row: Raw, parentId?: string): Comment[] =>
    !row.text || row.from?.id === igUserId
      ? []
      : [
          {
            id: row.id,
            platform: "instagram",
            postId: mediaId,
            parentId,
            text: row.text,
            author: { id: row.from?.id, name: row.username ?? row.from?.username ?? "instagram user" },
            createdAt: row.timestamp,
          },
        ];

  return rows.flatMap((row) => [...toComment(row), ...(row.replies?.data ?? []).flatMap((r) => toComment(r, row.id))]);
}

/**
 * Folds freshly fetched comments into the stored list. A known ID is
 * replaced (the text may have been edited); `added` holds only new IDs.
 * The result is sorted oldest first.
 */
export function mergeComments(existing: Comment[], incoming: Comment[]): { all: Comment[]; added: Comment[] } {
  const known = new Set(existing.map((c) => c.id));
  const byId = new Map<string, Comment>();
  for (const c of [...existing, ...incoming]) byId.set(c.id, c);
  const added = [...new Map(incoming.filter((c) => !known.has(c.id)).map((c) => [c.id, c])).values()];
  const all = [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return { all, added };
}
