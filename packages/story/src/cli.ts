#!/usr/bin/env node
/**
 * Story CLI.
 *
 *   npm run story -- listen [--lead <slug>] [--episode <id>] [--posts id,id] [--mock]
 *       read data/comments.json, pick the next direction, save data/listen/<id>.json
 *   npm run story -- remember <episode-id> [--mock]
 *       recap a written episode (episodes/<id>/) into series/story-memory.json
 *   npm run story -- brief <lead> [--with a,b] [--direction "…"]
 *       print the canon brief the writer gets for the next episode
 *   npm run story -- coach [--mock]
 *       score published episodes and write what worked into story memory
 *   npm run story -- memory
 *       print what the series remembers
 *   npm run story -- demo [--mock]
 *       run listening on packages/story/examples/comments.json, writing nothing
 *
 * Muse Spark Open is used when MUSE_SPARK_OPEN_URL and MUSE_SPARK_OPEN_KEY are
 * set, else Muse Spark with META_API_KEY; with neither (or --mock) it runs on
 * the offline mock.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Comment } from "@hoi-sau/channel";
import { loadMemorySync, storyBrief } from "./brief.js";
import { coach, measureEpisodes, withLessons } from "./coach.js";
import { listen } from "./listen.js";
import { type Llm, llmFromEnv, type Role } from "./llm.js";
import { episodeNumber, loadMemory, loadSeason, nextNumber, remember, saveMemory, SERIES_DIR } from "./memory.js";
import { mockLlm } from "./mock.js";
import { readEpisodeFiles, recap } from "./recap.js";
import type { BibleLike, ProfileLike } from "./schema.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function loadDotEnv(): void {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const readJson = <T>(file: string, fallback: T): T => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback);
const loadBible = (): BibleLike => parse(readFileSync(join(SERIES_DIR, "bible.yaml"), "utf8"));
const loadProfile = (slug: string): ProfileLike => {
  const file = join(ROOT, "characters", slug, "profile.yaml");
  if (!existsSync(file)) throw new Error(`no character ${slug}`);
  return parse(readFileSync(file, "utf8"));
};

function pickLlm(role: Role, mock: boolean): Llm {
  const llm = mock ? undefined : llmFromEnv(role);
  if (!llm && !mock) console.error("No MUSE_SPARK_OPEN_* or META_API_KEY set: using the offline mock.");
  return llm ?? mockLlm();
}

async function main(argv: string[]): Promise<void> {
  loadDotEnv();
  const [cmd, ...rest] = argv;
  const opts: Record<string, string> = {};
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) args.push(a);
    else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--") && a !== "--mock") opts[a] = rest[++i];
    else opts[a] = "";
  }
  const mock = "--mock" in opts || process.env.MUSE_MOCK === "1";
  const rawData = process.env.CHANNEL_DATA_DIR || "data";
  const dataDir = isAbsolute(rawData) ? rawData : join(ROOT, rawData);
  const bible = loadBible();
  const plan = loadSeason();

  if (cmd === "listen" || cmd === "demo") {
    const demo = cmd === "demo";
    const memory = await loadMemory();
    const lead = opts["--lead"] || memory.episodes[memory.episodes.length - 1]?.lead || bible.cast[0];
    const number = nextNumber(memory);
    const episodeId = opts["--episode"] || `${lead}-ep-${String(number).padStart(3, "0")}`;
    const posts = opts["--posts"]?.split(",").filter(Boolean);
    let comments = readJson<Comment[]>(demo ? join(ROOT, "packages/story/examples/comments.json") : join(dataDir, "comments.json"), []);
    if (posts?.length) comments = comments.filter((c) => posts.includes(c.postId));
    const picks = demo ? [] : readJson<Array<{ commentId: string }>>(join(dataDir, "directions.json"), []).map((d) => d.commentId);
    const llm = pickLlm("listener", mock);

    const report = await listen(comments, { bible, lead: loadProfile(lead), plan, memory, episodeNumber: episodeNumber(episodeId, memory) }, {
      llm,
      episodeId,
      editorPicks: picks,
      ownAuthorIds: [process.env.FB_PAGE_ID, process.env.IG_USER_ID, process.env.THREADS_USER_ID].filter((x): x is string => !!x),
    });
    const out = join(dataDir, "listen", `${episodeId}.json`);
    if (!demo) {
      await mkdir(join(dataDir, "listen"), { recursive: true });
      await writeFile(out, JSON.stringify(report, null, 2) + "\n");
    }

    const t = report.totals;
    console.log(`${comments.length} comments → spam ${t.spam}, toxic ${t.toxic}, duplicate ${t.duplicate}, short ${t["too-short"]}; ideas ${t.idea}, off-character ${t["off-character"]}, unsafe ${t.unsafe}  (${report.model})`);
    for (const c of report.clusters.slice(0, 5)) console.log(`  ${String(c.score).padStart(6)}  ${c.key}  ${c.authors} người  "${c.idea}"`);
    console.log(`\nPick (${report.pick.source}): ${report.pick.spec.direction}\nWhy: ${report.pick.why}`);
    if (report.pick.cameo) console.log(`Credit: ${report.pick.cameo.name} (${report.pick.cameo.credit.platform}) as ${report.pick.cameo.look}`);
    for (const r of report.rejected) console.log(`  rejected ${r.commentId}: ${r.reason} (${r.detail})`);
    if (!demo) console.log(`\nSaved ${out}\nnext: npm run studio -- episode new ${episodeId} --lead ${lead} --from-listen ${out}`);
    return;
  }

  if (cmd === "remember") {
    const id = args[0];
    if (!id) throw new Error("usage: remember <episode-id> [--mock]");
    const memory = await loadMemory();
    const files = readEpisodeFiles(join(ROOT, "episodes"), id);
    const r = await recap(pickLlm("judge", mock), files, memory, plan, episodeNumber(id, memory));
    await saveMemory(remember(memory, r));
    console.log(`#${r.episode.number} ${r.episode.title}: ${r.episode.summary}`);
    console.log(`opened ${r.threadsOpened.length}, closed ${r.threadsClosed.join(", ") || "none"}, gags ${r.gags.join(", ") || "none"}, cameos ${r.cameos.map((c) => c.name).join(", ") || "none"}`);
    return;
  }

  if (cmd === "brief") {
    const lead = args[0];
    if (!lead) throw new Error('usage: brief <lead> [--with a,b] [--direction "…"]');
    const cast = [lead, ...(opts["--with"] ?? "").split(",").filter(Boolean)];
    console.log(JSON.stringify(JSON.parse(storyBrief(bible, cast, { memory: loadMemorySync(), plan, direction: opts["--direction"] })), null, 2));
    return;
  }

  if (cmd === "coach") {
    const memory = await loadMemory();
    const stats = measureEpisodes({
      journal: readJson(join(dataDir, "publish-journal.json"), {}),
      comments: readJson<Comment[]>(join(dataDir, "comments.json"), []),
      insights: readJson(join(dataDir, "insights.json"), []),
      memory,
    });
    for (const s of stats) console.log(`${String(s.score).padStart(6)}  ${s.episodeId.padEnd(16)} ${s.authors} người, ${s.kept} bình luận, ${s.replies} trả lời  ${s.title ?? ""}`);
    const r = await coach(pickLlm("judge", mock), stats, memory);
    if (r.skipped) return console.log(`No lessons: ${r.skipped}.`);
    await saveMemory(withLessons(memory, r.lessons));
    for (const l of r.lessons) console.log(`  [${l.kind}] ${l.text}  (${l.evidence.join(", ") || "chưa có bằng chứng"})`);
    return;
  }

  if (cmd === "memory") {
    const m = await loadMemory();
    for (const e of m.episodes) console.log(`#${e.number} ${e.id} ${e.title}: ${e.summary}\n    hook: ${e.hook}`);
    const open = m.threads.filter((t) => t.status === "open");
    if (open.length) console.log(`\nOpen threads:\n${open.map((t) => `  ${t.id} (${t.opened}) ${t.text}`).join("\n")}`);
    if (m.lessons.length) console.log(`\nLessons (${m.lessonsAt}):\n${m.lessons.map((l) => `  [${l.kind}] ${l.text}`).join("\n")}`);
    if (m.cameos.length) console.log(`\nCoworkers from the audience: ${m.cameos.map((c) => `${c.name} (${c.firstEpisode})`).join(", ")}`);
    if (!m.episodes.length) console.log("Nothing remembered yet. Run `story remember <episode-id>` after studio writes an episode.");
    return;
  }

  console.log("commands: listen | remember <id> | coach | brief <lead> | memory | demo   (add --mock to run offline)");
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
