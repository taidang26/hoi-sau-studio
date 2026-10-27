import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO } from "./demo.js";
import { createMockGraph, graphError } from "./mock.js";
import { GraphClient, GraphError, facebookInsights, instagramInsights, mergeInsights, threadsInsights, type PostMetrics } from "./index.js";
import { demoTargets } from "./testkit.js";

const post = `${DEMO.pageId}_42`;

test("Facebook: shares, reactions and comments from the post, reach from the first metric Meta accepts", async () => {
  const { mock, targets } = demoTargets();
  const got = await facebookInsights(targets.page, post);
  assert.deepEqual(got, { missing: [], shares: 7, reactions: 96, comments: 18, reach: 1200 });
  assert.equal(mock.calls.filter((c) => c.path.endsWith("/insights")).length, 1);
});

test("Facebook: a renamed reach metric falls through to the next one", async () => {
  const { targets } = demoTargets();
  const got = await facebookInsights(targets.page, post, ["page_reach_that_does_not_exist", "post_impressions_unique"]);
  assert.equal(got.reach, 1180);
  assert.deepEqual(got.missing, []);
});

test("Facebook: no reach metric works, the other numbers still come back", async () => {
  const { targets } = demoTargets();
  const got = await facebookInsights(targets.page, post, ["nope"]);
  assert.equal(got.reach, undefined);
  assert.equal(got.shares, 7);
  assert.match(got.missing[0], /^reach \(nope: invalid: \(#100\) Invalid metric: nope\)$/);
});

test("Instagram: likes become reactions, saved becomes saves; views only for Reels", async () => {
  const { mock, targets } = demoTargets();
  const photo = await instagramInsights(targets.page, "555");
  assert.deepEqual(photo, { missing: [], reach: 830, reactions: 57, comments: 12, shares: 9, saves: 14, views: undefined });
  const reel = await instagramInsights(targets.page, "556", true);
  assert.equal(reel.views, 2100);
  assert.equal(mock.calls.at(-1)?.params.metric, "reach,likes,comments,shares,saved,views");
});

test("Threads: reposts and quotes count as shares; no reach", async () => {
  const { targets } = demoTargets();
  const got = await threadsInsights(targets.threads.client, "777");
  assert.deepEqual(got, { missing: [], views: 640, reactions: 41, comments: 9, shares: 6 });
});

test("a missing permission is noted, a dead token still throws", async () => {
  const noPermission = createMockGraph({ "GET :id/insights": () => graphError(403, 10, "Requires instagram_manage_insights") });
  const page = new GraphClient({ token: "t", fetch: noPermission.fetch, backoffMs: 1 });
  const got = await instagramInsights(page, "555");
  assert.equal(got.reach, undefined);
  assert.match(got.missing[0], /permission: Requires instagram_manage_insights/);

  const dead = createMockGraph({ "GET :id/insights": () => graphError(400, 190, "Session expired") });
  await assert.rejects(
    instagramInsights(new GraphClient({ token: "t", fetch: dead.fetch, backoffMs: 1 }), "555"),
    (e: unknown) => e instanceof GraphError && e.kind === "token",
  );
});

test("merge replaces rows by post and keeps the others", () => {
  const row = (postId: string, shares: number): PostMetrics => ({ postId, platform: "facebook", shares, fetchedAt: "2026-10-28T00:00:00Z" });
  const merged = mergeInsights([row("b", 1), row("a", 1)], [row("b", 5), row("c", 2)]);
  assert.deepEqual(merged.map((r) => [r.postId, r.shares]), [["a", 1], ["b", 5], ["c", 2]]);
});
