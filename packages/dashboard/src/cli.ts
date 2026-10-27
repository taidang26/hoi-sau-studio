#!/usr/bin/env node
/**
 *   npm run dashboard               real data from CHANNEL_DATA_DIR (default data/)
 *   npm run dashboard -- --demo     sample data in data-demo/, nothing real touched
 *
 * PORT (default 4321) and .env are read like the other CLIs.
 */

import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GRAPH_VERSION, GraphClient, sendReply } from "@hoi-sau/channel";
import { DEMO, demoGraph } from "@hoi-sau/channel/dist/demo.js";
import { CHARACTERS_DIR, createEpisode, EPISODES_DIR, listCharacters, listEpisodes, loadProfile, mockSparkTransport, MuseSpark, openStudio, runEpisode, SERIES_DIR } from "@hoi-sau/studio";
import { Accounts } from "./accounts.js";
import { demoAnalyst, Research, seedResearch } from "./research.js";
import { t } from "./i18n.js";
import { seedLessons, writeDemoData } from "./seed.js";
import { Studio } from "./studio.js";
import { defaultPaths, startDashboard } from "./server.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function loadDotEnv(): void {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

loadDotEnv();
const demo = process.argv.includes("--demo");
const paths = defaultPaths(ROOT);
if (demo) {
  paths.dataDir = join(ROOT, "data-demo");
  writeDemoData(paths.dataDir);
  // Hồi Sau and Lolo look connected, Poppy has a Page but is paused, the rest are not set up.
  paths.env = Object.fromEntries(
    ["FB_PAGE_ID", "FB_PAGE_TOKEN", "IG_USER_ID", "THREADS_USER_ID", "THREADS_TOKEN", "THREADS_USERNAME", "FB_PAGE_ID_LOLO", "FB_PAGE_TOKEN_LOLO", "IG_USER_ID_LOLO", "FB_PAGE_ID_POPPY", "FB_PAGE_TOKEN_POPPY"].map((k) => [k, "demo"]),
  );
}

// Demo mode answers through the fake Graph API, so the 24-hour rule and errors behave like the real thing.
const env = process.env;
const mockGraph = demo || env.META_GRAPH_MOCK === "1";
const accounts = new Accounts({ envFile: join(ROOT, ".env"), dataDir: paths.dataDir, graphVersion: env.META_GRAPH_VERSION, fetch: mockGraph ? demoGraph().fetch : undefined, demo });
const demoPage = demo ? new GraphClient({ token: DEMO.pageToken, version: DEFAULT_GRAPH_VERSION, fetch: demoGraph().fetch }) : undefined;
const inbox = demoPage
  ? { send: (c: Parameters<typeof sendReply>[2], text: string) => sendReply(demoPage, DEMO.pageId, c, text) }
  : { send: (c: Parameters<typeof sendReply>[2], text: string) => accounts.send(c, text), pull: () => accounts.pullInbox() };

// Studio: the real repo folders, or copies under data-demo/studio so demo runs never touch characters/ or series/.
const studioDirs = demo
  ? { charactersDir: join(paths.dataDir, "studio", "characters"), seriesDir: join(paths.dataDir, "studio", "series"), episodesDir: join(paths.dataDir, "studio", "episodes") }
  : { charactersDir: CHARACTERS_DIR, seriesDir: SERIES_DIR, episodesDir: EPISODES_DIR };
