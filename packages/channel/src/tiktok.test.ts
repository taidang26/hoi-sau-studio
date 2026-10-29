import assert from "node:assert/strict";
import { test } from "node:test";
import {
  brandTargets,
  chunkPlan,
  exchangeTikTokCode,
  freshTikTokToken,
  GraphClient,
  parseBrands,
  postTikTokPhotos,
  postTikTokVideo,
  publishEpisode,
  PublishError,
  TikTokClient,
  TikTokError,
  tiktokAuthorizeUrl,
  tiktokEnvValues,
  tiktokScopes,
  tiktokState,
  validatePost,
} from "./index.js";
import { demoTikTok, TIKTOK_DEMO } from "./tiktok-demo.js";
import { carousel, reels, strip, tempJournal } from "./testkit.js";

const app = { clientKey: "ck", clientSecret: "cs" };
const fast = { pollIntervalMs: 1 };
const clientOf = (mock: ReturnType<typeof demoTikTok>, token?: string) => new TikTokClient({ token, fetch: mock.fetch, backoffMs: 1 });
const video = (bytes: number) => new Uint8Array(bytes);

test("the login asks for upload only in draft mode, and the state names the local port", () => {
  const state = tiktokState(8765, "abc");
  const url = new URL(tiktokAuthorizeUrl({ clientKey: "ck", redirectUri: "https://hoisau.dangtrantai.com/tiktok-callback", state, scopes: tiktokScopes("draft") }));
  assert.equal(url.origin + url.pathname, "https://www.tiktok.com/v2/auth/authorize/");
  assert.equal(url.searchParams.get("scope"), "user.info.basic,video.upload");
  assert.equal(url.searchParams.get("state"), "p8765.abc");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("disable_auto_auth"), "1");
  assert.ok(tiktokScopes("direct").includes("video.publish"));
});

test("code exchange is a form post without a token; values land under the channel's .env names", async () => {
  const mock = demoTikTok();
  const tok = await exchangeTikTokCode(clientOf(mock), app, "c0de", "https://hoisau.dangtrantai.com/tiktok-callback");
  const call = mock.calls[0];
  assert.equal(call.path, "/v2/oauth/token/");
  assert.equal((call.body as Record<string, string>).grant_type, "authorization_code");
  assert.equal(call.headers.Authorization, undefined);
  const values = tiktokEnvValues({ token: "TIKTOK_TOKEN", userId: "TIKTOK_OPEN_ID", username: "TIKTOK_NAME" }, tok, "Hồi Sau");
  assert.deepEqual(Object.keys(values).sort(), ["TIKTOK_NAME", "TIKTOK_OPEN_ID", "TIKTOK_TOKEN", "TIKTOK_TOKEN_EXPIRES", "TIKTOK_TOKEN_REFRESH", "TIKTOK_TOKEN_REFRESH_EXPIRES"]);
  assert.equal(values.TIKTOK_TOKEN_REFRESH, TIKTOK_DEMO.refreshToken);
});

test("an access token near expiry is refreshed and saved; a fresh one is used as is", async () => {
  const names = { token: "TT", userId: "TID" };
  const now = Date.parse("2026-10-28T00:00:00Z");
  const mock = demoTikTok();
  const saved: Record<string, string>[] = [];
  const fresh = { TT: "still-good", TT_EXPIRES: "2026-10-28T12:00:00Z", TT_REFRESH: "r" };
  assert.equal(await freshTikTokToken(fresh, names, app, clientOf(mock), (v) => void saved.push(v), now), "still-good");
  assert.equal(mock.calls.length, 0);
  const old = { ...fresh, TT_EXPIRES: "2026-10-28T00:05:00Z" };
  assert.equal(await freshTikTokToken(old, names, app, clientOf(mock), (v) => void saved.push(v), now), TIKTOK_DEMO.accessToken);
  assert.equal((mock.calls[0].body as Record<string, string>).grant_type, "refresh_token");
  assert.equal(saved[0].TT_REFRESH, TIKTOK_DEMO.refreshToken);
});

test("chunks: one request up to 64 MB, 10 MB chunks above with the remainder in the last", () => {
  const MB = 1024 * 1024;
  assert.deepEqual(chunkPlan(3 * MB), { chunkSize: 3 * MB, count: 1 });
  assert.deepEqual(chunkPlan(64 * MB), { chunkSize: 64 * MB, count: 1 });
  assert.deepEqual(chunkPlan(65 * MB + 7), { chunkSize: 10 * MB, count: 6 });
});

