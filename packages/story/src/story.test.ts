import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Comment } from "@hoi-sau/channel";
import {
  actFor,
  askJson,
  checkLessons,
  coach,
  measureEpisodes,
  withLessons,
  availableGags,
  ChatLlm,
  checkScores,
  displayName,
  emptyMemory,
  extractJson,
  fold,
  listen,
  type ListenContext,
  llmFromEnv,
  loadMemory,
  loadMemorySync,
  loadSeason,
  milestonesFor,
  mockLlm,
  readEpisodeFiles,
  recap,
  remember,
  type Remembered,
  saveMemory,
  screen,
  storyBrief,
  type BibleLike,
  type Llm,
  type ProfileLike,
} from "./index.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const bible = parse(readFileSync(join(ROOT, "series", "bible.yaml"), "utf8")) as BibleLike;
const plan = loadSeason(join(ROOT, "series"))!;
const cuLi = parse(readFileSync(join(ROOT, "characters", "cu-li", "profile.yaml"), "utf8")) as ProfileLike;
const examples = JSON.parse(readFileSync(join(ROOT, "packages", "story", "examples", "comments.json"), "utf8")) as Comment[];

const comment = (id: string, text: string, author = id, extra: Partial<Comment> = {}): Comment => ({
  id,
  platform: "facebook",
  postId: "p1",
  text,
  author: { id: `u-${author}`, name: author },
  createdAt: `2026-11-02T08:00:${id.padStart(2, "0").slice(-2)}Z`,
  ...extra,
});

const ctx = (over: Partial<ListenContext> = {}): ListenContext => ({ bible, lead: cuLi, plan, memory: emptyMemory(), episodeNumber: 1, ...over });

// ── text ───────────────────────────────────────────────────────────────────

test("folding drops diacritics and squeezes repeated letters", () => {
  assert.equal(fold("Đi làm ĐÚNG giờ!!! hahaaaa"), "di lam dung gio haha");
  assert.equal(displayName("Nguyễn Thị Lan"), "Lan");
  assert.equal(displayName("@hoang.anh.99"), "hoang.anh.99");
});

// ── screen ─────────────────────────────────────────────────────────────────

test("rules catch spam and toxic comments without flagging ordinary words", () => {
  const { kept, rejected } = screen([
    comment("1", "Xem thêm tại shopxinh.vn nha"),
    comment("2", "Liên hệ 0912.345.678 để nhận quà"),
    comment("3", "check ib shop ơi"),
    comment("4", "nhạt vl"),
    comment("5", "đéo hài"),
    comment("6", "bọn bắc kỳ"),
    comment("7", "Cu Li lớn rồi mà các buổi họp vẫn ngủ gật"),
    comment("8", "😂😂"),
    comment("9", "ad cho Cu Li đi team building đi", "x"),
    comment("10", "ad cho Cu Li đi team building đi", "x"),
    comment("11", "Page tự comment", "page", { author: { id: "PAGE", name: "Hồi Sau" } }),
  ], { ownAuthorIds: ["PAGE"] });
  const why = Object.fromEntries(rejected.map((r) => [r.commentId, r.reason]));
  assert.deepEqual(why, { "1": "spam", "2": "spam", "3": "spam", "4": "toxic", "5": "toxic", "6": "toxic", "8": "too-short", "10": "duplicate", "11": "self" });
  assert.deepEqual(kept.map((c) => c.id), ["7", "9"]);
});

test("the same long text pasted by different accounts counts once", () => {
  const text = "Cho Cu Li được tăng lương đi mà, làm việc chăm chỉ quá trời luôn ạ";
  const { kept, rejected } = screen([comment("1", text, "a"), comment("2", text, "b"), comment("3", "cho Cu Li tăng lương", "c"), comment("4", "cho Cu Li tăng lương", "d")]);
  assert.deepEqual(rejected.map((r) => r.commentId), ["2"]);
  assert.equal(kept.length, 3);
});

// ── listen ─────────────────────────────────────────────────────────────────

