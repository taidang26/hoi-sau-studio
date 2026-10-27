#!/usr/bin/env node
/**
 *   npm run dashboard               real data from CHANNEL_DATA_DIR (default data/)
 *   npm run dashboard -- --demo     sample data in data-demo/, nothing real touched
 *
 * PORT (default 4321) and .env are read like the other CLIs. HOST=0.0.0.0 opens it to
 * the network (a container); real data then needs DASHBOARD_PASSWORD, since the
 * dashboard can post to the Pages and spend API credits.
 */

import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_GRAPH_VERSION,
  GraphClient,
  fetchConversations,
  loadInbox,
  mergeConversations,
  saveInbox,
  sendReply,
} from "@hoi-sau/channel";
import { DEMO, demoGraph } from "@hoi-sau/channel/dist/demo.js";
import { CHARACTERS_DIR, createEpisode, EPISODES_DIR, listEpisodes, mockSparkTransport, MuseSpark, openStudio, runEpisode, SERIES_DIR } from "@hoi-sau/studio";
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
const pageId = demo ? DEMO.pageId : env.FB_PAGE_ID;
const token = demo ? DEMO.pageToken : env.FB_PAGE_TOKEN;
const page =
  pageId && token
    ? new GraphClient({ token, version: env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION, fetch: mockGraph ? demoGraph().fetch : undefined })
    : undefined;
const inbox =
  page && pageId
    ? {
        send: (c: Parameters<typeof sendReply>[2], text: string) => sendReply(page, pageId, c, text),
        pull: demo
          ? undefined
          : async () => {
              const own = [pageId, ...(env.IG_USER_ID ? [env.IG_USER_ID] : [])];
              let fetched = await fetchConversations(page, pageId, "facebook", own);
              if (env.IG_USER_ID) fetched = fetched.concat(await fetchConversations(page, pageId, "instagram", own));
              await saveInbox(paths.dataDir, mergeConversations(await loadInbox(paths.dataDir), fetched).all);
            },
      }
    : undefined;

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
const studio = new Studio({ ...studioDirs, runsDir: paths.runsDir, styleDir: demo ? join(paths.dataDir, "studio", "style") : undefined, mock: museMock, open: (log) => openStudio({ mock: museMock, ...studioDirs, log }) });
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

const port = Number(process.env.PORT || 4321);
const host = process.env.HOST || "127.0.0.1";
const password = process.env.DASHBOARD_PASSWORD || undefined;
if (!demo && !password && !["127.0.0.1", "localhost", "::1"].includes(host)) {
  console.error(`Refusing to serve real data on ${host} without DASHBOARD_PASSWORD.`);
  process.exit(1);
}
await startDashboard(
  {
    ...paths,
    password,
    inbox,
    studio,
    banner: demo ? "Đang xem <b>dữ liệu mẫu</b> (data-demo/). Bài đăng, bình luận và tin nhắn ở đây là bịa, chỉ để thử giao diện." : undefined,
    channel: () => ({
      facebook: demo || Boolean(process.env.FB_PAGE_ID && process.env.FB_PAGE_TOKEN),
      instagram: demo || Boolean(process.env.IG_USER_ID),
      mock: process.env.META_GRAPH_MOCK === "1",
    }),
  },
  port,
  host,
);
console.log(`Hồi Sau dashboard${demo ? " (dữ liệu mẫu)" : ""}: http://localhost:${port}`);
console.log(`Dữ liệu: ${paths.dataDir}`);
