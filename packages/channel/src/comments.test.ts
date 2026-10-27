import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO } from "./demo.js";
import { fetchFacebookComments, fetchInstagramComments, mergeComments, type Comment } from "./index.js";
import { demoTargets } from "./testkit.js";

test("Facebook comments: the Page's own reply is dropped, reply threading kept", async () => {
  const { mock, targets } = demoTargets();
  const post = `${DEMO.pageId}_42`;
  const got = await fetchFacebookComments(targets.page, DEMO.pageId, post);
  assert.deepEqual(got.map((c) => c.author.name), ["Hà", "Quân"]);
  assert.equal(got[1].parentId, got[0].id);
  assert.ok(got.every((c) => c.platform === "facebook" && c.postId === post));
  assert.equal(mock.calls[0].params.filter, "stream");
});

test("Instagram comments: nested replies flattened, our account's replies dropped", async () => {
  const { targets } = demoTargets();
  const got = await fetchInstagramComments(targets.page, DEMO.igUserId, "555");
  assert.deepEqual(got.map((c) => [c.author.name, c.parentId]), [["thu.vp", undefined]]);
});

test("merge adds only unseen IDs, updates edited text and sorts by time", () => {
  const c = (id: string, createdAt: string, text = id): Comment => ({
    id,
    platform: "facebook",
    postId: "p",
    text,
    author: { name: "x" },
    createdAt,
  });
  const first = mergeComments([], [c("b", "2026-10-27T02:00:00Z"), c("a", "2026-10-27T01:00:00Z")]);
  assert.deepEqual(first.all.map((x) => x.id), ["a", "b"]);
  assert.equal(first.added.length, 2);

  const second = mergeComments(first.all, [c("b", "2026-10-27T02:00:00Z", "edited"), c("c", "2026-10-27T03:00:00Z")]);
  assert.deepEqual(second.added.map((x) => x.id), ["c"]);
  assert.equal(second.all.find((x) => x.id === "b")?.text, "edited");
  assert.equal(second.all.length, 3);
});
