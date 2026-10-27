import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO, demoGraph } from "./demo.js";
import { createMockGraph, graphError } from "./mock.js";
import { classify, exchangeLongLivedUserToken, GraphClient, GraphError, inspectToken, listManagedPages, missingScopes } from "./index.js";

test("Meta error codes map to the right kind", () => {
  const cases: [number, object, string][] = [
    [400, { code: 190 }, "token"],
    [400, { code: 102 }, "token"],
    [400, { code: 100, error_subcode: 460 }, "token"],
    [403, { code: 10 }, "permission"],
    [400, { code: 230 }, "permission"],
    [400, { code: 17 }, "rate_limit"],
    [400, { code: 80004 }, "rate_limit"],
    [400, { code: 1 }, "transient"],
    [400, { code: 100, is_transient: true }, "transient"],
    [503, {}, "transient"],
    [400, { code: 100 }, "invalid"],
  ];
  for (const [status, err, kind] of cases) assert.equal(classify(status, err), kind, JSON.stringify(err));
});

test("the token is sent as a bearer header and never in the query", async () => {
  const mock = demoGraph();
  const g = new GraphClient({ token: DEMO.pageToken, fetch: mock.fetch });
  await g.get(DEMO.pageId, { fields: "id,name" });
  const [call] = mock.calls;
  assert.equal(call.headers.Authorization, `Bearer ${DEMO.pageToken}`);
  assert.deepEqual(call.params, { fields: "id,name" });
});

test("retries transient failures with backoff, gives up on the rest at once", async () => {
  let attempts = 0;
  const mock = createMockGraph({
    "GET flaky": () => (++attempts <= 2 ? graphError(503, 2, "busy") : { ok: true }),
    "GET denied": () => graphError(403, 200, "not allowed"),
    "GET down": () => graphError(500, 1, "down"),
  });
  const g = new GraphClient({ token: "t", fetch: mock.fetch, backoffMs: 1, maxRetries: 2 });

  assert.deepEqual(await g.get("flaky"), { ok: true });
  assert.equal(attempts, 3);

  await assert.rejects(g.get("denied"), (e) => e instanceof GraphError && e.kind === "permission" && !e.retryable);
  assert.equal(mock.calls.filter((c) => c.path === "denied").length, 1);

  await assert.rejects(g.get("down"), (e) => e instanceof GraphError && e.kind === "transient");
  assert.equal(mock.calls.filter((c) => c.path === "down").length, 3, "first try plus two retries");
});

test("getAll follows cursors until the last page", async () => {
  const pages: Record<string, unknown> = {
    "": { data: [1, 2], paging: { next: "x", cursors: { after: "p2" } } },
    p2: { data: [3], paging: { next: "x", cursors: { after: "p3" } } },
    p3: { data: [4], paging: { cursors: { after: "p4" } } },
  };
  const mock = createMockGraph({ "GET items": (c) => pages[c.params.after ?? ""] });
  const g = new GraphClient({ fetch: mock.fetch });
  assert.deepEqual(await g.getAll<number>("items"), [1, 2, 3, 4]);
  assert.deepEqual(await g.getAll<number>("items", {}, 3), [1, 2, 3]);
});

test("setup: short token becomes long-lived, then the Page and its Instagram are found", async () => {
  const mock = demoGraph();
  const g = new GraphClient({ fetch: mock.fetch });
  const { accessToken, expiresIn } = await exchangeLongLivedUserToken(g, "app-id", "app-secret", "short-token");
  assert.equal(accessToken, "demo-long-user-token");
  assert.ok((expiresIn ?? 0) > 86_400 * 30);
  assert.equal(mock.calls[0].headers.Authorization, undefined, "the exchange carries no bearer token");

  const [page] = await listManagedPages(g.withToken(accessToken));
  assert.deepEqual([page.id, page.name, page.accessToken, page.instagram?.id], [DEMO.pageId, DEMO.pageName, DEMO.pageToken, DEMO.igUserId]);
});

test("token check reports validity, no expiry and missing scopes", async () => {
  const g = new GraphClient({ token: "app|secret", fetch: demoGraph().fetch });
  const status = await inspectToken(g, DEMO.pageToken);
  assert.equal(status.valid, true);
  assert.equal(status.expiresAt, undefined);
  assert.deepEqual(missingScopes(status.scopes), []);
  assert.deepEqual(missingScopes(["pages_show_list"]).includes("instagram_content_publish"), true);
});

test("a Page owned by a business portfolio is found when /me/accounts is empty", async () => {
  const page = { id: "42", name: "Hồi Sau", access_token: "page-token" };
  const viaBusiness = createMockGraph({
    "GET me/accounts": () => ({ data: [] }),
    "GET me/businesses": () => ({ data: [{ id: "b1" }] }),
    "GET b1/owned_pages": () => ({ data: [page] }),
    "GET b1/client_pages": () => ({ data: [page] }),
  });
  const found = await listManagedPages(new GraphClient({ token: "u", fetch: viaBusiness.fetch }));
  assert.deepEqual(found.map((p) => p.id), ["42"]);

  const direct = createMockGraph({
    "GET me/accounts": () => ({ data: [] }),
    "GET me/businesses": () => graphError(403, 200, "needs business_management"),
    "GET 42": () => page,
  });
  const [byId] = await listManagedPages(new GraphClient({ token: "u", fetch: direct.fetch }), { pageId: "42" });
  assert.equal(byId.accessToken, "page-token");
});
