/**
 * Choosing what tomorrow's episode is about.
 *
 * 1. Comments a person picked on the dashboard (directions.json) win.
 * 2. Otherwise the best unused audience comment: top-level, readable, no
 *    links or abuse, scored by how many people replied to it.
 * 3. Otherwise a quiet day at the office, rotating through the bible's places.
 *
 * Who leads follows the comment when it names a character; otherwise the
 * cast takes turns.
 */

import type { Comment } from "@hoi-sau/channel";
import type { Profile, SeriesBible } from "@hoi-sau/studio";

export interface Direction {
  text: string;
  source: "dashboard" | "comments" | "fallback" | "manual";
  /** Comments this direction came from; never used twice. */
  commentIds: string[];
  credits: Array<{ name: string; comment: string }>;
  lead: string;
  characters: string[];
}

export interface PickedByHand {
  commentId: string;
  pickedAt: string;
}

/** Lowercase, no diacritics, đ → d: "Cá Nóc" and "ca noc" match. */
export const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase();

const word = (w: string) => new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, "u");
// Slang abbreviations are matched without diacritics; full words with them,
// since folding would turn ordinary words ("lớn", "buổi") into the slur.
const ABUSE_ASCII = ["dm", "dmm", "dcm", "vl", "vcl", "vkl", "cc", "clm", "dkm"].map(word);
const ABUSE_WORDS = ["địt", "lồn", "buồi", "cặc", "đéo", "đụ", "cứt"].map(word);

/** Why a comment cannot become a direction, or undefined when it can. */
export function rejectReason(c: Comment): string | undefined {
  const text = c.text.trim();
  if (c.parentId) return "reply";
  if (/https?:\/\/|www\.|\.com\b/i.test(text)) return "link";
  const letters = text.replace(/[^\p{L}]/gu, "");
  if ([...letters].length < 6) return "too short";
  if ([...text].length > 280) return "too long";
  const lower = text.normalize("NFC").toLowerCase();
  if (ABUSE_ASCII.some((re) => re.test(fold(text))) || ABUSE_WORDS.some((re) => re.test(lower))) return "abuse";
  return undefined;
}

/** Characters a text names, by display name or slug, in cast order. */
export function mentioned(text: string, profiles: Map<string, Profile>, cast: string[]): string[] {
  const f = ` ${fold(text).replace(/[^a-z0-9]+/g, " ")} `;
  return cast.filter((slug) => {
    const p = profiles.get(slug);
    const names = [slug.replace(/-/g, " "), p?.name ? fold(p.name).replace(/[^a-z0-9]+/g, " ") : ""].filter(Boolean);
    return names.some((n) => f.includes(` ${n} `));
  });
}

const SUGGESTS = /\b(tap sau|cho|di|nen|thu|giao|bat|lam|hop|sep|deadline)\b/;

export function scoreComment(c: Comment, all: Comment[], profiles: Map<string, Profile>, cast: string[]): number {
  const replies = all.filter((r) => r.parentId === c.id);
  let score = 1 + 2 * new Set(replies.map((r) => r.author.name)).size;
  if (mentioned(c.text, profiles, cast).length) score += 1;
  if (SUGGESTS.test(fold(c.text))) score += 1;
  return score;
}

export interface PickInput {
  comments: Comment[];
  picked: PickedByHand[];
  used: Set<string>;
  profiles: Map<string, Profile>;
  bible: SeriesBible;
  /** Episode number being made; drives rotation. */
  number: number;
  /** Forces the lead, e.g. PIPELINE_LEAD. */
  lead?: string;
  /** A direction typed by a person (`--direction`); beats everything else. */
  manual?: string;
}

export function pickDirection(input: PickInput): Direction {
  const { comments, profiles, bible } = input;
  const cast = bible.cast.filter((s) => profiles.has(s));
  if (!cast.length) throw new Error("The series bible has no cast with a profile.");
  const byId = new Map(comments.map((c) => [c.id, c]));
  if (input.manual?.trim()) return cast_({ text: input.manual.trim(), source: "manual", commentIds: [], credits: [] }, input, cast);

  const handPicked = input.picked.filter((p) => !input.used.has(p.commentId) && byId.has(p.commentId)).map((p) => byId.get(p.commentId)!);
  if (handPicked.length) {
    return cast_(
      { text: handPicked.map((c) => c.text.trim()).join("\n"), source: "dashboard", commentIds: handPicked.map((c) => c.id), credits: handPicked.map(credit) },
      input,
      cast,
    );
  }

  const candidates = comments
    .filter((c) => !input.used.has(c.id) && !rejectReason(c))
    .map((c) => ({ c, score: scoreComment(c, comments, profiles, cast) }))
    .sort((a, b) => b.score - a.score || a.c.createdAt.localeCompare(b.c.createdAt));
  if (candidates.length) {
    const best = candidates[0].c;
    // People who replied in agreement are credited too, up to three names.
    const backers = comments.filter((r) => r.parentId === best.id && !rejectReason({ ...r, parentId: undefined }));
    const credits = [best, ...backers].map(credit).filter((c, i, all) => all.findIndex((x) => x.name === c.name) === i).slice(0, 3);
    return cast_({ text: best.text.trim(), source: "comments", commentIds: [best.id], credits }, input, cast);
  }

  const places = bible.world.places;
  const place = places[(input.number - 1) % Math.max(1, places.length)] ?? "văn phòng";
  return cast_({ text: `Một ngày làm việc bình thường ở ${place}, cho đến khi có chuyện.`, source: "fallback", commentIds: [], credits: [] }, input, cast);
}

const credit = (c: Comment) => ({ name: c.author.name, comment: c.text.trim() });

function cast_(d: Omit<Direction, "lead" | "characters">, input: PickInput, cast: string[]): Direction {
  const named = mentioned(d.text, input.profiles, cast);
  const lead = input.lead && input.profiles.has(input.lead) ? input.lead : (named[0] ?? cast[(input.number - 1) % cast.length]);
  // A second character: another one the audience named, or the lead's partner in the bible.
  const partner =
    named.find((s) => s !== lead) ??
    input.bible.relationships.map((r) => (r.a === lead ? r.b : r.b === lead ? r.a : undefined)).find((s) => s && cast.includes(s));
  return { ...d, lead, characters: partner ? [lead, partner] : [lead] };
}
