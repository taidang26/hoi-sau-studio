/** Shared fixtures for the channel tests: sample posts and targets wired to the demo Graph. */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO, demoGraph } from "./demo.js";
import { FileJournal, GraphClient, THREADS_BASE_URL, type EpisodePost, type Targets } from "./index.js";

const media = (name: string) => `https://cdn.example.com/lolo-ep-001/${name}`;

export const carousel: EpisodePost = {
  episodeId: "lolo-ep-001",
  format: "carousel-4x5",
  caption: "5 giờ chiều, Lolo nhận thêm một việc gấp. Tập sau ra sao? Bạn viết tiếp trong bình luận! #hoisau",
  mediaUrls: [media("1.jpg"), media("2.jpg"), media("3.jpg")],
};
export const reels: EpisodePost = { ...carousel, format: "reels-9x16", mediaUrls: [media("motion.mp4")] };
export const strip: EpisodePost = { ...carousel, format: "image-4x5", mediaUrls: [media("strip.png")] };

/** Polls immediately, so container waits do not slow the tests. */
export const fast = { pollIntervalMs: 1 };

export async function tempJournal(): Promise<FileJournal> {
  const dir = await mkdtemp(join(tmpdir(), "hoisau-channel-"));
  return new FileJournal(join(dir, "journal.json"));
}

export function demoTargets(opts?: { containerPolls?: number }): { mock: ReturnType<typeof demoGraph>; targets: Targets & { threads: NonNullable<Targets["threads"]> } } {
  const mock = demoGraph(opts);
  const client = (token: string, baseUrl?: string) => new GraphClient({ token, baseUrl, fetch: mock.fetch, backoffMs: 1 });
  return {
    mock,
    targets: {
      page: client(DEMO.pageToken),
      pageId: DEMO.pageId,
      igUserId: DEMO.igUserId,
      threads: { client: client("demo-threads-long-token", THREADS_BASE_URL), userId: DEMO.threadsUserId },
    },
  };
}
