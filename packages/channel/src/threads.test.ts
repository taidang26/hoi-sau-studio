import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO, demoGraph } from "./demo.js";
import { exchangeThreadsLongLived, fetchThreadsReplies, GraphClient, publishEpisode, replyOnThreads, THREADS_BASE_URL, validatePost } from "./index.js";
import { carousel, demoTargets, fast, reels, strip, tempJournal as journal } from "./testkit.js";

test("Threads token exchange sends its inputs on the query string, to graph.threads.net", async () => {
  const mock = demoGraph();
  const g = new GraphClient({ baseUrl: THREADS_BASE_URL, fetch: mock.fetch });
  const t = await exchangeThreadsLongLived(g, "threads-secret", "short");
  assert.equal(t.accessToken, "demo-threads-long-token");
  assert.equal(mock.calls[0].params.grant_type, "th_exchange_token");
  assert.equal(mock.calls[0].headers.Authorization, undefined);
});

test("Threads carousel: items finish before the carousel, then publish", async () => {
  const { mock, targets } = demoTargets();
  const res = await publishEpisode("threads", carousel, targets, await journal(), fast);
  assert.match(res.permalink ?? "", /threads\.net/);
  const created = mock.calls.filter((c) => c.method === "POST" && c.path.endsWith("/threads"));
  assert.equal(created.length, 4);
  assert.equal(created.at(-1)?.params.media_type, "CAROUSEL");
  assert.equal(created.at(-1)?.params.text, carousel.caption);
  assert.ok(mock.calls.some((c) => c.path.endsWith("/threads_publish")));
});

test("Threads uses its own caption and enforces 500 characters", async () => {
  const { mock, targets } = demoTargets();
  const long = { ...reels, caption: "x".repeat(600) };
  assert.deepEqual(validatePost("threads", long).map((v) => v.code), ["CAPTION_TOO_LONG"]);
  await publishEpisode("threads", { ...long, captions: { threads: "Ngắn thôi #hoisau" } }, targets, await journal(), fast);
  const video = mock.calls.find((c) => c.params.media_type === "VIDEO")!;
  assert.equal(video.params.text, "Ngắn thôi #hoisau");
});

test("Threads replies: nested kept, own and hidden dropped", async () => {
  const { targets } = demoTargets();
  const replies = await fetchThreadsReplies(targets.threads.client, DEMO.threadsUsername, "777");
  assert.deepEqual(replies.map((r) => r.author.name), ["an.ng", "binh.t"]);
  assert.equal(replies[0].parentId, undefined);
  assert.equal(replies[1].parentId, replies[0].id);
});

test("a three-panel page posts as one image on Facebook, Instagram and Threads", async () => {
  const { mock, targets } = demoTargets();
  const j = await journal();
  const fb = await publishEpisode("facebook", strip, targets, j, fast);
  const photo = mock.calls.find((c) => c.path.endsWith("/photos"))!;
  assert.equal(photo.params.url, strip.mediaUrls[0]);
  assert.equal(photo.params.published, undefined, "published, not attached to a feed post");
  assert.match(fb.postId, new RegExp(`^${DEMO.pageId}_`));
  assert.ok(!mock.calls.some((c) => c.path.endsWith("/feed")));

  await publishEpisode("instagram", strip, targets, j, fast);
  const media = mock.calls.filter((c) => c.method === "POST" && c.path.endsWith("/media"));
  assert.equal(media.length, 1);
  assert.equal(media[0].params.image_url, strip.mediaUrls[0]);
  assert.equal(media[0].params.media_type, undefined);

  await publishEpisode("threads", strip, targets, j, fast);
  const created = mock.calls.filter((c) => c.method === "POST" && c.path.endsWith("/threads"));
  assert.deepEqual(created.map((c) => c.params.media_type), ["IMAGE"]);
});

test("a Threads reply goes under our own post as a TEXT container with reply_to_id", async () => {
  const { mock, targets } = demoTargets({ containerPolls: 1 });
  const r = await replyOnThreads(targets.threads.client, targets.threads.userId, "900005", "Ai sẽ báo sếp?", fast);
  assert.ok(r.postId);
  const create = mock.calls.find((c) => c.method === "POST" && c.path.endsWith("/threads"));
  assert.equal(create?.params.media_type, "TEXT");
  assert.equal(create?.params.reply_to_id, "900005");
  assert.equal(create?.params.text, "Ai sẽ báo sếp?");
});
