/**
 * Listening: comments → the next episode's direction.
 *
 *   1. screen   cheap rules, no model: spam, toxic, duplicates, empty
 *   2. score    Muse Spark Open (or Muse Spark) reads what is left in batches:
 *               is it an idea, is it in character, is it funny, is it new
 *   3. cluster  comments that want the same thing are grouped
 *   4. rank     a cluster wins on quality × how many different people want it
 *   5. pick     an editor's pick from the dashboard wins; else the top
 *               cluster; else the season plan. The best commenter is credited
 *               and written in as a coworker, drawn from words only.
 *
 * The result's `pick.spec` has the same fields as studio's EpisodeSpec
 * (direction, credits), so `studio episode new --from-listen` takes it as is.
 */

import type { Comment } from "@hoi-sau/channel";
import { askJson, type Llm } from "./llm.js";
import { actFor, milestonesFor } from "./memory.js";
import type {
  BibleLike,
  Cameo,
  IdeaCluster,
  ListenReport,
  ProfileLike,
  RejectReason,
  ScoredComment,
  SeasonPlan,
  StoryMemory,
  Verdict,
} from "./schema.js";
import { displayName, fold, hash, hasPhrase, jaccard, kebab, keywords } from "./text.js";

// ── 1. screen ──────────────────────────────────────────────────────────────

const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|vn|net|xyz|shop|link|me|io)\b|bit\.ly|t\.me\/|zalo\.me)/i;
const PHONE = /(\+?84|0)[\s.-]?\d{2,3}[\s.-]?\d{3}[\s.-]?\d{3,4}\b/;

/** Folded phrases that only show up in ads, bots and scams. */
export const SPAM_PHRASES = [
  "inbox", "ib", "check ib", "xem ib", "lien he", "zalo", "gia si", "gia tot", "free ship", "freeship", "order",
  "tuyen dung", "tuyen ctv", "viec lam online", "viec nhe luong cao", "kiem tien", "thu nhap", "nha cai", "ca cuoc",
  "keo bong", "soi keo", "tai xiu", "vay tien", "vay nhanh", "app vay", "giai ngan", "follow cheo", "sub cheo",
  "tang follow", "tang like", "tuong tac cheo", "khuyen mai", "giam gia", "sale", "link bio", "xem them tai",
];

/** Folded words rude in any spelling, plus slurs about regions and groups. */
export const TOXIC_FOLDED = [
  "dm", "dmm", "dcm", "dkm", "vcl", "vkl", "vl", "clm", "cmm", "dit", "djt", "deo", "loz", "cc", "occ", "oc cho",
  "thang ngu", "con ngu", "do ngu", "ngu nhu bo", "ngu nhu cho", "do cho", "cho chet", "mat day", "bo lao",
  "bac ky", "bac ki", "nam ky", "nam ki", "parky", "bake", "ba que", "3 que", "nam ky lua", "di chet", "chet di",
];

/** Rude only with their diacritics; folded they are ordinary words (lớn, các, buổi). */
export const TOXIC_MARKED = ["lồn", "cặc", "buồi", "đéo", "địt", "đụ", "đĩ", "cứt"];

export interface Screened {
  kept: Comment[];
  rejected: ListenReport["rejected"];
}

