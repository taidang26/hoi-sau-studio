/**
 * The character talks back.
 *
 * - draftReplies: Muse Spark answers commenters in the voice of the episode's
 *   lead, inside its never_says. Spam and toxic comments get no answer; the
 *   model may also decline when there is nothing worth saying.
 * - firstComments: right after an episode goes live, the lead opens the
 *   conversation with the act's audience question, so a reader never lands
 *   on an empty comment section.
 *
 * Both write drafts in channel's OutgoingComment shape (data/replies.json);
 * a comment the character chose not to answer is kept there as rejected.
 * Nothing is sent until it is approved; `channel send-replies` sends.
 */

import type { Comment, JournalEntry, OutgoingComment, Platform } from "@hoi-sau/channel";
import { askJson, type Llm } from "./llm.js";
import { actFor } from "./memory.js";
import { BLOCKING, screen } from "./listen.js";
import { AUDIENCE_DATA_RULE, BANNED_RULE, type SafetyPolicy } from "./safety.js";
import type { BibleLike, ProfileLike, SeasonPlan, StoryMemory } from "./schema.js";

export const REPLY_TASK = "story.reply";
export const FIRST_COMMENT_TASK = "story.first-comment";
export const MAX_REPLY_CHARS = 220;

/** Who speaks under a post: the lead of the episode it belongs to. */
export function speakersByPost(journal: Record<string, JournalEntry>, memory: StoryMemory): Map<string, { episodeId: string; lead: string; brand?: string }> {
  const out = new Map<string, { episodeId: string; lead: string; brand?: string }>();
  for (const [key, e] of Object.entries(journal)) {
    if (e.state !== "published") continue;
    const episodeId = key.split(":")[0];
    const lead = memory.episodes.find((x) => x.id === episodeId)?.lead ?? episodeId.replace(/-ep-\d+$/, "");
    out.set(e.postId, { episodeId, lead, ...(e.brand ? { brand: e.brand } : {}) });
  }
  return out;
}

function voiceLines(p: ProfileLike): string[] {
  return [
    `Bạn là ${p.name}${p.species ? ` (${p.species})` : ""}, nhân vật trong truyện tranh hài văn phòng "Hồi Sau". Bạn đang tự trả lời bình luận dưới bài của mình.`,
    p.personality?.length ? `Tính cách: ${p.personality.join("; ")}.` : "",
    p.voice?.register ? `Giọng: ${p.voice.register}. ${p.voice.speech_pattern ?? ""}` : "",
    p.voice?.catchphrases?.length ? `Câu cửa miệng (dùng ít): ${p.voice.catchphrases.join(" / ")}.` : "",
    p.never_says?.length ? `KHÔNG BAO GIỜ: ${p.never_says.join("; ")}.` : "",
  ].filter(Boolean);
}

export function replyPrompt(p: ProfileLike, bible: BibleLike, batch: Comment[], memory: StoryMemory, safety?: SafetyPolicy): { system: string; user: string } {
  const last = memory.episodes.filter((e) => e.lead === p.slug).at(-1);
  return {
    system: [
      ...voiceLines(p),
      `Luật của series: ${bible.rules.join("; ")}.`,
      last ? `Tập gần nhất của bạn: "${last.title}": ${last.summary}` : "",
      "Cách trả lời:",
      "- Một câu ngắn, tối đa 25 chữ, đúng giọng nhân vật, như đang nhắn tin với đồng nghiệp.",
      "- Đùa lại nhẹ nhàng, không xúc phạm, không hứa trước nội dung tập sau, không tiết lộ mình là AI hay có người viết hộ.",
      "- Khi bình luận góp ý cho tập sau: cảm ơn theo kiểu của nhân vật và gợi ý họ quay lại xem.",
      "- Không nhắc tên thật đầy đủ của người bình luận, không link, không số điện thoại.",
      '- Không có gì đáng trả lời (chỉ tag bạn, chỉ "haha") thì skip = true.',
      'Trả về đúng JSON: {"items":[{"commentId","reply","skip","reason"}]}',
      safety ? BANNED_RULE(safety) : "",
      AUDIENCE_DATA_RULE,
    ]
      .filter(Boolean)
      .join("\n"),
    user: `COMMENTS_JSON: ${JSON.stringify(batch.map((c) => ({ id: c.id, text: c.text, name: c.author.name.split(/\s+/).pop() })))}`,
  };
}

/** A reply is unusable if rules would flag it (spam, toxic, injection, a banned topic), or it runs long. */
export function replyProblem(text: string, safety?: SafetyPolicy): string | undefined {
  const t = text.trim();
  if (!t) return "empty";
  if (t.length > MAX_REPLY_CHARS) return "too long";
  const reason = screen([{ id: "r", platform: "facebook", postId: "p", text: t, author: { name: "r" }, createdAt: "" }], { safety }).rejected[0]?.reason;
  return reason && BLOCKING.includes(reason) ? reason : undefined;
}

export function checkReplies(value: unknown, ids: string[], safety?: SafetyPolicy): Array<{ commentId: string; reply: string; skip: boolean; reason: string }> {
  const items = (value as { items?: unknown })?.items;
  if (!Array.isArray(items)) throw new Error('expected {"items": [...]}');
  return (items as any[])
    .filter((i) => ids.includes(i?.commentId))
    .map((i) => {
      const reply = String(i.reply ?? "").trim();
      const problem = i.skip ? undefined : replyProblem(reply, safety);
      return { commentId: i.commentId, reply, skip: !!i.skip || !!problem, reason: problem ? `dropped: ${problem}` : String(i.reason ?? "") };
    });
}

