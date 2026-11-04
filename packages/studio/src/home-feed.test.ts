import assert from "node:assert/strict";
import test from "node:test";
import { homeFeed } from "./home-feed.js";
import type { TaiItem } from "./tai.js";

const item = (id: string, kind: "video" | "photos", extra: Partial<TaiItem> = {}): TaiItem => ({
  id, kind, title: id, caption: id, approvedAt: "2026-11-01T00:00:00Z", media: kind === "video" ? ["v.mp4"] : ["a.jpg", "b.jpg"], ...extra,
});

test("home feed: only approved posts that went live, newest first, with each platform's link", () => {
  const items = [item("clip-9", "video", { cover: "c.jpg" }), item("clip-10", "video"), item("ep-7", "photos")];
  const feed = homeFeed(items, [
    ["clip-9:facebook:reels-9x16", { state: "published", platform: "facebook", postId: "1", permalink: "https://fb/1", publishedAt: "2026-11-03T05:00:00Z" }],
    ["clip-9:instagram:reels-9x16", { state: "published", platform: "instagram", postId: "2", permalink: "https://ig/2", publishedAt: "2026-11-03T05:01:00Z" }],
    ["clip-9-still:threads:image-4x5", { state: "published", platform: "threads", postId: "3", permalink: "https://th/3", publishedAt: "2026-11-03T05:02:00Z" }],
    ["clip-9:tiktok:reels-9x16", { state: "published", platform: "tiktok", postId: "4", inbox: true, publishedAt: "2026-11-03T05:03:00Z" }],
    ["clip-10:facebook:reels-9x16", { state: "publishing", startedAt: "2026-11-03T13:00:00Z" }],
    ["ep-7:instagram:carousel-4x5", { state: "published", platform: "instagram", postId: "5", permalink: "https://ig/5", publishedAt: "2026-10-30T00:00:00Z" }],
  ]);
  assert.deepEqual(feed.map((f) => f.id), ["clip-9", "ep-7"]);
  assert.deepEqual(feed[0].links.map((l) => l.platform), ["facebook", "instagram", "threads"]);
  assert.equal(feed[0].image, "/media/dl/clip-9-bia.jpg");
  assert.equal(feed[0].video, "/media/dl/clip-9.mp4");
  assert.equal(feed[1].image, "/media/dl/ep-7-01.jpg");
  assert.equal(feed[1].count, 2);
});
