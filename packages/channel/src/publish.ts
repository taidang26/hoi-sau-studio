/**
 * Publishing one episode to one platform of one brand.
 *
 * The journal is what keeps us from double posting. Right before the call
 * that makes a post public, the entry is set to "publishing". If that call
 * dies (a timeout, a crash) the post may or may not be live, so the next run
 * stops and asks for a human check instead of posting a second copy.
 */

import { sleep, type GraphClient } from "./graph.js";
import type { Format, Platform } from "./index.js";
import { journalKey, MAIN_BRAND } from "./brands.js";
import { publishThreadsPost } from "./threads.js";
import { postTikTokVideo, type TikTokClient, type TikTokMode } from "./tiktok.js";
import { validatePost } from "./validate.js";

export interface EpisodePost {
  /** Stable episode ID, e.g. "cu-li-ep-003". */
  episodeId: string;
  format: Format;
  caption: string;
  /** Caption overrides per platform, e.g. a short one for Threads. */
  captions?: Partial<Record<Platform, string>>;
  /**
   * Public HTTPS media: carousel images in order, a single image, or a single video.
   * A relative path such as "cu-li-ep-003/01.jpg" is read under MEDIA_BASE_URL.
   */
  mediaUrls: string[];
  /** Lead character slug and the rest of the cast, used to route the post to brands. */
  lead?: string;
  characters?: string[];
}

export interface PublishedPost {
  platform: Platform;
  postId: string;
  permalink?: string;
  publishedAt: string;
  /** Brand that posted it; absent for the main brand. */
  brand?: string;
  /** TikTok draft: waiting in the TikTok inbox for the owner to post it. postId is then the publish id. */
  inbox?: boolean;
}

export type JournalEntry =
  | { state: "publishing"; startedAt: string; containerId?: string }
  | ({ state: "published" } & PublishedPost);

export interface PublishJournal {
  get(key: string): Promise<JournalEntry | undefined>;
  set(key: string, entry: JournalEntry): Promise<void>;
}

export interface Targets {
  /** Graph client carrying the Page token (also used for Instagram). */
  page: GraphClient;
  pageId: string;
  /** Instagram professional account linked to the Page. */
  igUserId?: string;
  /** Threads profile and a client carrying its own Threads token. */
  threads?: { client: GraphClient; userId: string };
  /** TikTok account, with a client carrying its access token. */
  tiktok?: { client: TikTokClient; openId: string; mode: TikTokMode };
}

export interface PublishOptions {
  pollIntervalMs?: number;
  /** Give up waiting for Meta's media processing after this long. */
  pollTimeoutMs?: number;
  /** Brand ID from channels.yaml; each brand keeps separate journal entries. */
  brand?: string;
  /** Base for relative mediaUrls, e.g. https://hoisau.dangtrantai.com/media/. Defaults to MEDIA_BASE_URL. */
  mediaBaseUrl?: string;
  /** TikTok direct posts: privacy level, default PUBLIC_TO_EVERYONE. */
  tiktokPrivacy?: string;
}

