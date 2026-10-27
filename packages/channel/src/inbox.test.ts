import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO, demoGraph } from "./demo.js";
import { canReply, fetchConversations, GraphClient, InboxError, mergeConversations, sendReply, type Conversation } from "./index.js";

test("inbox: conversations from both platforms, own messages marked, oldest first", async () => {
  const mock = demoGraph();
  const page = new GraphClient({ fetch: mock.fetch, token: DEMO.pageToken });
  const own = [DEMO.pageId, DEMO.igUserId];
  const fb = await fetchConversations(page, DEMO.pageId, "facebook", own);
  const ig = await fetchConversations(page, DEMO.pageId, "instagram", own);
  assert.equal(fb[0].customer.name, "Lan");
  assert.deepEqual(fb[0].messages.map((m) => [m.id, m.from]), [["m_2", "customer"], ["m_3", "page"]]);
  assert.equal(fb[0].messages[0].attachments, 1);
  assert.equal(ig[0].customer.name, "linh.vp");
  assert.equal(ig[0].platform, "instagram");
  const igCall = mock.calls.find((c) => c.path.endsWith("/conversations") && c.params.platform === "instagram");
  assert.ok(igCall);
});

test("inbox: merge keeps older history and counts only new messages", () => {
  const base: Conversation = { id: "c", platform: "facebook", customer: { id: "u", name: "U" }, updatedAt: "2026-10-27T01:00:00Z", messages: [{ id: "a", from: "customer", text: "1", createdAt: "2026-10-27T01:00:00Z" }] };
  const fresh: Conversation = { ...base, updatedAt: "2026-10-27T02:00:00Z", messages: [{ id: "b", from: "customer", text: "2", createdAt: "2026-10-27T02:00:00Z" }] };
  const { all, newMessages } = mergeConversations([base], [fresh]);
  assert.equal(newMessages, 1);
  assert.deepEqual(all[0].messages.map((m) => m.id), ["a", "b"]);
});

test("inbox: replies only inside the 24-hour window, sent as RESPONSE", async () => {
  const mock = demoGraph();
  const page = new GraphClient({ fetch: mock.fetch, token: DEMO.pageToken });
  const c: Conversation = { id: "c", platform: "facebook", customer: { id: "psid_9", name: "Khách" }, updatedAt: "", messages: [{ id: "a", from: "customer", text: "hi", createdAt: "2026-10-27T01:00:00Z" }] };
  const sent = await sendReply(page, DEMO.pageId, c, "  Chào bạn ", new Date("2026-10-27T20:00:00Z"));
  assert.equal(sent.text, "Chào bạn");
  const call = mock.calls.find((x) => x.path.endsWith("/messages"))!;
  assert.equal(JSON.parse(call.params.recipient).id, "psid_9");
  assert.equal(call.params.messaging_type, "RESPONSE");

  const before = mock.calls.length;
  await assert.rejects(sendReply(page, DEMO.pageId, c, "muộn rồi", new Date("2026-10-28T01:00:01Z")), (e: unknown) => e instanceof InboxError && e.code === "OUTSIDE_WINDOW");
  await assert.rejects(sendReply(page, DEMO.pageId, c, "   ", new Date("2026-10-27T02:00:00Z")), /trống/);
  assert.equal(mock.calls.length, before, "no API call when the reply is refused");
  assert.equal(canReply({ ...c, messages: [{ id: "p", from: "page", text: "x", createdAt: "2026-10-27T01:00:00Z" }] }), false);
});