export interface DraftRepliesInput {
  comments: Comment[];
  journal: Record<string, JournalEntry>;
  profiles: Map<string, ProfileLike>;
  bible: BibleLike;
  memory: StoryMemory;
  /** data/replies.json as it stands; comments already answered or drafted are skipped. */
  existing: OutgoingComment[];
  ownAuthorIds?: string[];
  /** series/safety.yaml: screened comments and drafted replies both avoid it. */
  safety?: SafetyPolicy;
  /** At most this many new drafts per run, newest comments first. */
  max?: number;
  approve?: boolean;
  now?: Date;
}

export async function draftReplies(llm: Llm, input: DraftRepliesInput): Promise<OutgoingComment[]> {
  const done = new Set(input.existing.filter((c) => c.kind === "reply").map((c) => c.commentId));
  const speakers = speakersByPost(input.journal, input.memory);
  const fresh = screen(input.comments, { ownAuthorIds: input.ownAuthorIds, safety: input.safety })
    .kept.filter((c) => !done.has(c.id) && speakers.has(c.postId) && input.profiles.has(speakers.get(c.postId)!.lead))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, input.max ?? 15);

  const bySpeaker = new Map<string, Comment[]>();
  for (const c of fresh) {
    const lead = speakers.get(c.postId)!.lead;
    bySpeaker.set(lead, [...(bySpeaker.get(lead) ?? []), c]);
  }

  const at = (input.now ?? new Date()).toISOString();
  const out: OutgoingComment[] = [];
  for (const [lead, batch] of bySpeaker) {
    const p = input.profiles.get(lead)!;
    const { system, user } = replyPrompt(p, input.bible, batch, input.memory, input.safety);
    const ids = batch.map((c) => c.id);
    const items = await askJson(llm, { task: REPLY_TASK, system, user, temperature: 0.7 }, (v) => checkReplies(v, ids, input.safety));
    for (const i of items) {
      const c = batch.find((x) => x.id === i.commentId)!;
      // A skipped comment is kept as rejected so it is not asked about again.
      out.push({
        id: `reply-${c.platform}-${c.id}`,
        kind: "reply",
        platform: c.platform,
        postId: c.postId,
        commentId: c.id,
        speaker: lead,
        ...(speakers.get(c.postId)!.brand ? { brand: speakers.get(c.postId)!.brand } : {}),
        text: i.skip ? "" : i.reply,
        status: i.skip ? "rejected" : input.approve ? "approved" : "draft",
        note: (i.skip ? `skipped: ${i.reason}` : i.reason) || undefined,
        createdAt: at,
      });
    }
  }
  return out;
}

export function firstCommentPrompt(p: ProfileLike, question: string, hook: string | undefined): { system: string; user: string } {
  return {
    system: [
      ...voiceLines(p),
      "Bài vừa đăng. Viết bình luận đầu tiên của chính nhân vật để mở cuộc trò chuyện:",
      "- Hỏi khán giả câu hỏi dưới đây theo giọng nhân vật, kèm hai lựa chọn ngắn để họ trả lời bằng một chữ hoặc một câu.",
      "- Tối đa 30 chữ, không hashtag, không link.",
      'Trả về đúng JSON: {"text": "..."}',
    ].join("\n"),
    user: `QUESTION: ${question}\nHOOK: ${hook ?? ""}`,
  };
}

export interface FirstCommentInput {
  episodeId: string;
  lead: ProfileLike;
  /** Every published post of the episode. */
  posts: Array<{ platform: Platform; postId: string; brand?: string }>;
  plan?: SeasonPlan;
  episodeNumber: number;
  /** How the episode ended, from premise.hook. */
  hook?: string;
  existing: OutgoingComment[];
  approve?: boolean;
  safety?: SafetyPolicy;
  now?: Date;
}

/** One opening comment per post, skipping posts that already have one. */
export async function firstComments(llm: Llm, input: FirstCommentInput): Promise<OutgoingComment[]> {
  const todo = input.posts.filter((p) => !input.existing.some((c) => c.kind === "first" && c.postId === p.postId));
  if (!todo.length) return [];
  const question = input.plan ? actFor(input.plan, input.episodeNumber).audience_question : input.hook ?? "Tập sau nên thế nào?";
  const { system, user } = firstCommentPrompt(input.lead, question, input.hook);
  const { text } = await askJson(llm, { task: FIRST_COMMENT_TASK, system, user, temperature: 0.7 }, (v) => {
    const t = String((v as { text?: unknown })?.text ?? "").trim();
    const problem = replyProblem(t, input.safety);
    if (problem) throw new Error(`first comment ${problem}`);
    return { text: t };
  });
  const at = (input.now ?? new Date()).toISOString();
  return todo.map((p) => ({
    id: `first-${p.platform}-${p.postId}`,
    kind: "first" as const,
    platform: p.platform,
    postId: p.postId,
    speaker: input.lead.slug,
    ...(p.brand ? { brand: p.brand } : {}),
    text,
    status: input.approve ? ("approved" as const) : ("draft" as const),
    createdAt: at,
  }));
}

/** Approve or reject drafts by id ("all" = every draft). */
export function setStatus(list: OutgoingComment[], ids: string[], status: "approved" | "rejected"): OutgoingComment[] {
  const all = ids.includes("all");
  return list.map((c) => (c.status === "draft" && (all || ids.includes(c.id)) ? { ...c, status } : c));
}
