/**
 * One episode, reshaped per platform, from what Studio wrote: title, logline
 * and the hook question that makes people comment, plus credits for the
 * commenters whose idea this episode was.
 *
 *   Facebook   the long version: logline, the question, how the next episode
 *              gets chosen, credits, a few tags
 *   Instagram  short text up front (the feed cuts after two lines), then
 *              credits and a full block of hashtags for discovery
 *   Threads    one-line hook and a single topic tag; the question goes in a
 *              reply of our own, where the conversation starts
 */

import type { Platform } from "@hoi-sau/channel";
import type { EpisodeSpec, Premise } from "@hoi-sau/studio";
import { fold } from "./direction.js";

const tag = (name: string) => "#" + fold(name).replace(/[^a-z0-9]+/g, " ").trim().split(" ").map((w) => w[0].toUpperCase() + w.slice(1)).join("");

export interface Captions extends Record<Platform, string> {
  /** Posted as our own first reply under the Threads post. */
  threadsReply: string;
}

const clip = (s: string, max: number) => ([...s].length > max ? [...s].slice(0, max - 1).join("") + "…" : s);

export function captions(premise: Premise, ep: EpisodeSpec, opts: { number?: number; leadName?: string }): Captions {
  const head = `${premise.title}${opts.number ? ` · Hồi Sau tập ${opts.number}` : " · Hồi Sau"}`;
  const question = premise.hook.trim();
  const credits = ep.credits.map((c) => c.name);
  const thanks = credits.length ? `Ý tưởng tập này: ${credits.join(", ")}. Cảm ơn nha!` : "";
  const leadTag = opts.leadName ? [tag(opts.leadName)] : [];

  const facebook = [
    head,
    premise.logline,
    question,
    "👇 Tập sau do bạn viết: bình luận ý tưởng, ý được nhiều người ủng hộ nhất sẽ thành tập tiếp theo, và bạn sẽ được ghi tên trong tập.",
    thanks,
    ["#HoiSau", "#HaiVanPhong", ...leadTag].join(" "),
  ]
    .filter(Boolean)
    .join("\n\n");

  const instagram = [
    `${head}\n${question} 👇 Bình luận để viết tập sau!`,
    thanks,
    ["#HoiSau", "#TruyenTranh", "#HaiVanPhong", "#DanVanPhong", "#CongSo", "#VanPhong", "#Webtoon", "#ComicVietNam", ...leadTag].join(" "),
  ]
    .filter(Boolean)
    .join("\n\n");

  // Threads: 500 characters and a single topic tag.
  const threads = clip(`${premise.title}: ${premise.logline}`, 480) + " #HoiSau";
  const threadsReply = clip([question, "Trả lời ở đây, ý được nhiều tim nhất thành tập sau.", thanks].filter(Boolean).join("\n"), 500);

  return { facebook, instagram, threads, threadsReply };
}