export class PublishError extends Error {
  override name = "PublishError";

  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Absolute media URLs pass through; relative ones are resolved under the base. */
export function resolveMediaUrls(urls: string[], base = process.env.MEDIA_BASE_URL): string[] {
  return urls.map((u) => {
    if (/^https?:\/\//.test(u)) return u;
    if (!base) throw new PublishError(`Media "${u}" is a relative path but MEDIA_BASE_URL is not set.`, "NO_MEDIA_BASE_URL");
    return new URL(u.replace(/^\/+/, ""), base.endsWith("/") ? base : base + "/").href;
  });
}

export function captionFor(platform: Platform, post: EpisodePost): string {
  return post.captions?.[platform] ?? post.caption;
}

/** Called with the container (or video) ID just before the publish call. */
type BeforePublish = (containerId?: string) => Promise<void>;

interface Job {
  post: EpisodePost;
  targets: Targets;
  options: PublishOptions;
  beforePublish: BeforePublish;
}

type Publisher = (job: Job) => Promise<{ postId: string; permalink?: string; inbox?: boolean }>;

const publishers: Record<Platform, Publisher> = {
  facebook: (job) => facebookPublishers[job.post.format](job),
  instagram: (job) => publishToInstagram(job),
  threads: ({ post, targets, options, beforePublish }) => {
    if (!targets.threads) throw new PublishError("No Threads profile is configured.", "NO_THREADS_ACCOUNT");
    const { client, userId } = targets.threads;
    return publishThreadsPost(client, userId, post, post.caption, { ...options, beforePublish });
  },
  // TikTok cannot fetch from our site without domain verification, so the file is downloaded and uploaded.
  tiktok: async ({ post, targets, options, beforePublish }) => {
    if (!targets.tiktok) throw new PublishError("No TikTok account is configured.", "NO_TIKTOK_ACCOUNT");
    const { client, mode } = targets.tiktok;
    const video = await client.download(post.mediaUrls[0]);
    const res = await postTikTokVideo(client, video, { ...options, mode, title: post.caption, privacy: options.tiktokPrivacy, beforePublish });
    return { postId: res.postId ?? res.publishId, permalink: res.permalink, ...(res.status === "SEND_TO_USER_INBOX" ? { inbox: true } : {}) };
  },
};

/** Whether a platform takes this kind of post at all (TikTok: videos only). */
export const platformTakes = (platform: Platform, format: Format) => platform !== "tiktok" || format === "reels-9x16";

export async function publishEpisode(
  platform: Platform,
  episode: EpisodePost,
  targets: Targets,
  journal: PublishJournal,
  options: PublishOptions = {},
): Promise<PublishedPost> {
  const post: EpisodePost = { ...episode, caption: captionFor(platform, episode), mediaUrls: resolveMediaUrls(episode.mediaUrls, options.mediaBaseUrl) };
  const problems = validatePost(platform, post);
  if (problems.length > 0) {
    throw new PublishError(problems.map((p) => p.message).join(" "), problems[0].code);
  }

  const key = journalKey(post.episodeId, platform, post.format, options.brand);
  const previous = await journal.get(key);
  switch (previous?.state) {
    case "published":
      return previous;
    case "publishing":
      throw new PublishError(
        `${key} may already be live (started ${previous.startedAt}). Check the ${platform} account, then clear the journal entry before retrying.`,
        "MAY_BE_PUBLISHED",
      );
  }

  const beforePublish: BeforePublish = (containerId) =>
    journal.set(key, { state: "publishing", startedAt: new Date().toISOString(), containerId });

  const { postId, permalink, inbox } = await publishers[platform]({ post, targets, options, beforePublish });
  const brand = options.brand && options.brand !== MAIN_BRAND ? { brand: options.brand } : {};
  const result: PublishedPost = { platform, postId, permalink, publishedAt: new Date().toISOString(), ...brand, ...(inbox ? { inbox } : {}) };
  await journal.set(key, { state: "published", ...result });
  return result;
}

// ---------------------------------------------------------------- Facebook

async function facebookPermalink(g: GraphClient, id: string): Promise<string | undefined> {
  const { permalink_url } = await g.get<{ permalink_url?: string }>(id, { fields: "permalink_url" });
  // Reels come back with a path relative to facebook.com.
  return permalink_url ? new URL(permalink_url, "https://www.facebook.com").href : undefined;
}

const facebookPublishers: Record<Format, Publisher> = {
  // Photos are uploaded unpublished, then attached together to one feed post.
  "carousel-4x5": async ({ post, targets: { page, pageId }, beforePublish }) => {
    const attached: Record<string, string> = {};
    for (const [i, url] of post.mediaUrls.entries()) {
      const photo = await page.post<{ id: string }>(`${pageId}/photos`, { url, published: false });
      attached[`attached_media[${i}]`] = JSON.stringify({ media_fbid: photo.id });
    }
    await beforePublish();
    const feed = await page.post<{ id: string }>(`${pageId}/feed`, { message: post.caption, ...attached });
    return { postId: feed.id, permalink: await facebookPermalink(page, feed.id) };
  },

  // A single published photo is a feed post by itself; `post_id` names that post.
  "image-4x5": async ({ post, targets: { page, pageId }, beforePublish }) => {
    await beforePublish();
    const photo = await page.post<{ id: string; post_id?: string }>(`${pageId}/photos`, {
      url: post.mediaUrls[0],
      message: post.caption,
    });
    const postId = photo.post_id ?? photo.id;
    return { postId, permalink: await facebookPermalink(page, postId) };
  },

  // Reels: open an upload session, let Meta fetch the file, finish with PUBLISHED, wait for processing.
  "reels-9x16": async ({ post, targets: { page, pageId }, options, beforePublish }) => {
    const { video_id: videoId } = await page.post<{ video_id: string }>(`${pageId}/video_reels`, { upload_phase: "start" });
    await page.ruploadFromUrl(videoId, post.mediaUrls[0]);
    await beforePublish(videoId);
    await page.post(`${pageId}/video_reels`, {
      upload_phase: "finish",
      video_id: videoId,
      video_state: "PUBLISHED",
      description: post.caption,
    });
    await waitUntil(options, async () => {
      const { status } = await page.get<{ status?: { video_status?: string } }>(videoId, { fields: "status" });
      if (status?.video_status === "error") throw new PublishError("Facebook could not process the video.", "VIDEO_ERROR");
      return status?.video_status === "ready" || status?.video_status === "published";
    });
    return { postId: videoId, permalink: await facebookPermalink(page, videoId) };
  },
};

// --------------------------------------------------------------- Instagram

async function publishToInstagram({ post, targets, options, beforePublish }: Job) {
  const { page, igUserId } = targets;
  if (!igUserId) throw new PublishError("No Instagram account is configured.", "NO_IG_ACCOUNT");
  const createContainer = async (params: Record<string, string | boolean>) =>
    (await page.post<{ id: string }>(`${igUserId}/media`, params)).id;

  let container: string;
  switch (post.format) {
    case "carousel-4x5": {
      const items: string[] = [];
      for (const image_url of post.mediaUrls) items.push(await createContainer({ image_url, is_carousel_item: true }));
      container = await createContainer({ media_type: "CAROUSEL", children: items.join(","), caption: post.caption });
      break;
    }
    case "image-4x5":
      container = await createContainer({ image_url: post.mediaUrls[0], caption: post.caption });
      break;
    case "reels-9x16":
      container = await createContainer({ media_type: "REELS", video_url: post.mediaUrls[0], caption: post.caption, share_to_feed: true });
      break;
  }

  // Containers are processed in the background; publishing early is an error.
  await waitUntil(options, async () => {
    const { status_code } = await page.get<{ status_code?: string }>(container, { fields: "status_code" });
    if (status_code === "ERROR" || status_code === "EXPIRED") {
      throw new PublishError(`Instagram container ${container} is ${status_code}.`, "CONTAINER_FAILED");
    }
    return status_code === "FINISHED";
  });

  await beforePublish(container);
  const { id } = await page.post<{ id: string }>(`${igUserId}/media_publish`, { creation_id: container });
  const { permalink } = await page.get<{ permalink?: string }>(id, { fields: "permalink" });
  return { postId: id, permalink };
}

/** Instagram publishes used in the rolling 24-hour window, and the cap if Meta reports it. */
export async function instagramQuota(g: GraphClient, igUserId: string): Promise<{ used: number; total?: number }> {
  const res = await g.get<{ data: { quota_usage: number; config?: { quota_total?: number } }[] }>(
    `${igUserId}/content_publishing_limit`,
    { fields: "quota_usage,config" },
  );
  const [row] = res.data;
  return { used: row?.quota_usage ?? 0, total: row?.config?.quota_total };
}

// ----------------------------------------------------------------- helpers

/** Polls `done` until it returns true, or fails after the timeout. */
async function waitUntil(options: PublishOptions, done: () => Promise<boolean>): Promise<void> {
  const every = options.pollIntervalMs ?? 5_000;
  const giveUpAt = Date.now() + (options.pollTimeoutMs ?? 600_000);
  while (!(await done())) {
    if (Date.now() >= giveUpAt) {
      throw new PublishError("Timed out waiting for Meta to process the media.", "PROCESSING_TIMEOUT");
    }
    await sleep(every);
  }
}