test("listening picks the idea most people want and credits its best comment", async () => {
  const llm = mockLlm();
  const report = await listen(examples, ctx(), { llm, episodeId: "cu-li-ep-002" });

  assert.equal(report.totals.pulled, 22);
  assert.equal(report.totals.spam, 2);
  assert.equal(report.totals.toxic, 2);
  assert.equal(report.pick.source, "audience");
  assert.equal(report.clusters[0].key, "ngu-gat");
  assert.ok(report.clusters[0].authors >= 3);
  assert.match(report.pick.spec.direction, /ngủ gật/);
  assert.match(report.pick.spec.direction, /khán giả cùng đề xuất/);

  // Credit: first name only, drawn as an animal from words, linked to the comment.
  assert.deepEqual(report.pick.spec.credits, [{ name: "Lan", comment: examples[0].text }]);
  assert.equal(report.pick.cameo?.credit.commentId, "c01");
  assert.equal(report.pick.cameo?.firstEpisode, "cu-li-ep-002");
  assert.doesNotMatch(report.pick.cameo!.look, /photo|Nguyễn/);

  // Unsafe and off-character ideas never reach a cluster.
  const clustered = new Set(report.clusters.flatMap((c) => c.commentIds));
  for (const id of ["c18", "c19", "c09", "c11"]) assert.ok(!clustered.has(id), id);

  // The model sees the lead's limits and the season act, and never sees author names.
  const call = llm.calls[0];
  assert.match(call.system, /KHÔNG BAO GIỜ/);
  assert.match(call.system, /Ngày thường ở tầng 7/);
  assert.doesNotMatch(call.user, /Nguyễn Thị Lan/);
});

test("an editor's pick on the dashboard wins, unless it is spam or toxic", async () => {
  const llm = mockLlm();
  const picked = await listen(examples, ctx(), { llm, episodeId: "e", editorPicks: ["c06"] });
  assert.equal(picked.pick.source, "editor");
  assert.match(picked.pick.spec.direction, /máy in/);
  assert.equal(picked.pick.cameo?.name, "mai.ngoc");

  const blocked = await listen(examples, ctx(), { llm, episodeId: "e", editorPicks: ["c11"] });
  assert.equal(blocked.pick.source, "audience");
});

test("with no usable ideas the season plan gives the direction", async () => {
  const report = await listen([comment("1", "hay quá ad ơi"), comment("2", "đỉnh")], ctx({ episodeNumber: 7 }), { llm: mockLlm(), episodeId: "e" });
  assert.equal(report.pick.source, "season");
  assert.deepEqual(report.pick.spec.credits, []);
  assert.ok(actFor(plan, 7).must_happen.some((m) => report.pick.spec.direction.startsWith(m)));
});

test("an idea that repeats a told episode ranks lower", async () => {
  const memory = emptyMemory();
  memory.episodes.push({ id: "e1", number: 1, lead: "cu-li", characters: ["cu-li"], title: "Cu Li ngủ gật", summary: "Sếp bắt gặp Cu Li ngủ gật trên bàn phím.", hook: "", fromComments: [], at: "" });
  const report = await listen(examples, ctx({ memory, episodeNumber: 2 }), { llm: mockLlm(), episodeId: "e2" });
  assert.notEqual(report.clusters[0].key, "ngu-gat");
});

test("scores are checked: unknown ids dropped, values clamped, missing items retried", () => {
  const out = checkScores({ items: [{ commentId: "a", verdict: "idea", idea: "X", cluster: "Sếp Bắt Gặp", scores: { fun: 9, fit: -1, fresh: "3" } }, { commentId: "zz" }] }, ["a"]);
  assert.deepEqual(out, [{ commentId: "a", verdict: "idea", idea: "X", cluster: "sep-bat-gap", scores: { fun: 5, fit: 0, fresh: 3 }, reason: "" }]);
  assert.throws(() => checkScores({ items: [] }, ["a", "b"]), /missing items/);
  assert.equal(checkScores({ items: [{ commentId: "a", verdict: "idea", idea: "" }] }, ["a"])[0].verdict, "reaction");
});

// ── llm ────────────────────────────────────────────────────────────────────