test("draft: inbox init with no caption, every byte uploaded with Content-Range, done at SEND_TO_USER_INBOX", async () => {
  const mock = demoTikTok({ statusPolls: 2 });
  const seen: string[] = [];
  const res = await postTikTokVideo(clientOf(mock, "tok"), video(4096), { mode: "draft", ...fast, beforePublish: async (id) => void seen.push(id) });
  assert.equal(res.status, "SEND_TO_USER_INBOX");
  assert.deepEqual(seen, [TIKTOK_DEMO.publishId]);
  const init = mock.calls.find((c) => c.path === "/v2/post/publish/inbox/video/init/")!;
  assert.equal(init.headers.Authorization, "Bearer tok");
  assert.deepEqual(init.body, { source_info: { source: "FILE_UPLOAD", video_size: 4096, chunk_size: 4096, total_chunk_count: 1 } });
  const put = mock.calls.find((c) => c.method === "PUT")!;
  assert.equal(put.headers["Content-Range"], "bytes 0-4095/4096");
  assert.equal(put.bytes, 4096);
});

test("direct: privacy checked against what TikTok offers, AI label on, big post id kept exact", async () => {
  const mock = demoTikTok();
  const res = await postTikTokVideo(clientOf(mock, "tok"), video(100), { mode: "direct", title: "Tập 5 #hoisau", ...fast });
  assert.equal(res.postId, TIKTOK_DEMO.postId);
  assert.equal(res.permalink, `https://www.tiktok.com/@${TIKTOK_DEMO.username}/video/${TIKTOK_DEMO.postId}`);
  const init = mock.calls.find((c) => c.path === "/v2/post/publish/video/init/")!;
  assert.deepEqual((init.body as { post_info: unknown }).post_info, { title: "Tập 5 #hoisau", privacy_level: "PUBLIC_TO_EVERYONE", is_aigc: true });

  const privateOnly = demoTikTok({ privacy: ["SELF_ONLY"] });
  await assert.rejects(postTikTokVideo(clientOf(privateOnly, "tok"), video(100), { mode: "direct", ...fast }), (e) => e instanceof TikTokError && e.code === "privacy_level_option_mismatch");
});

test("TikTok errors come back readable and are not retried when the owner must act", async () => {
  const mock = demoTikTok({ fail: "spam_risk_too_many_pending_share" });
  await assert.rejects(postTikTokVideo(clientOf(mock, "tok"), video(10), { mode: "draft", ...fast }), (e) => e instanceof TikTokError && e.kind === "permission" && /5 unfinished drafts/.test(e.message));
  assert.equal(mock.calls.filter((c) => c.path.endsWith("/init/")).length, 1);
});

test("validation: one vertical video, or 1–35 JPEG/WebP photos", () => {
  assert.deepEqual(validatePost("tiktok", reels).map((v) => v.code), []);
  assert.deepEqual(validatePost("tiktok", { ...strip, mediaUrls: ["https://hoisau.dangtrantai.com/media/ep/01.jpg"] }).map((v) => v.code), []);
  assert.deepEqual(validatePost("tiktok", strip).map((v) => v.code), ["TIKTOK_PHOTO_FORMAT"]);
  assert.deepEqual(validatePost("tiktok", { ...carousel, mediaUrls: Array(36).fill("https://hoisau.dangtrantai.com/m/1.jpg") }).map((v) => v.code), ["CAROUSEL_SIZE"]);
});