if (demo) {
  if (!existsSync(studioDirs.charactersDir)) cpSync(CHARACTERS_DIR, studioDirs.charactersDir, { recursive: true });
  if (!existsSync(studioDirs.seriesDir)) cpSync(SERIES_DIR, studioDirs.seriesDir, { recursive: true });
  // Demo copies made before the series style existed get it now.
  if (!existsSync(join(studioDirs.seriesDir, "style.yaml"))) cpSync(join(SERIES_DIR, "style.yaml"), join(studioDirs.seriesDir, "style.yaml"));
  paths.charactersDir = studioDirs.charactersDir;
  paths.seriesDir = studioDirs.seriesDir;
  seedLessons(studioDirs.seriesDir);
}
paths.episodesDir = studioDirs.episodesDir;
paths.charactersDir ??= studioDirs.charactersDir;
const museMock = demo || env.MUSE_MOCK === "1";
if (demo) paths.brandArtDir = join(paths.dataDir, "studio", "brand-art");
const studio = new Studio({ ...studioDirs, runsDir: paths.runsDir, styleDir: demo ? join(paths.dataDir, "studio", "style") : undefined, brandArtDir: paths.brandArtDir, mock: museMock, open: (log) => openStudio({ mock: museMock, ...studioDirs, log }) });
if (demo && listEpisodes(studioDirs.episodesDir).length === 0) {
  // One finished sample episode per published demo post, so pages have comics to show.
  const samples = [
    { id: "cu-li-ep-001", lead: "cu-li", characters: ["ca-noc"], direction: "Lolo nhận việc gấp lúc 4h50 chiều, chị Poppy phồng lên", format: "strip3" as const },
    { id: "ca-noc-ep-001", lead: "ca-noc", characters: ["te-te"], direction: "Hoá đơn gửi lúc 16h59 thứ Sáu, Poppy to dần từng cỡ", format: "strip3" as const },
    { id: "te-te-ep-001", lead: "te-te", characters: ["cu-li"], direction: "Sếp lớn vào phòng, Pango cuộn tròn chắn trước cả team" },
    { id: "sao-la-ep-001", lead: "sao-la", characters: ["cu-li"], direction: "Uni bị khen giữa cuộc họp, biến mất sau chậu cây" },
  ];
  for (const [i, ep] of samples.entries()) {
    createEpisode({ ...ep, credits: i === 0 ? [{ name: "Minh Anh", comment: "Tập sau cho Lolo bị sếp gọi họp lúc 6h sáng đi 😂" }] : [] }, studioDirs.episodesDir);
    // Panel 2 of the first one fails its first review, to show a targeted redraw.
    await runEpisode({ ...openStudio({ mock: true, ...studioDirs }), spark: new MuseSpark({ apiKey: "mock", transport: mockSparkTransport({ failReview: i === 0 ? [2] : [] }).transport }) }, ep.id);
  }
}

// Tư liệu: kept under the data dir, never committed. The demo reads with fixed recipes and cannot reach Instagram.
const cast = () =>
  listCharacters(studioDirs.charactersDir).map((slug) => loadProfile(slug, studioDirs.charactersDir)).map((p) => ({ slug: p.slug, name: p.name, about: `${p.role}; ${p.core_gag}` }));
const demoReader = demoAnalyst(() => cast().map((c) => c.slug));
const research = new Research({
  dir: join(paths.dataDir, "research"),
  cast,
  analyst: museMock ? () => demoReader : () => MuseSpark.fromEnv(),
  discover: demo
    ? async () => {
        throw new Error(t("Đang xem dữ liệu mẫu nên không đọc Instagram thật."));
      }
    : (handle) => accounts.discoverInstagram(handle),
});
if (demo) await seedResearch(research);

const port = Number(process.env.PORT || 4321);
await startDashboard(
  {
    ...paths,
    inbox,
    studio,
    accounts,
    research,
    demo,
    banner: demo ? "Đang xem dữ liệu mẫu. Bài đăng, bình luận và tin nhắn ở đây là bịa, chỉ để thử giao diện." : undefined,
    channel: () => ({
      facebook: demo || Boolean(process.env.FB_PAGE_ID && process.env.FB_PAGE_TOKEN),
      instagram: demo || Boolean(process.env.IG_USER_ID),
      mock: process.env.META_GRAPH_MOCK === "1",
    }),
  },
  port,
);
console.log(`Hồi Sau dashboard${demo ? " (dữ liệu mẫu)" : ""}: http://localhost:${port}`);
console.log(`Dữ liệu: ${paths.dataDir}`);