test("JSON is pulled out of fences and prose, and a bad reply gets one repair turn", async () => {
  assert.deepEqual(extractJson('Đây: ```json\n{"a": "}"}\n``` xong'), { a: "}" });
  assert.deepEqual(extractJson('ok [1, {"b": [2]}] trailing'), [1, { b: [2] }]);

  const replies = ["xin lỗi, không có JSON", '{"n": 1}'];
  const users: string[] = [];
  const llm: Llm = { model: "t", complete: async (r) => (users.push(r.user), { text: replies.shift()! }) };
  assert.deepEqual(await askJson(llm, { task: "t", system: "", user: "q" }, (v) => v), { n: 1 });
  assert.match(users[1], /bị lỗi: no JSON/);
});

test("chat client posts to /chat/completions and retries 429", async () => {
  const seen: Array<{ url: string; body: any }> = [];
  const statuses = [429, 200];
  const llm = new ChatLlm({
    apiKey: "k",
    baseUrl: "https://example.test/v1/",
    model: "m",
    sleep: async () => {},
    transport: async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body) });
      const status = statuses.shift()!;
      return { status, json: async () => (status === 200 ? { choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 3 } } : { error: { message: "slow down" } }) };
    },
  });
  const r = await llm.complete({ task: "t", system: "s", user: "u" });
  assert.equal(r.text, "hi");
  assert.equal(r.usage?.input_tokens, 3);
  assert.equal(seen[0].url, "https://example.test/v1/chat/completions");
  assert.deepEqual(seen[0].body.messages.map((m: any) => m.role), ["system", "user"]);
});

test("listening prefers Muse Spark Open, then Muse Spark, then nothing", () => {
  assert.equal(llmFromEnv("listener", { MUSE_SPARK_OPEN_URL: "https://b", MUSE_SPARK_OPEN_KEY: "k", META_API_KEY: "m" })?.model, "meta-models/muse-spark-open-1026");
  assert.equal(llmFromEnv("listener", { META_API_KEY: "m" })?.model, "muse-spark-1.3");
  assert.equal(llmFromEnv("writer", { META_API_KEY: "m", MUSE_WRITER_MODEL: "muse-wonder" })?.model, "muse-wonder");
  assert.equal(llmFromEnv("judge", {}), undefined);
});

// ── memory and season ──────────────────────────────────────────────────────

test("the season plan covers 30 episodes in order and milestones parse", () => {
  assert.equal(plan.acts[0].episodes[0], 1);
  for (let i = 1; i < plan.acts.length; i++) assert.equal(plan.acts[i].episodes[0], plan.acts[i - 1].episodes[1] + 1);
  assert.equal(plan.acts.at(-1)!.episodes[1], plan.episodes);
  assert.equal(actFor(plan, 10).id, "a2");
  assert.equal(actFor(plan, 99).id, "a5");
  assert.deepEqual(milestonesFor(bible.season.milestones, 10), { now: ["Tập 10 sếp giao dự án Tết"], next: "Tập 20 dự án gặp sự cố lớn" });
  for (const g of plan.running_gags) assert.ok(g.cues.length, g.id);
});

const recalled = (id: string, number: number, over: Partial<Remembered> = {}): Remembered => ({
  episode: { id, number, lead: "cu-li", characters: ["cu-li"], title: `Tập ${number}`, summary: "…", hook: `Hỏi ${number}?`, fromComments: [] },
  threadsOpened: [{ text: `Hỏi ${number}?`, characters: ["cu-li"] }],
  threadsClosed: [],
  gags: [],
  cameos: [],
  ...over,
});

test("memory grows per episode, closes threads, and remembering twice changes nothing", () => {
  let m = remember(emptyMemory(), recalled("e1", 1, { gags: ["may-ca-phe"] }));
  m = remember(m, recalled("e2", 2, { threadsClosed: ["t1"] }));
  assert.deepEqual(m.threads.map((t) => [t.id, t.status, t.closed]), [["t1", "closed", "e2"], ["t2", "open", undefined]]);
  assert.deepEqual(remember(m, recalled("e2", 2, { threadsClosed: ["t1"] })).threads, m.threads);
  // Rewriting e2 so it no longer answers t1 reopens it.
  assert.equal(remember(m, recalled("e2", 2)).threads[0].status, "open");
  assert.equal(m.gagsUsed["may-ca-phe"], 1);
  assert.ok(!availableGags(plan, m, 3, ["cu-li"]).some((g) => g.id === "may-ca-phe"));
  assert.ok(availableGags(plan, m, 5, ["cu-li"]).some((g) => g.id === "may-ca-phe"));
  assert.ok(!availableGags(plan, m, 5, ["cu-li"]).some((g) => g.id === "check-lai"));
});

