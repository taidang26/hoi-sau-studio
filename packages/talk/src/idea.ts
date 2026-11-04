/**
 * From what the owner drops in (text, pictures, or both) to what to make, the way he
 * hands it to a person: a screenshot of a quote becomes a text clip with the words kept
 * exactly; a situation or a meme picture becomes a one-panel comic or a text clip in
 * our own office with our own cast. Only the idea and the words are taken from a
 * picture, never its drawing, layout, clothes or props.
 *
 * Muse Spark reads everything and proposes; the dashboard shows the proposal, editable,
 * and makes nothing until the owner presses the button.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import sharp from "sharp";
import { S, type ChatMessage, type StudioContext } from "@hoi-sau/studio";
import { MEME_TEXT_MAX } from "./meme.js";

export type IdeaKind = "meme" | "comic";

export interface IdeaPlan {
  /** What it recommends making. */
  kind: IdeaKind;
  /** One short Vietnamese sentence: why this, and what it read from the pictures. */
  reply: string;
  /** Every word of text found in the pictures, as written (for the owner to check the reading). */
  read: string;
  lead: string;
  meme: { top: string; punch: string; scenes: string[] };
  /** headline: the words printed in a band above the panel, exactly as given (a quote keeps its words); empty when the joke is only in the drawing. */
  comic: { direction: string; with: string[]; headline: string };
  title: string;
  /** Short caption: #danvanphong first, at most 5 hashtags without accents, no source credit. */
  caption: string;
}

const PLAN = S.obj({
  kind: S.enum(["meme", "comic"], "meme: a quote or a two-beat joke in words; comic: a situation that is funny to look at"),
  reply: S.str("one short Vietnamese sentence for the owner"),
  read: S.str("all text read from the pictures, exactly as written, lines joined with ' / '; empty when none"),
  lead: S.str("slug of the main character"),
  meme: S.obj({
    top: S.str("first beat, the owner's or the picture's exact words"),
    punch: S.str("second beat (the punchline), exact words"),
    scenes: S.arr(S.str("Vietnamese note: what scene shows, in our office with our cast"), 1, 2),
  }),
  comic: S.obj({
    direction: S.str("Vietnamese: what happens in the one panel, in our office with our cast, with the line said if any"),
    with: S.arr(S.str("slug of another cast member"), 0, 2),
    headline: S.str("the quote or joke words printed in a band above the panel, EXACTLY as written by the owner or in the picture; empty only when the joke has no words"),
  }),
  title: S.str("short Vietnamese title, 2-5 words"),
  caption: S.str("short Vietnamese post caption, one line, then #danvanphong first and at most 5 hashtags in total, hashtags without accents; never name or credit a source page"),
});

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

/** The pictures the owner dropped in a folder, in name order. */
export function ideaImages(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => IMAGE.test(f)).sort().map((f) => join(dir, f)) : [];
}

/** Splits one line of text into two beats at the last sentence break, or before "nhưng/mà/còn/trừ" near the middle. */
export function splitBeats(text: string): { top: string; punch: string } {
  const t = text.replace(/\s+/g, " ").trim();
  const stops = [...t.matchAll(/[.!?…,;:]\s+/g)].map((m) => m.index! + m[0].length);
  const turn = [...t.matchAll(/\s(nhưng|mà|còn|trừ|thì ra|hoá ra|hóa ra)\s/gi)].map((m) => m.index! + 1);
  const mid = t.length / 2;
  const best = [...stops, ...turn].filter((i) => i > 8 && i < t.length - 6).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0];
  return best ? { top: t.slice(0, best).trim(), punch: t.slice(best).trim() } : { top: t, punch: "" };
}

export async function readIdea(ctx: StudioContext, text: string, images: string[], want?: IdeaKind | ""): Promise<IdeaPlan> {
  const cast = [...ctx.profiles.values()].map((c) => `${c.slug} = ${c.name}${c.name_vi ? ` / ${c.name_vi}` : ""} (${c.species}, ${c.role})`).join("; ");
  const lead = ctx.profiles.has("cu-li") ? "cu-li" : [...ctx.profiles.keys()][0];
  const pics: ChatMessage["content"] = [];
  for (const f of images.slice(0, 4)) {
    const jpg = await sharp(f).resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    pics.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpg.toString("base64")}` } });
  }
  const prompt = [
    "You are the producer of Hồi Sau, a Vietnamese office-comedy channel with its own animal cast. The owner hands you text, pictures, or both, the way he would to a colleague, and you decide what to make from it.",
    `Cast: ${cast}. The usual main character is ${lead}. "Sếp" (the boss) is the director of the cast.`,
    text.trim() ? `His text: """${text.trim()}"""` : "He sent pictures only.",
    images.length ? `${images.length} picture(s) attached.` : "",
    "Rules:",
    "- Read every word in the pictures exactly as written, with Vietnamese accents. Ignore page names, avatars, verified ticks, likes and watermarks: they are not part of the joke.",
    "- A quote or a joke in words (a screenshot of a post, a two-line joke) becomes kind=meme. Keep the words EXACTLY, split into two beats: the set-up, then the punchline that lands. Never reword, shorten or add words.",
    `- Each beat at most ${MEME_TEXT_MAX} characters.`,
    "- For the comic, comic.headline holds the quote's exact words (printed in a band above the panel, like a quote card); the panel illustrates them and its bubbles add to them, never replace them.",
    "- A situation that is funny to look at (a meme picture, a described scene) becomes kind=comic, one panel. Take only the idea; never copy the picture's drawing, layout, clothes or props. Set it in the Hồi Sau office with our cast unless the joke needs home.",
    "- Scene notes are short Vietnamese: what our character does, one clear action and expression, nothing with lettering, no clocks. Two scenes for a meme: the set-up, then the reaction for the punchline.",
    "- Never credit or name the page the picture came from.",
    "- Fill both meme and comic so the owner can switch; put your recommendation in kind.",
    want ? `He asked for kind=${want}.` : "",
  ].filter(Boolean).join("\n");
  const r = await ctx.spark.json<IdeaPlan>("idea_plan", PLAN, [{ role: "user", content: [{ type: "text", text: prompt }, ...pics] }]);
  if (want) r.kind = want;
  if (!ctx.profiles.has(r.lead)) r.lead = lead;
  r.comic.with = r.comic.with.filter((s) => ctx.profiles.has(s) && s !== r.lead);
  // The words are the joke: a panel made from a quote always carries them, never only a paraphrase.
  if (!r.comic.headline?.trim() && r.meme.top.trim()) r.comic.headline = `${r.meme.top.trim()} ${r.meme.punch.trim()}`.trim();
  // Text typed with no picture: the words are his, so the split must not lose any of them.
  if (r.kind === "meme" && !images.length && text.trim() && `${r.meme.top} ${r.meme.punch}`.replace(/\s+/g, " ").trim() !== text.replace(/\s+/g, " ").trim()) {
    const s = splitBeats(text);
    if (s.punch) r.meme = { ...r.meme, ...s };
  }
  return r;
}

export const imageExt = (name: string) => (IMAGE.test(name) ? extname(name).toLowerCase() : "");
