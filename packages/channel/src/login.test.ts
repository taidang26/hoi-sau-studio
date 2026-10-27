import assert from "node:assert/strict";
import { test } from "node:test";
import { demoGraph } from "./demo.js";
import { GraphClient, LoginError, REQUIRED_SCOPES, exchangeCodeForUserToken, loginDialogUrl, waitForLoginCode } from "./index.js";

test("the login dialog asks for exactly the required scopes, or a Login for Business config", () => {
  const base = { appId: "123", redirectUri: "http://localhost:8765/callback", state: "s1", version: "v24.0" };
  const url = new URL(loginDialogUrl(base));
  assert.equal(url.origin + url.pathname, "https://www.facebook.com/v24.0/dialog/oauth");
  assert.equal(url.searchParams.get("client_id"), "123");
  assert.equal(url.searchParams.get("redirect_uri"), base.redirectUri);
  assert.equal(url.searchParams.get("state"), "s1");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.deepEqual(url.searchParams.get("scope")?.split(","), [...REQUIRED_SCOPES]);

  const business = new URL(loginDialogUrl({ ...base, configId: "cfg9" }));
  assert.equal(business.searchParams.get("config_id"), "cfg9");
  assert.equal(business.searchParams.get("scope"), null);
});

test("the code is swapped for a user token with the same redirect URI", async () => {
  const mock = demoGraph();
  const token = await exchangeCodeForUserToken(new GraphClient({ fetch: mock.fetch }), "123", "secret", "http://localhost:8765/callback", "c0de");
  assert.equal(token, "demo-short-user-token");
  assert.equal(mock.calls[0].params.redirect_uri, "http://localhost:8765/callback");
  assert.equal(mock.calls[0].headers.Authorization, undefined);
});

const port = () => 20000 + Math.floor(Math.random() * 20000);

test("the callback server returns the code, ignoring a request with the wrong state", async () => {
  const p = port();
  let ready!: () => void;
  const listening = new Promise<void>((r) => (ready = r));
  const code = waitForLoginCode({ port: p, state: "good", timeoutMs: 5000, onListening: ready });
  await listening;
  const forged = await fetch(`http://127.0.0.1:${p}/callback?state=bad&code=evil`);
  assert.equal(forged.status, 400);
  const ok = await fetch(`http://127.0.0.1:${p}/callback?state=good&code=real`);
  assert.equal(ok.status, 200);
  assert.equal(await code, "real");
});

test("a declined login is reported, not hung on", async () => {
  const p = port();
  let ready!: () => void;
  const listening = new Promise<void>((r) => (ready = r));
  const code = waitForLoginCode({ port: p, state: "s", timeoutMs: 5000, onListening: ready });
  const rejected = assert.rejects(code, (e: LoginError) => e instanceof LoginError && /Permissions error/.test(e.message));
  await listening;
  await fetch(`http://127.0.0.1:${p}/callback?error=access_denied&error_description=Permissions+error`);
  await rejected;
});