/** Rule pass. Fast and free, so the model only reads comments worth reading. */
export function screen(comments: Comment[], opts: { ownAuthorIds?: string[] } = {}): Screened {
  const own = new Set(opts.ownAuthorIds ?? []);
  const kept: Comment[] = [];
  const rejected: Screened["rejected"] = [];
  const seenByAuthor = new Map<string, Set<string>>();
  const seenLong = new Set<string>();
  const reject = (c: Comment, reason: RejectReason, detail: string) => rejected.push({ commentId: c.id, reason, detail });

  for (const c of [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const folded = fold(c.text);
    const lower = c.text.toLowerCase();
    const author = c.author.id ?? c.author.name;
    const content = folded.replace(/[@#]\S+/g, "").trim();

    if (c.author.id && own.has(c.author.id)) reject(c, "self", "the Page's own comment");
    else if (LINK.test(c.text)) reject(c, "spam", "contains a link");
    else if (PHONE.test(c.text)) reject(c, "spam", "contains a phone number");
    else if (SPAM_PHRASES.some((p) => hasPhrase(folded, p))) reject(c, "spam", `ad phrase "${SPAM_PHRASES.find((p) => hasPhrase(folded, p))}"`);
    else if (TOXIC_FOLDED.some((p) => hasPhrase(folded, p)) || TOXIC_MARKED.some((w) => new RegExp(`(^|[^\\p{L}])${w}($|[^\\p{L}])`, "u").test(lower)))
      reject(c, "toxic", "profanity or slur");
    else if (content.replace(/\s/g, "").length < 4) reject(c, "too-short", "emoji, tags or a word or two");
    else {
      // Same person saying the same thing twice, or a long text pasted by many accounts.
      const mine = seenByAuthor.get(author) ?? new Set<string>();
      if (mine.has(content)) reject(c, "duplicate", "same author, same text");
      else if (content.length > 40 && seenLong.has(content)) reject(c, "duplicate", "same long text from another account");
      else {
        mine.add(content);
        seenByAuthor.set(author, mine);
        if (content.length > 40) seenLong.add(content);
        kept.push(c);
      }
    }
  }
  return { kept, rejected };
}

// ── 2. score ───────────────────────────────────────────────────────────────

export interface ListenContext {
  bible: BibleLike;
  lead: ProfileLike;
  plan?: SeasonPlan;
  memory: StoryMemory;
  episodeNumber: number;
}

export function seasonLine(ctx: ListenContext): string {
  if (ctx.plan) {
    const act = actFor(ctx.plan, ctx.episodeNumber);
    return `Tập ${ctx.episodeNumber}, hồi "${act.title}": ${act.goal.replace(/\.$/, "")}. Tránh: ${act.avoid.join("; ") || "không"}.`;
  }
  const m = milestonesFor(ctx.bible.season.milestones, ctx.episodeNumber);
  return `Tập ${ctx.episodeNumber}. ${ctx.bible.season.arc} ${m.now.join("; ")}${m.next ? ` Mốc tới: ${m.next}.` : ""}`;
}

export const SCORE_TASK = "listen.score";

export function scoringPrompt(ctx: ListenContext, batch: Comment[]): { system: string; user: string } {
  const lead = ctx.lead;
  const system = [
    `Bạn là biên tập viên của "${ctx.bible.title}", truyện tranh hài văn phòng mỗi ngày một tập. Khán giả bình luận để quyết định tập sau.`,
    `Nhiệm vụ: đọc từng bình luận và chấm xem nó có phải một ý tưởng dùng được cho tập sau không.`,
    `Giọng truyện: ${ctx.bible.tone}`,
    `Nhân vật chính tập tới: ${lead.name} (${lead.slug}), ${lead.office_type ?? ""}. Gag chính: ${lead.core_gag ?? ""}.`,
    lead.never_says?.length ? `${lead.name} KHÔNG BAO GIỜ: ${lead.never_says.join("; ")}.` : "",
    `Luật của series: ${ctx.bible.rules.join("; ")}.`,
    `Mùa này: ${seasonLine(ctx)}`,
    ctx.memory.lessons?.length ? `Khán giả đã cho thấy: ${ctx.memory.lessons.map((l) => `${l.kind === "avoid" ? "tránh" : l.kind === "do" ? "nên" : "thử"}: ${l.text}`).join(" | ")} (dùng khi chấm fit).` : "",
    ctx.memory.episodes.length ? `Đã kể rồi (đừng chấm cao ý lặp lại): ${ctx.memory.episodes.slice(-8).map((e) => e.title).join("; ")}.` : "",
    "",
    "verdict:",
    '- "idea": đề xuất chuyện xảy ra tiếp, dù viết vui hay ngắn ("cho sếp bắt gặp Cu Li ngủ gật đi")',
    '- "reaction": khen, chê, cười, tag bạn, không có ý tưởng',
    '- "question": hỏi về truyện hay nhân vật',
    '- "off-character": ý tưởng bắt nhân vật làm điều trái tính cách hoặc trái điều KHÔNG BAO GIỜ',
    '- "unsafe": người thật, nhãn hàng thật, chính trị, tôn giáo, bạo lực, săn bắt động vật, chê ngoại hình/vùng miền/giới tính',
    "idea: viết lại ý tưởng thành một câu tiếng Việt rõ ràng; để trống nếu không phải idea.",
    'cluster: nhãn kebab-case không dấu 1–4 chữ, ý giống nhau thì cùng nhãn (vd "sep-bat-ngu-gat").',
    "scores 0–5: fun = có buồn cười không; fit = hợp nhân vật và hồi hiện tại; fresh = mới so với các tập đã kể.",
    "reason: một câu ngắn.",
    'Trả về đúng JSON: {"items":[{"commentId","verdict","idea","cluster","scores":{"fun","fit","fresh"},"reason"}]}, mỗi bình luận một item.',
  ]
    .filter(Boolean)
    .join("\n");
  const user = `COMMENTS_JSON: ${JSON.stringify(batch.map((c) => ({ id: c.id, text: c.text })))}`;
  return { system, user };
}

const VERDICTS: Verdict[] = ["idea", "reaction", "question", "off-character", "unsafe"];
const clamp = (n: unknown) => Math.max(0, Math.min(5, Math.round(Number(n) || 0)));

export function checkScores(value: unknown, ids: string[]): ScoredComment[] {
  const items = (value as { items?: unknown })?.items;
  if (!Array.isArray(items)) throw new Error('expected {"items": [...]}');
  const want = new Set(ids);
  const out: ScoredComment[] = [];
  for (const raw of items as any[]) {
    if (!want.has(raw?.commentId)) continue;
    want.delete(raw.commentId);
    const verdict: Verdict = VERDICTS.includes(raw.verdict) ? raw.verdict : "reaction";
    out.push({
      commentId: raw.commentId,
      verdict,
      idea: verdict === "idea" ? String(raw.idea ?? "").trim() : "",
      cluster: kebab(String(raw.cluster ?? raw.idea ?? "khac")),
      scores: { fun: clamp(raw.scores?.fun), fit: clamp(raw.scores?.fit), fresh: clamp(raw.scores?.fresh) },
      reason: String(raw.reason ?? "").slice(0, 200),
    });
  }
  // A dropped comment is a slip, not a verdict: ask again rather than guess.
  if (want.size > ids.length / 4) throw new Error(`missing items for ${[...want].join(", ")}`);
  for (const id of want) out.push({ commentId: id, verdict: "reaction", idea: "", cluster: "khac", scores: { fun: 0, fit: 0, fresh: 0 }, reason: "model skipped it" });
  return out.map((s) => (s.verdict === "idea" && !s.idea ? { ...s, verdict: "reaction" as const } : s));
}

export async function scoreComments(llm: Llm, ctx: ListenContext, comments: Comment[], batchSize = 25): Promise<ScoredComment[]> {
  const out: ScoredComment[] = [];
  for (let i = 0; i < comments.length; i += batchSize) {
    const batch = comments.slice(i, i + batchSize);
    const { system, user } = scoringPrompt(ctx, batch);
    const ids = batch.map((c) => c.id);
    out.push(...(await askJson(llm, { task: SCORE_TASK, system, user, temperature: 0.1 }, (v) => checkScores(v, ids))));
  }
  return out;
}

// ── 3–4. cluster and rank ──────────────────────────────────────────────────

export const quality = (s: ScoredComment) => 0.4 * s.scores.fun + 0.4 * s.scores.fit + 0.2 * s.scores.fresh;

/**
 * Groups ideas by the model's label, then merges labels whose ideas share
 * most of their words (batches label the same idea differently).
 */
export function cluster(scored: ScoredComment[], comments: Comment[], memory: StoryMemory): IdeaCluster[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const replies = new Map<string, number>();
  for (const c of comments) if (c.parentId) replies.set(c.parentId, (replies.get(c.parentId) ?? 0) + 1);

  const groups: Array<{ key: string; words: Set<string>; items: ScoredComment[] }> = [];
  for (const s of scored.filter((x) => x.verdict === "idea" && x.scores.fit >= 2)) {
    const w = keywords(s.idea);
    const g = groups.find((x) => x.key === s.cluster) ?? groups.find((x) => jaccard(x.words, w) >= 0.5);
    if (g) {
      g.items.push(s);
      for (const x of w) g.words.add(x);
    } else groups.push({ key: s.cluster, words: w, items: [s] });
  }

  const told = memory.episodes.map((e) => keywords(`${e.title} ${e.summary}`));
  return groups
    .map((g) => {
      const items = [...g.items].sort((a, b) => quality(b) - quality(a) || (byId.get(a.commentId)?.createdAt ?? "").localeCompare(byId.get(b.commentId)?.createdAt ?? ""));
      const authors = new Set(items.map((s) => byId.get(s.commentId)?.author.id ?? byId.get(s.commentId)?.author.name)).size;
      const support = items.reduce((n, s) => n + (replies.get(s.commentId) ?? 0), 0);
      const top = items.slice(0, 3);
      const q = top.reduce((n, s) => n + quality(s), 0) / top.length;
      // Many different people asking matters more than one person asking loudly.
      let score = q * (1 + Math.log2(1 + authors)) + 0.5 * Math.log2(1 + support);
      // Already told: an idea that mostly repeats a past episode loses ground.
      if (top.some((s) => told.some((t) => jaccard(t, keywords(s.idea)) >= 0.4))) score *= 0.6;
      return {
        key: g.key,
        idea: items[0].idea,
        commentIds: items.map((s) => s.commentId),
        authors,
        support,
        score: Math.round(score * 100) / 100,
        bestCommentId: items[0].commentId,
      };
    })
    .sort((a, b) => b.score - a.score);
}

// ── 5. pick and credit ─────────────────────────────────────────────────────

const COWORKER_ANIMALS = [
  "a small red-shanked douc langur with a cream face and orange legs",
  "a round Indochinese hedgehog with soft brown spines",
  "a tall grey crane with a red crown",
  "a chubby bamboo rat with tiny ears",
  "a striped Annamite rabbit with dark stripes",
  "a little mouse-deer (chevrotain) with big dark eyes",
  "a green Vietnamese mossy frog",
  "a binturong with shaggy black fur and long whiskers",
];

/**
 * The commenter as a coworker. Only a first name or handle is shown, the
 * look is chosen from a list of animals by the name, and nothing comes from
 * their profile photo.
 */
export function cameoFor(comment: Comment, idea: string, episodeId: string): Cameo {
  const name = displayName(comment.author.name);
  return {
    id: `cameo-${kebab(name)}-${hash(comment.id) % 1000}`,
    name,
    role: "đồng nghiệp mới, người nghĩ ra chuyện tập này",
    look: `${COWORKER_ANIMALS[hash(name) % COWORKER_ANIMALS.length]}, wearing a simple office lanyard`,
    credit: { platform: comment.platform, commentId: comment.id, authorName: comment.author.name },
    firstEpisode: episodeId,
  };
}

export function directionText(idea: string, people: number): string {
  const text = idea.trim().replace(/\.$/, "");
  if (!people) return `${text}.`;
  return `${text} (${people > 1 ? `${people} khán giả cùng đề xuất` : "một khán giả đề xuất"}).`;
}

export function seasonFallback(ctx: ListenContext): { idea: string; why: string } {
  if (ctx.plan) {
    const act = actFor(ctx.plan, ctx.episodeNumber);
    const used = ctx.memory.episodes.map((e) => keywords(`${e.title} ${e.summary}`));
    const todo = act.must_happen.find((m) => !used.some((u) => jaccard(u, keywords(m)) >= 0.3)) ?? act.goal;
    return { idea: todo, why: `Chưa có ý tưởng khán giả đủ tốt; lấy từ kế hoạch hồi "${act.title}".` };
  }
  const m = milestonesFor(ctx.bible.season.milestones, ctx.episodeNumber);
  return { idea: m.now[0] ?? ctx.bible.season.arc, why: "Chưa có ý tưởng khán giả đủ tốt; lấy từ mốc của mùa." };
}

export interface ListenOptions {
  llm: Llm;
  /** Comment ids an editor picked on the dashboard (data/directions.json). */
  editorPicks?: string[];
  ownAuthorIds?: string[];
  /** The episode being planned, used as the cameo's first episode. */
  episodeId: string;
  /** Clusters scoring below this are not worth an episode. */
  minScore?: number;
  now?: Date;
}

export async function listen(comments: Comment[], ctx: ListenContext, opts: ListenOptions): Promise<ListenReport> {
  const { kept, rejected } = screen(comments, { ownAuthorIds: opts.ownAuthorIds });
  const scored = kept.length ? await scoreComments(opts.llm, ctx, kept) : [];
  const clusters = cluster(scored, comments, ctx.memory);
  const byId = new Map(comments.map((c) => [c.id, c]));

  const totals = { pulled: comments.length } as ListenReport["totals"];
  for (const k of ["spam", "toxic", "duplicate", "too-short", "self", ...VERDICTS] as const) totals[k] = 0;
  for (const r of rejected) totals[r.reason]++;
  for (const s of scored) totals[s.verdict]++;

  let pick: ListenReport["pick"];
  const blocked = new Set([...rejected.filter((r) => r.reason === "spam" || r.reason === "toxic").map((r) => r.commentId), ...scored.filter((s) => s.verdict === "unsafe").map((s) => s.commentId)]);
  const editorId = (opts.editorPicks ?? []).find((id) => byId.has(id) && !blocked.has(id));
  const top = clusters[0];

  if (editorId) {
    const c = byId.get(editorId)!;
    const s = scored.find((x) => x.commentId === editorId);
    const idea = s?.idea || c.text;
    const group = clusters.find((g) => g.commentIds.includes(editorId));
    const cameo = cameoFor(c, idea, opts.episodeId);
    pick = {
      source: "editor",
      spec: { direction: directionText(idea, group?.authors ?? 1), credits: [{ name: cameo.name, comment: c.text }] },
      why: "Biên tập chọn bình luận này trên dashboard.",
      commentIds: group?.commentIds ?? [editorId],
      cameo,
    };
  } else if (top && top.score >= (opts.minScore ?? 4)) {
    const c = byId.get(top.bestCommentId)!;
    const cameo = cameoFor(c, top.idea, opts.episodeId);
    pick = {
      source: "audience",
      spec: { direction: directionText(top.idea, top.authors), credits: [{ name: cameo.name, comment: c.text }] },
      why: `Cụm "${top.key}" điểm ${top.score}: ${top.commentIds.length} bình luận từ ${top.authors} người, ${top.support} trả lời ủng hộ.`,
      commentIds: top.commentIds,
      cameo,
    };
  } else {
    const f = seasonFallback(ctx);
    pick = { source: "season", spec: { direction: directionText(f.idea, 0), credits: [] }, why: f.why, commentIds: [], cameo: null };
  }

  return {
    at: (opts.now ?? new Date()).toISOString(),
    episodes: [...new Set(comments.map((c) => c.postId))],
    lead: ctx.lead.slug,
    episodeNumber: ctx.episodeNumber,
    model: opts.llm.model,
    totals,
    rejected,
    scored,
    clusters,
    pick,
  };
}

/** Fold-insensitive check used by tests and the dashboard: is this text spam or toxic by rule? */
export const ruleVerdict = (text: string): RejectReason | undefined =>
  screen([{ id: "x", platform: "facebook", postId: "p", text, author: { name: "x" }, createdAt: "" }]).rejected[0]?.reason;

