import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEMO, demoGraph } from "./demo.js";
import {
  BrandsError,
  FileJournal,
  GraphClient,
  MAIN_BRAND,
  brandTargets,
  channelStates,
  journalKey,
  loadBrands,
  parseBrands,
  parseJournalKey,
  publishEpisode,
  routeEpisode,
  type EpisodePost,
} from "./index.js";

const brands = loadBrands();

test("channels.yaml: Hồi Sau plus one brand per character, only names of .env variables", async () => {
  assert.deepEqual(brands.map((b) => b.id), ["hoi-sau", "lolo", "poppy", "pango", "uni", "bino", "rico"]);
  assert.equal(brands[0].kind, "series");
  assert.deepEqual(brands.filter((b) => b.kind === "character").map((b) => b.character), ["cu-li", "ca-noc", "te-te", "sao-la", "cay-muc", "chon-bac-ma"]);
  // Contest setup: Hồi Sau and Lolo are live, the rest wait.
  const live = brands.filter((b) => b.channels.some((c) => c.status === "live")).map((b) => b.id);
  assert.deepEqual(live, ["hoi-sau", "lolo"]);
  const text = await readFile(new URL("../../../channels.yaml", import.meta.url), "utf8");
  for (const b of brands) for (const c of b.channels) for (const v of Object.values(c.env)) assert.match(v!, /^[A-Z0-9_]+$/);
  assert.doesNotMatch(text, /EAA|LLM\|/); // no token values
});

test("parseBrands rejects broken config", () => {
  assert.throws(() => parseBrands("x: 1"), BrandsError);
  assert.throws(() => parseBrands("brands: [{ id: A, kind: series }]"), /lowercase/);
  assert.throws(() => parseBrands("brands: [{ id: a, kind: character }]"), /character slug/);
  assert.throws(() => parseBrands("brands: [{ id: a, kind: series }, { id: a, kind: series }]"), /twice/);
  assert.throws(() => parseBrands("brands: [{ id: a, kind: series, channels: [{ platform: tiktok, status: live }] }]"), /unknown platform/);
});

test("routeEpisode: every episode to Hồi Sau, plus the lead's brand when it has a live channel", () => {
  const ids = (lead: string, characters?: string[]) => routeEpisode(brands, { lead, characters }).map((r) => `${r.brand.id}:${r.platforms.join("+")}`);
  assert.deepEqual(ids("cu-li", ["ca-noc"]), ["hoi-sau:facebook+instagram+threads", "lolo:facebook+instagram"]);
  // Poppy's channels are paused, so her episode goes only to Hồi Sau.
  assert.deepEqual(ids("ca-noc", ["cu-li"]), ["hoi-sau:facebook+instagram+threads"]);
});

test("channelStates and brandTargets report missing .env names and skip those platforms", () => {
  const lolo = brands.find((b) => b.id === "lolo")!;
  const env = { FB_PAGE_ID_LOLO: "1", FB_PAGE_TOKEN_LOLO: "t" };
  const states = channelStates(lolo, env);
  assert.deepEqual(states.map((s) => [s.platform, s.ready, s.missing]), [
    ["facebook", true, []],
    ["instagram", false, ["IG_USER_ID_LOLO"]],
    ["threads", false, ["THREADS_USER_ID_LOLO", "THREADS_TOKEN_LOLO", "THREADS_USERNAME_LOLO"]],
  ]);
  const client = (token: string) => new GraphClient({ token });
  const res = brandTargets(lolo, env, client);
  assert.deepEqual(res.platforms, ["facebook"]);
  assert.deepEqual(res.skipped.map((s) => s.platform), ["instagram", "threads"]);
  assert.equal(res.skipped[1].reason, "paused");
  assert.equal(res.targets?.pageId, "1");
  assert.equal(brandTargets(lolo, {}, client).targets, undefined);
});

test("journal keys: the main brand keeps its old key, other brands add their id", () => {
  assert.equal(journalKey("ep-001", "facebook", "carousel-4x5"), "ep-001:facebook:carousel-4x5");
  assert.equal(journalKey("ep-001", "facebook", "carousel-4x5", MAIN_BRAND), "ep-001:facebook:carousel-4x5");
  assert.equal(journalKey("ep-001", "instagram", "reels-9x16", "lolo"), "ep-001:instagram:reels-9x16:lolo");
  assert.deepEqual(parseJournalKey("ep-001:facebook:carousel-4x5"), { episodeId: "ep-001", platform: "facebook", format: "carousel-4x5", brand: "hoi-sau" });
  assert.equal(parseJournalKey("ep-001:threads:carousel-4x5:lolo").brand, "lolo");
});

test("the same episode posts once per brand", async () => {
  const mock = demoGraph();
  const page = new GraphClient({ token: DEMO.pageToken, fetch: mock.fetch, backoffMs: 1 });
  const targets = { page, pageId: DEMO.pageId, igUserId: DEMO.igUserId };
  const journal = new FileJournal(join(await mkdtemp(join(tmpdir(), "hoisau-")), "journal.json"));
  const post: EpisodePost = {
    episodeId: "ep-001",
    format: "carousel-4x5",
    caption: "Tập 1 #hoisau",
    mediaUrls: ["https://cdn.example.com/1.jpg", "https://cdn.example.com/2.jpg"],
  };
  const main = await publishEpisode("facebook", post, targets, journal, { pollIntervalMs: 1 });
  const lolo = await publishEpisode("facebook", post, targets, journal, { pollIntervalMs: 1, brand: "lolo" });
  assert.notEqual(main.postId, lolo.postId);
  assert.equal(main.brand, undefined);
  assert.equal(lolo.brand, "lolo");
  const again = await publishEpisode("facebook", post, targets, journal, { pollIntervalMs: 1, brand: "lolo" });
  assert.equal(again.postId, lolo.postId);
  assert.deepEqual((await journal.published()).map((p) => p.brand ?? MAIN_BRAND).sort(), ["hoi-sau", "lolo"]);
});

test("a new character gets a brand of its own, once, with every channel still to set up", async () => {
  const { addCharacterBrand: add, loadBrands: load, BRANDS_FILE } = await import("./brands.js");
  const { copyFileSync } = await import("node:fs");
  const file = join(await mkdtemp(join(tmpdir(), "hoisau-brands-")), "channels.yaml");
  copyFileSync(BRANDS_FILE, file);
  const before = await readFile(file, "utf8");
  assert.equal(add({ slug: "vuon-muon", name: "Đậu Đỏ", tagline: "Đến muộn có lý do" }, file), "dau-do");
  assert.equal(add({ slug: "vuon-muon", name: "Đậu Đỏ" }, file), null, "the second time changes nothing");
  const after = await readFile(file, "utf8");
  assert.ok(after.startsWith(before), "the old file, comments included, is kept as it was");
  const b = load(file).find((x) => x.id === "dau-do")!;
  assert.equal(b.character, "vuon-muon");
  assert.ok(b.channels.every((c) => c.status === "planned"));
  assert.equal(b.channels.find((c) => c.platform === "facebook")!.env.pageId, "FB_PAGE_ID_DAU_DO");
});
