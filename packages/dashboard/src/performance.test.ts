import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadState } from "./data.js";
import { clipPerformance, performancePage, viewsByHour } from "./performance.js";

test("Hiệu suất: clips from the second checkout show up with their numbers, grouped per clip and by posting hour", () => {
  const root = mkdtempSync(join(tmpdir(), "perf-"));
  const own = join(root, "studio-data"), story = join(root, "story-data");
  mkdirSync(own);
  mkdirSync(story);
  writeFileSync(join(own, "publish-journal.json"), "{}");
  // Clip 10 at 20:00 Hanoi (13:00Z), clip 7 at 12:32 Hanoi; Threads gets the still.
  const pub = (postId: string, platform: string, at: string) => ({ state: "published", platform, postId, permalink: `https://x/${postId}`, publishedAt: at });
  writeFileSync(
    join(story, "publish-journal.json"),
    JSON.stringify({
      "pilot-chikhang-10:facebook:reels-9x16": pub("fb10", "facebook", "2026-11-03T13:00:05Z"),
      "pilot-chikhang-10:instagram:reels-9x16": pub("ig10", "instagram", "2026-11-03T13:00:40Z"),
      "pilot-chikhang-10-still:threads:image-4x5": pub("th10", "threads", "2026-11-03T13:01:10Z"),
      "pilot-satank-7:instagram:reels-9x16": pub("ig7", "instagram", "2026-11-02T05:32:00Z"),
    }),
  );
  writeFileSync(
    join(story, "insights.json"),
    JSON.stringify([
      { postId: "ig10", platform: "instagram", views: 190, reach: 145, reactions: 2, shares: 0, fetchedAt: "2026-11-04T00:50:00Z" },
      { postId: "th10", platform: "threads", views: 12, fetchedAt: "2026-11-04T00:50:00Z" },
      { postId: "ig7", platform: "instagram", views: 370, reach: 272, reactions: 3, shares: 1, fetchedAt: "2026-11-04T00:50:00Z" },
    ]),
  );
  // A newer pull in the dashboard's own folder wins for the same post.
  writeFileSync(join(own, "insights.json"), JSON.stringify([{ postId: "ig10", platform: "instagram", views: 200, fetchedAt: "2026-11-04T01:00:00Z" }]));

  const s = loadState({ dataDir: own, runsDir: join(root, "runs"), extraDataDirs: [story] });
  const clips = clipPerformance(s);
  assert.deepEqual(clips.map((c) => [c.id, c.hour, c.views, c.posts.length]), [["pilot-chikhang-10", 20, 212, 3], ["pilot-satank-7", 12, 370, 1]]);
  assert.equal(clips[0].label, "Clip 10 · chikhang");
  assert.equal(clips[0].posts.find((p) => p.platform === "facebook")?.views, undefined, "no numbers yet for the Facebook reel");
  const hours = viewsByHour(clips);
  assert.deepEqual([hours[12], hours[20]].map((b) => [b.clips, b.avg]), [[1, 370], [1, 212]]);
  const html = performancePage(s, { canRefresh: true });
  assert.match(html, /Cập nhật số liệu/);
  assert.match(html, /12h/, "the best hour is named");
  assert.match(html, /<svg class="hour-chart"/);
  assert.match(html, /https:\/\/x\/ig7/, "each number links to its post");
  assert.match(performancePage(s, { canRefresh: true, refreshing: true }), /http-equiv="refresh"/);
});
