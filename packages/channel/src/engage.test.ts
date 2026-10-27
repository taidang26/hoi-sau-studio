import assert from "node:assert/strict";
import { test } from "node:test";
import { GraphClient, sendApproved, THREADS_BASE_URL, type OutgoingComment } from "./index.js";
import { createMockGraph, graphError } from "./mock.js";

function setup(routes: Parameters<typeof createMockGraph>[0]) {
  const mock = createMockGraph(routes);
  const page = new GraphClient({ token: "page", fetch: mock.fetch, backoffMs: 1, maxRetries: 0 });
  const threads = { client: new GraphClient({ token: "th", baseUrl: THREADS_BASE_URL, fetch: mock.fetch, backoffMs: 1, maxRetries: 0 }), userId: "TU" };
  return { mock, t: { page, igUserId: "IG", threads } };
}

const draft = (over: Partial<OutgoingComment>): OutgoingComment => ({
  id: "r1",
  kind: "reply",
  platform: "facebook",
  postId: "P",
  commentId: "C",
  speaker: "cu-li",
  text: "Dạ em nhớ rồi ạ…",
  status: "approved",
  createdAt: "2026-11-02T00:00:00Z",
  ...over,
});

test("approved comments go to the right endpoint per platform; drafts and sent ones stay put", async () => {
  const { mock, t } = setup({
    "POST :id/comments": (_c, a) => ({ id: `fbc-${a.id}` }),
    "POST :id/replies": (_c, a) => ({ id: `igr-${a.id}` }),
    "POST TU/threads": () => ({ id: "container" }),
    "POST TU/threads_publish": () => ({ id: "thr-1" }),
  });
  const list = [
    draft({ id: "a" }),
    draft({ id: "b", kind: "first", commentId: undefined, postId: "POST1" }),
    draft({ id: "c", platform: "instagram" }),
    draft({ id: "d", platform: "threads", kind: "first", commentId: undefined, postId: "T1" }),
    draft({ id: "e", status: "draft" }),
    draft({ id: "f", status: "sent", sentId: "old" }),
  ];
  const r = await sendApproved(t, list, () => new Date("2026-11-02T01:00:00Z"));
  assert.equal(r.sent, 4);
  assert.deepEqual(r.list.map((c) => [c.id, c.status, c.sentId]), [
    ["a", "sent", "fbc-C"],
    ["b", "sent", "fbc-POST1"],
    ["c", "sent", "igr-C"],
    ["d", "sent", "thr-1"],
    ["e", "draft", undefined],
    ["f", "sent", "old"],
  ]);
  const thread = mock.calls.find((c) => c.path === "TU/threads")!;
  assert.deepEqual([thread.params.media_type, thread.params.reply_to_id], ["TEXT", "T1"]);
  assert.equal(mock.calls.find((c) => c.path === "C/comments")!.params.message, "Dạ em nhớ rồi ạ…");
});

test("a failed comment is marked and the rest still go out", async () => {
  const { t } = setup({
    "POST BAD/comments": () => graphError(400, 200, "Permissions error"),
    "POST :id/comments": () => ({ id: "ok" }),
  });
  const r = await sendApproved(t, [draft({ id: "x", commentId: "BAD" }), draft({ id: "y" }), draft({ id: "z", text: "  " })]);
  assert.deepEqual(r.list.map((c) => c.status), ["failed", "sent", "failed"]);
  assert.match(r.list[0].note!, /Permissions/);
  assert.equal(r.failed, 2);
});

test("each comment can go out from its own brand's account", async () => {
  const main = setup({ "POST :id/comments": () => ({ id: "from-main" }) });
  const lolo = setup({ "POST :id/comments": () => ({ id: "from-lolo" }) });
  const r = await sendApproved((c) => (c.brand === "lolo" ? lolo.t : main.t), [draft({ id: "a" }), draft({ id: "b", brand: "lolo" })]);
  assert.deepEqual(r.list.map((c) => c.sentId), ["from-main", "from-lolo"]);
});
