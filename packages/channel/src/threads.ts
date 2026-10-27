/**
 * Threads: publishing episodes and reading replies through graph.threads.net.
 *
 * Threads has its own login and tokens, separate from the Page token. A
 * long-lived Threads token lasts about 60 days and must be refreshed before
 * it expires (it can be refreshed once it is at least a day old).
 */

import { sleep, type GraphClient } from "./graph.js";
import type { Comment } from "./comments.js";
import type { EpisodePost } from "./publish.js";

export interface ThreadsToken {
  accessToken: string;
  expiresIn?: number;
}

/**
 * Short-lived → long-lived Threads token. Meta only accepts these inputs on the
 * query string for this endpoint and the refresh one, so the client used here
 * must not carry a token of its own.
 */
export async function exchangeThreadsLongLived(
  threads: GraphClient,
  appSecret: string,
  shortLivedToken: string,
): Promise<ThreadsToken> {
  const res = await threads.get<{ access_token: string; expires_in?: number }>("access_token", {
    grant_type: "th_exchange_token",
    client_secret: appSecret,
    access_token: shortLivedToken,
  });
  return { accessToken: res.access_token, expiresIn: res.expires_in };
}

export async function refreshThreadsToken(threads: GraphClient, longLivedToken: string): Promise<ThreadsToken> {
  const res = await threads.get<{ access_token: string; expires_in?: number }>("refresh_access_token", {
    grant_type: "th_refresh_token",
    access_token: longLivedToken,
  });
  return { accessToken: res.access_token, expiresIn: res.expires_in };
}

export async function threadsProfile(threads: GraphClient): Promise<{ id: string; username: string }> {
  return threads.get("me", { fields: "id,username" });
}

export const THREADS_REQUIRED_SCOPES = ["threads_basic", "threads_content_publish", "threads_read_replies", "threads_manage_insights"] as const;

export interface ThreadsPublishOptions {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Called with the final container ID right before the publish call. */
  beforePublish?: (containerId: string) => Promise<void>;
}

/** Creates the container(s), waits for processing, publishes. Returns post ID and permalink. */
export async function publishThreadsPost(
  threads: GraphClient,
  userId: string,
  post: EpisodePost,
  text: string,
  opts: ThreadsPublishOptions = {},
): Promise<{ postId: string; permalink?: string }> {
  let containerId: string;
  if (post.format === "carousel-4x5") {
    const children: string[] = [];
    for (const image_url of post.mediaUrls) {
      const { id } = await threads.post<{ id: string }>(`${userId}/threads`, {
        media_type: "IMAGE",
        image_url,
        is_carousel_item: true,
      });
      children.push(id);
    }
    // Carousel items must finish processing before the carousel is created.
    for (const id of children) await waitForContainer(threads, id, opts);
    ({ id: containerId } = await threads.post<{ id: string }>(`${userId}/threads`, {
      media_type: "CAROUSEL",
      children: children.join(","),
      text,
    }));
  } else if (post.format === "image-4x5") {
    ({ id: containerId } = await threads.post<{ id: string }>(`${userId}/threads`, { media_type: "IMAGE", image_url: post.mediaUrls[0], text }));
  } else {
    ({ id: containerId } = await threads.post<{ id: string }>(`${userId}/threads`, {
      media_type: "VIDEO",
      video_url: post.mediaUrls[0],
      text,
    }));
  }

  await waitForContainer(threads, containerId, opts);
  await opts.beforePublish?.(containerId);
  const { id } = await threads.post<{ id: string }>(`${userId}/threads_publish`, { creation_id: containerId });
  const { permalink } = await threads.get<{ permalink?: string }>(id, { fields: "permalink" });
  return { postId: id, permalink };
}

async function waitForContainer(threads: GraphClient, id: string, opts: ThreadsPublishOptions): Promise<void> {
  const interval = opts.pollIntervalMs ?? 5000;
  const deadline = Date.now() + (opts.pollTimeoutMs ?? 10 * 60_000);
  for (;;) {
    const { status, error_message } = await threads.get<{ status?: string; error_message?: string }>(id, {
      fields: "status,error_message",
    });
    if (status === "FINISHED" || status === "PUBLISHED") return;
    if (status === "ERROR" || status === "EXPIRED") {
      throw new Error(`Threads container ${id} is ${status}${error_message ? `: ${error_message}` : ""}.`);
    }
    if (Date.now() > deadline) throw new Error("Timed out waiting for Threads to process the media.");
    await sleep(interval);
  }
}

interface ThreadsReply {
  id: string;
  text?: string;
  timestamp: string;
  username?: string;
  replied_to?: { id: string };
  hide_status?: string;
}

/**
 * Every reply under a post, nested ones included, flattened. Our own replies
 * and replies the account has hidden are dropped.
 */
export async function fetchThreadsReplies(
  threads: GraphClient,
  ownUsername: string,
  postId: string,
): Promise<Comment[]> {
  const raw = await threads.getAll<ThreadsReply>(`${postId}/conversation`, {
    fields: "id,text,timestamp,username,replied_to,hide_status",
    reverse: false,
  });
  return raw
    .filter((r) => r.username !== ownUsername && r.text && r.hide_status !== "HIDDEN")
    .map((r) => ({
      id: r.id,
      platform: "threads" as const,
      postId,
      parentId: r.replied_to && r.replied_to.id !== postId ? r.replied_to.id : undefined,
      text: r.text!,
      author: { name: r.username ?? "threads user" },
      createdAt: r.timestamp,
    }));
}