test("memory saves and loads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hoisau-story-"));
  assert.deepEqual(await loadMemory(dir), emptyMemory());
  const m = remember(emptyMemory(), recalled("e1", 1));
  await saveMemory(m, dir);
  assert.deepEqual(loadMemorySync(dir), m);
});

// ── brief ──────────────────────────────────────────────────────────────────

test("the brief carries this cast only, the act, how the last episode ended, and related canon", () => {
  const b: BibleLike = {
    ...bible,
    canon: [
      ...Array.from({ length: 30 }, (_, i) => ({ episode: `e${i}`, fact: `Chuyện vặt số ${i}`, characters: ["ca-noc"] })),
      { episode: "e0", fact: "Máy in tầng 7 chỉ chạy khi Cu Li hát", characters: ["cu-li", "sao-la"] },
      { episode: "e1", fact: "Sao La có một cái ô màu tím", characters: ["sao-la"] },
    ],
  };
  const memory = remember(emptyMemory(), recalled("e5", 5));
  const brief = JSON.parse(storyBrief(b, ["cu-li", "ca-noc"], { memory, plan, direction: "máy in kẹt giấy" }));

  assert.equal(brief.season.episode, 6);
  assert.equal(brief.season.act.title, "Trước cơn bão");
  assert.deepEqual(brief.previously, { episode: 5, title: "Tập 5", ended_on: "Hỏi 5?" });
  assert.deepEqual(brief.open_threads.map((t: any) => t.text), ["Hỏi 5?"]);
  assert.equal(brief.canon.length, 20);
  // Related to the direction, so it survives the cut even though it is old; other cast stripped.
  assert.deepEqual(brief.canon.find((f: any) => f.fact.startsWith("Máy in")).characters, ["cu-li"]);
  assert.ok(!brief.canon.some((f: any) => f.fact.includes("ô màu tím")));
  assert.ok(brief.relationships.every((r: any) => ["cu-li", "ca-noc"].includes(r.a) && ["cu-li", "ca-noc"].includes(r.b)));
  assert.ok(brief.running_gags.length <= 3);
});

// ── recap ──────────────────────────────────────────────────────────────────

test("recap turns studio's episode files into memory, with gags and the cameo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hoisau-ep-"));
  const ep = join(dir, "cu-li-ep-003");
  mkdirSync(ep);
  const w = (n: string, v: unknown) => writeFileSync(join(ep, `${n}.json`), JSON.stringify(v));
  w("episode", { id: "cu-li-ep-003", lead: "cu-li", characters: ["cu-li"], direction: "x", credits: [] });
  w("premise", { title: "Máy in", logline: "Máy in kẹt đúng lúc in bản final_v2.", hook: "Ai sửa máy in?", cameo: { name: "Lan", description: "a douc langur in a red scarf" } });
  w("script", { title: "Máy in nổi loạn", panels: [{ action: "Cu Li đứng cạnh máy in", dialogue: [{ speaker: "cu-li", text: "Dạ em in bản final_v2 ạ…" }] }] });
  w("listen", { commentIds: ["c06"], cameo: { id: "cameo-lan", name: "Lan", role: "r", look: "default", credit: { platform: "facebook", commentId: "c06", authorName: "Lan" }, firstEpisode: "cu-li-ep-003" } });

  let memory = remember(emptyMemory(), recalled("cu-li-ep-002", 2, { threadsOpened: [{ text: "Máy in tầng 7 kẹt giấy, ai sửa máy in?", characters: [] }] }));
  const r = await recap(mockLlm(), readEpisodeFiles(dir, "cu-li-ep-003"), memory, plan, 3);
  assert.equal(r.episode.title, "Máy in nổi loạn");
  assert.deepEqual(r.gags, ["final-v2"]);
  assert.deepEqual(r.threadsClosed, ["t1"]);
  assert.equal(r.cameos[0].look, "a douc langur in a red scarf");
  memory = remember(memory, r);
  assert.equal(memory.cameos[0].firstEpisode, "cu-li-ep-003");
  assert.deepEqual(memory.episodes.at(-1)!.fromComments, ["c06"]);
});

