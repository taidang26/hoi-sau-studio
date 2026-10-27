import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO } from "./demo.js";
import { createMockGraph, graphError } from "./mock.js";
import { GraphClient, publishEpisode, PublishError, resolveMediaUrls, validatePost, type EpisodePost, type JournalEntry, type PublishJournal } from "./index.js";
import { carousel, demoTargets, fast, reels, strip, tempJournal } from "./testkit.js";

const codes = (platform: "facebook" | "instagram" | "threads", post: EpisodePost) => validatePost(platform, post).map((v) => v.code);

test("validation catches what Meta would reject", () => {
  for (const post of [carousel, reels, strip]) assert.deepEqual(codes("instagram", post), []);
  assert.deepEqual(codes("instagram", { ...carousel, mediaUrls: [carousel.mediaUrls[0]] }), ["CAROUSEL_SIZE"]);
  assert.deepEqual(codes("facebook", { ...carousel, mediaUrls: Array(11).fill(carousel.mediaUrls[0]) }), ["CAROUSEL_SIZE"]);
  assert.deepEqual(codes("instagram", { ...carousel, caption: "a".repeat(2201) }), ["CAPTION_TOO_LONG"]);
  // Vietnamese diacritics count once each, whatever the input normalisation.
  assert.deepEqual(codes("instagram", { ...carousel, caption: "ệ".normalize("NFD").repeat(2200) }), []);
  const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ");
  assert.deepEqual(codes("instagram", { ...carousel, caption: tags }), ["TOO_MANY_HASHTAGS"]);
  assert.deepEqual(codes("facebook", { ...carousel, caption: tags }), []);
  assert.deepEqual(codes("facebook", { ...reels, mediaUrls: ["http://cdn.example.com/x.mp4"] }), ["MEDIA_NOT_HTTPS"]);
  assert.deepEqual(codes("facebook", { ...reels, mediaUrls: [...reels.mediaUrls, ...reels.mediaUrls] }), ["REELS_ONE_VIDEO"]);
  assert.deepEqual(codes("facebook", { ...strip, mediaUrls: carousel.mediaUrls }), ["IMAGE_ONE_FILE"]);
});

test("an invalid post fails before any API call", async () => {
  const { mock, targets } = demoTargets();
  await assert.rejects(
    publishEpisode("instagram", { ...carousel, mediaUrls: [] }, targets, await tempJournal(), fast),
    (e) => e instanceof PublishError && e.code === "CAROUSEL_SIZE",
  );
  assert.equal(mock.calls.length, 0);
});

