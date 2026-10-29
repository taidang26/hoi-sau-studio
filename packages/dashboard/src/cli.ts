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
import { addCharacterBrand, BRANDS_FILE, DEFAULT_GRAPH_VERSION, GraphClient, sendReply } from "@hoi-sau/channel";
import { DEMO, demoGraph } from "@hoi-sau/channel/dist/demo.js";
import { CHARACTERS_DIR, createEpisode, EPISODES_DIR, listCharacters, listEpisodes, loadProfile, mockSparkTransport, MuseSpark, openStudio, runEpisode, SERIES_DIR } from "@hoi-sau/studio";
import { Accounts } from "./accounts.js";
import { Backup } from "./backup.js";
import { demoAnalyst, Research, seedResearch } from "./research.js";
import { t } from "./i18n.js";
import { seedLessons, writeDemoData } from "./seed.js";
import { Studio } from "./studio.js";
import { mockExec, nodeExec, Videos } from "./video.js";
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

if (!demo) {
  // Every character has a channel on the Kênh page, including ones made from the command line.
  paths.brandsFile = BRANDS_FILE;
  for (const slug of listCharacters(CHARACTERS_DIR)) {
    const p = loadProfile(slug, CHARACTERS_DIR);
    const id = addCharacterBrand({ slug, name: p.name, tagline: p.office_type }, BRANDS_FILE);
    if (id) console.log(t("Đã thêm kênh {id} cho nhân vật {name}.", { id, name: p.name }));
  }
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
  // Demo copies made before the series style or the safety list existed get them now.
  for (const f of ["style.yaml", "safety.yaml"]) if (!existsSync(join(studioDirs.seriesDir, f))) cpSync(join(SERIES_DIR, f), join(studioDirs.seriesDir, f));
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
  threadsReplies: demo
    ? async () => [
        { id: "demo-1", text: "Đi làm đúng giờ tưởng mình bị phạt" },
        { id: "demo-2", text: "Ủa? Từ từ… thứ 7 cũng họp à" },
      ]
    : (brand) => accounts.threadsReplies(brand),
});
if (demo) await seedResearch(research);
// Real data only: once a week, new replies under our Threads posts become voice patterns to approve on Tư liệu.
if (!demo) {
  const learn = () =>
    research
      .learnThreads("hoi-sau")
      .then((n) => n && research.readNew("hoi-sau"))
      .catch((e) => console.error(`Threads voice: ${e instanceof Error ? e.message : e}`));
  setInterval(learn, 7 * 24 * 3600 * 1000).unref();
}

// Video: clips from a sample clip, run through packages/talk. The demo draws placeholder pictures instead.
const videos = new Videos({
  dir: join(paths.dataDir, "video"),
  episodesDir: studioDirs.episodesDir,
  siteMediaDir: join(ROOT, "site", "public", "media"),
  mediaBase: (process.env.MEDIA_BASE_URL || "https://hoisau.dangtrantai.com/media/").replace(/\/?$/, "/"),
  samplesDirs: process.env.VIDEO_SAMPLES_DIRS ? process.env.VIDEO_SAMPLES_DIRS.split(";") : [join(ROOT, "..", "Video satank"), join(ROOT, "..", "Video chimnhonho"), join(paths.dataDir, "video-samples")],
  cast: () => cast().map((c) => ({ slug: c.slug, name: c.name })),
  exec: demo ? mockExec() : nodeExec(ROOT),
  deploy: !demo,
});
if (!demo) videos.start();

const port = Number(process.env.PORT || 4321);
const host = process.env.HOST || "127.0.0.1";
const password = process.env.DASHBOARD_PASSWORD || undefined;
if (!demo && !password && !["127.0.0.1", "localhost", "::1"].includes(host)) {
  console.error(`Refusing to serve real data on ${host} without DASHBOARD_PASSWORD.`);
  process.exit(1);
}
// Real data only: what is not in git gets copied every 6 hours (Settings shows it and can run it now).
const backup = demo
  ? undefined
  : new Backup({
      sources: [paths.dataDir, studioDirs.episodesDir, studioDirs.charactersDir, join(studioDirs.seriesDir, "story-memory.json"), join(ROOT, "output")],
      dir: () => process.env.BACKUP_DIR || join(ROOT, "..", "HoiSau_Backup"),
    });
backup?.schedule((line) => console.log(line));

await startDashboard(
  {
    ...paths,
    backup,
    password,
    inbox,
    studio,
    accounts,
    research,
    videos,
    demo,
    banner: demo ? "Đang xem dữ liệu mẫu. Bài đăng, bình luận và tin nhắn ở đây là bịa, chỉ để thử giao diện." : undefined,
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