// ── coach ──────────────────────────────────────────────────────────────────

const published = (episodeId: string, platform: string, postId: string, publishedAt = "2026-11-01T08:00:00Z") =>
  [`${episodeId}:${platform}:carousel-4x5`, { state: "published" as const, platform: platform as Comment["platform"], postId, publishedAt }] as const;

test("episodes are measured across platforms, people count more than volume, and fresh posts wait", () => {
  const journal = Object.fromEntries([
    published("e1", "facebook", "fb1"),
    published("e1", "instagram", "ig1"),
    published("e2", "facebook", "fb2"),
    published("e3", "facebook", "fb3", "2026-11-03T07:00:00Z"),
  ]);
  const comments = [
    comment("1", "cho Cu Li ngủ gật đi", "a", { postId: "fb1" }),
    comment("2", "tập sau cho Cu Li đi họp", "b", { postId: "ig1", platform: "instagram" }),
    comment("3", "đúng rồi đi họp", "c", { postId: "ig1", platform: "instagram", parentId: "2" }),
    comment("4", "cho Cu Li ngủ gật đi", "a", { postId: "fb2" }),
    comment("5", "cho Cu Li ngủ gật trên bàn", "a", { postId: "fb2" }),
    comment("6", "inbox shop nhé", "spam", { postId: "fb2" }),
  ];
  const stats = measureEpisodes({ journal, comments, insights: [{ postId: "fb2", shares: 1 }], memory: emptyMemory(), now: new Date("2026-11-03T08:00:00Z") });
  assert.deepEqual(stats.map((s) => s.episodeId), ["e1", "e2"]);
  assert.deepEqual(stats[0].platforms, ["facebook", "instagram"]);
  assert.deepEqual([stats[0].authors, stats[0].replies, stats[0].kept], [3, 1, 3]);
  // e2: one person twice, plus spam that does not count, plus a share.
  assert.deepEqual([stats[1].authors, stats[1].kept, stats[1].shares], [2, 2, 1]);
});

test("the coach needs three episodes, writes checked lessons, and the writer and scorer see them", async () => {
  let memory = emptyMemory();
  for (const [i, lead] of ["cu-li", "ca-noc", "cu-li", "te-te"].entries())
    memory = remember(memory, { ...recalled(`e${i + 1}`, i + 1), episode: { ...recalled(`e${i + 1}`, i + 1).episode, lead, fromComments: i === 0 ? ["c1"] : [] } });
  const stat = (episodeId: string, score: number) => ({ episodeId, platforms: ["facebook"], comments: 0, authors: 0, replies: 0, kept: 0, reactions: 0, shares: 0, saves: 0, reach: 0, score });

  assert.match((await coach(mockLlm(), [stat("e1", 9)], memory)).skipped!, /ít nhất 3/);

  const r = await coach(mockLlm(), [stat("e1", 30), stat("e3", 20), stat("e2", 8), stat("e4", 2)], memory);
  // cu-li leads both top episodes: a pattern. Only e1 came from the audience: one data point, so a test.
  assert.deepEqual(r.lessons.map((l) => [l.kind, l.evidence]), [["do", ["e1", "e3"]], ["test", ["e1"]], ["avoid", ["e2", "e4"]], ["test", []]]);
  assert.equal(r.lessons[0].text.includes("cu-li"), true);
  assert.ok(r.lessons.every((l) => l.evidence.every((e) => ["e1", "e2", "e3", "e4"].includes(e))));

  // One episode of evidence is an anecdote: a "do" becomes a "test"; unknown ids are dropped.
  assert.deepEqual(checkLessons({ lessons: [{ kind: "do", text: "x", evidence: ["e1", "zz"] }] }, ["e1"]), [{ id: "l1", kind: "test", text: "x", evidence: ["e1"] }]);

  memory = withLessons(memory, r.lessons);
  const brief = JSON.parse(storyBrief(bible, ["cu-li"], { memory, plan }));
  assert.equal(brief.lessons_from_audience.length, r.lessons.length);
  const llm = mockLlm();
  await listen(examples.slice(0, 3), ctx({ memory }), { llm, episodeId: "e5" });
  assert.match(llm.calls[0].system, /Khán giả đã cho thấy/);
});