test("Facebook carousel: photos uploaded unpublished, then one feed post with all of them", async () => {
  const { mock, targets } = demoTargets();
  const res = await publishEpisode("facebook", carousel, targets, await tempJournal(), fast);
  assert.ok(res.postId.startsWith(`${DEMO.pageId}_`));
  assert.match(res.permalink ?? "", /^https:\/\/www\.facebook\.com\//);

  const photos = mock.calls.filter((c) => c.path === `${DEMO.pageId}/photos`);
  assert.deepEqual(photos.map((c) => [c.params.url, c.params.published]), carousel.mediaUrls.map((u) => [u, "false"]));
  const feed = mock.calls.find((c) => c.path === `${DEMO.pageId}/feed`);
  assert.equal(feed?.params.message, carousel.caption);
  assert.deepEqual(Object.keys(feed?.params ?? {}).filter((k) => k.startsWith("attached_media")), ["attached_media[0]", "attached_media[1]", "attached_media[2]"]);
});

test("Facebook Reels: start, Meta fetches the file, finish as published", async () => {
  const { mock, targets } = demoTargets();
  await publishEpisode("facebook", reels, targets, await tempJournal(), fast);
  const steps = mock.calls
    .filter((c) => c.path.endsWith("video_reels") || c.path.startsWith("rupload/"))
    .map((c) => c.params.upload_phase ?? `upload ${c.headers.file_url}`);
  assert.deepEqual(steps, ["start", `upload ${reels.mediaUrls[0]}`, "finish"]);
  assert.match(mock.calls.find((c) => c.path.startsWith("rupload/"))?.headers.Authorization ?? "", /^OAuth /);
});

test("Instagram: polls the container until FINISHED, only then publishes", async () => {
  const { mock, targets } = demoTargets({ containerPolls: 4 });
  const res = await publishEpisode("instagram", reels, targets, await tempJournal(), fast);
  assert.match(res.permalink ?? "", /^https:\/\/www\.instagram\.com\/p\//);
  const trace = mock.calls.map((c) => (c.params.fields === "status_code" ? "poll" : c.path.split("/").at(-1)));
  assert.deepEqual(trace.slice(0, trace.indexOf("media_publish")), ["media", "poll", "poll", "poll", "poll"]);
  assert.equal(mock.calls[0].params.media_type, "REELS");
});

test("Instagram carousel: one item container per image, then the carousel container", async () => {
  const { mock, targets } = demoTargets();
  await publishEpisode("instagram", carousel, targets, await tempJournal(), fast);
  const created = mock.calls.filter((c) => c.method === "POST" && c.path === `${DEMO.igUserId}/media`);
  assert.deepEqual(created.map((c) => c.params.is_carousel_item ?? c.params.media_type), ["true", "true", "true", "CAROUSEL"]);
  assert.equal(created[3].params.children.split(",").length, 3);
});

test("the journal makes a repeat publish a no-op", async () => {
  const { mock, targets } = demoTargets();
  const journal = await tempJournal();
  const first = await publishEpisode("facebook", carousel, targets, journal, fast);
  const callsAfterFirst = mock.calls.length;
  const again = await publishEpisode("facebook", carousel, targets, journal, fast);
  assert.equal(again.postId, first.postId);
  assert.equal(mock.calls.length, callsAfterFirst);
  assert.equal((await journal.published()).length, 1);
});

test("if the final call fails, the next run refuses instead of posting twice", async () => {
  const entries = new Map<string, JournalEntry>();
  const journal: PublishJournal = { get: async (k) => entries.get(k), set: async (k, e) => void entries.set(k, e) };
  const timeout = createMockGraph({
    "POST :ig/media": () => ({ id: "container-1" }),
    "GET :id": () => ({ status_code: "FINISHED" }),
    "POST :ig/media_publish": () => graphError(504, 2, "gateway timeout"),
  });
  const page = new GraphClient({ token: "t", fetch: timeout.fetch, backoffMs: 1, maxRetries: 0 });
  const { targets } = demoTargets();

  await assert.rejects(publishEpisode("instagram", reels, { ...targets, page }, journal, fast));
  const [entry] = entries.values();
  assert.deepEqual([entry.state, entry.state === "publishing" && entry.containerId], ["publishing", "container-1"]);

  await assert.rejects(
    publishEpisode("instagram", reels, targets, journal, fast),
    (e) => e instanceof PublishError && e.code === "MAY_BE_PUBLISHED",
  );
});

test("a missing account is a clear error", async () => {
  const { targets } = demoTargets();
  await assert.rejects(
    publishEpisode("instagram", carousel, { ...targets, igUserId: undefined }, await tempJournal(), fast),
    (e) => e instanceof PublishError && e.code === "NO_IG_ACCOUNT",
  );
});

test("relative media paths are read under the media base URL", () => {
  const base = "https://hoisau.dangtrantai.com/media";
  assert.deepEqual(resolveMediaUrls(["cu-li-ep-003/01.jpg", "https://cdn.example.com/a.jpg"], base), [
    "https://hoisau.dangtrantai.com/media/cu-li-ep-003/01.jpg",
    "https://cdn.example.com/a.jpg",
  ]);
  assert.throws(() => resolveMediaUrls(["a.jpg"], ""), /MEDIA_BASE_URL/);
});