test("photos: a draft carousel pulled from the verified host, caption as title and description", async () => {
  const mock = demoTikTok();
  const urls = ["https://hoisau.web.app/media/ep-009/01.jpg", "https://hoisau.dangtrantai.com/media/ep-009/02.webp"];
  const long = "Sếp gọi lúc 5 giờ chiều".padEnd(120, "!") + "\n#hoisau #vanphong";
  const res = await postTikTokPhotos(clientOf(mock, "tok"), urls, { mode: "draft", title: long.split("\n")[0], description: long, ...fast });
  assert.equal(res.status, "SEND_TO_USER_INBOX");
  const init = mock.calls.find((c) => c.path === "/v2/post/publish/content/init/")!;
  const body = init.body as { media_type: string; post_mode: string; is_aigc: boolean; post_info: { title: string; description: string; privacy_level?: string }; source_info: { source: string; photo_images: string[]; photo_cover_index: number } };
  assert.equal(body.media_type, "PHOTO");
  assert.equal(body.post_mode, "MEDIA_UPLOAD");
  assert.equal(body.is_aigc, true);
  assert.equal(body.source_info.source, "PULL_FROM_URL");
  assert.deepEqual(body.source_info.photo_images, ["https://hoisau.dangtrantai.com/media/ep-009/01.jpg", urls[1]]);
  assert.equal(body.source_info.photo_cover_index, 0);
  assert.equal(Array.from(body.post_info.title).length, 90);
  assert.equal(body.post_info.description, long);
  assert.equal(body.post_info.privacy_level, undefined);
  // Nothing is downloaded or uploaded by us: TikTok pulls the photos.
  assert.equal(mock.calls.filter((c) => c.method === "PUT" || !c.url.startsWith("https://open.tiktokapis.com")).length, 0);
});

test("photos: direct mode posts with a privacy level and links the photo post", async () => {
  const mock = demoTikTok();
  const res = await postTikTokPhotos(clientOf(mock, "tok"), ["https://hoisau.dangtrantai.com/m/1.jpg"], { mode: "direct", title: "Tập 9", ...fast });
  const body = mock.calls.find((c) => c.path === "/v2/post/publish/content/init/")!.body as { post_mode: string; post_info: { privacy_level: string } };
  assert.equal(body.post_mode, "DIRECT_POST");
  assert.equal(body.post_info.privacy_level, "PUBLIC_TO_EVERYONE");
  assert.equal(res.permalink, `https://www.tiktok.com/@${TIKTOK_DEMO.username}/photo/${TIKTOK_DEMO.postId}`);
});

test("publishEpisode to TikTok downloads the video, leaves a draft and journals it once", async () => {
  const [brand] = parseBrands(`brands:
  - id: hoi-sau
    kind: series
    channels:
      - { platform: facebook, status: live, env: { pageId: P, token: PT } }
      - { platform: tiktok, status: live, mode: draft, env: { userId: TID, token: TT, username: TN } }
`);
  const mock = demoTikTok();
  const env = { P: "1", PT: "x", TID: TIKTOK_DEMO.openId, TT: "tok", TT_REFRESH: "r" };
  const g = () => new GraphClient({ token: "x" });
  const { targets, platforms } = brandTargets(brand, env, g, { tiktok: (t) => clientOf(mock, t) });
  assert.deepEqual(platforms, ["facebook", "tiktok"]);
  assert.equal(targets!.tiktok!.mode, "draft");
  // Without a TikTok client factory the platform is left out.
  assert.deepEqual(brandTargets(brand, env, g).platforms, ["facebook"]);

  const journal = await tempJournal();
  const res = await publishEpisode("tiktok", reels, targets!, journal, fast);
  assert.equal(res.inbox, true);
  assert.equal(res.postId, TIKTOK_DEMO.publishId);
  assert.equal(mock.calls[0].url, reels.mediaUrls[0]);
  const again = await publishEpisode("tiktok", reels, targets!, journal, fast);
  assert.equal(again.publishedAt, res.publishedAt);
  assert.equal(mock.calls.filter((c) => c.path.endsWith("/init/")).length, 1);

  await assert.rejects(publishEpisode("tiktok", strip, targets!, journal, fast), (e) => e instanceof PublishError && e.code === "TIKTOK_PHOTO_FORMAT");
  const photos = { ...carousel, episodeId: "ep-009", mediaUrls: ["https://hoisau.web.app/media/ep-009/01.jpg", "https://hoisau.web.app/media/ep-009/02.jpg"] };
  const drafted = await publishEpisode("tiktok", photos, targets!, journal, fast);
  assert.equal(drafted.inbox, true);
  const init = mock.calls.find((c) => c.path === "/v2/post/publish/content/init/")!;
  assert.equal((init.body as { post_info: { description: string } }).post_info.description, carousel.caption);
});

test("mode is only for TikTok", () => {
  assert.throws(() => parseBrands("brands: [{ id: a, kind: series, channels: [{ platform: facebook, status: live, mode: draft }] }]"), /mode is only for tiktok/);
  assert.throws(() => parseBrands("brands: [{ id: a, kind: series, channels: [{ platform: tiktok, status: live, mode: auto }] }]"), /mode/);
});
