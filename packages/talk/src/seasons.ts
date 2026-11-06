/**
 * Đồ theo dịp: each character drawn once in a seasonal outfit (Tết, Noel, Trung thu...), handed to
 * Muse Image as an extra reference when a meme is made for that occasion, so the outfit is the same
 * in every clip of the season and the character stays on-model under it.
 *
 *   characters/<slug>/seasons/<key>.png
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHARACTERS_DIR, generateSoftly, modelSheet, type StudioContext } from "@hoi-sau/studio";

export interface Outfit { key: string; season: string; vi: string; text: string }

/** `season` is the occasion as the idea stock names it (dashboard kho.ts). */
export const OUTFITS: Outfit[] = [
  { key: "tet", season: "Tết", vi: "Tết", text: "a festive red Vietnamese áo dài worn over the usual look, with a small yellow apricot blossom pinned at the chest" },
  { key: "noel", season: "Noel", vi: "Noel", text: "a red Santa hat with a white pompom and a green knitted scarf over the usual outfit" },
  { key: "trung-thu", season: "Trung thu", vi: "Trung thu", text: "the usual outfit, holding a red star-shaped Mid-Autumn lantern on a stick" },
  { key: "20-10", season: "20/10", vi: "20/10", text: "the usual outfit, holding a small bouquet of pink roses wrapped in paper" },
  { key: "8-3", season: "8/3", vi: "8/3", text: "the usual outfit, holding a single red rose and a small gift box with a ribbon" },
  { key: "14-2", season: "14/2", vi: "Valentine", text: "the usual outfit, holding a red heart-shaped box of chocolates" },
];

export const outfitOf = (season: string | undefined) => (season ? OUTFITS.find((o) => o.season === season || o.key === season) : undefined);
export const seasonsDir = (charactersDir: string, slug: string) => join(charactersDir, slug, "seasons");

/** The drawn seasonal picture of a character, if any. */
export function seasonRef(charactersDir: string, slug: string, season: string | undefined): { outfit: Outfit; file?: string } | undefined {
  const o = outfitOf(season);
  if (!o) return undefined;
  const f = join(seasonsDir(charactersDir, slug), `${o.key}.png`);
  return { outfit: o, file: existsSync(f) ? f : undefined };
}

/** Draws the missing seasonal outfits of a character (or `only`, by key). */
export async function makeSeasons(ctx: StudioContext, slug: string, opts: { only?: string[]; log?: (s: string) => void } = {}): Promise<number> {
  const p = ctx.profiles.get(slug);
  if (!p) throw new Error(`No character "${slug}".`);
  const dir = seasonsDir(ctx.charactersDir ?? CHARACTERS_DIR, slug);
  mkdirSync(dir, { recursive: true });
  let made = 0;
  // One picture of the character in one pose as the reference: given the model and pose sheets, Muse Image drew a
  // whole sheet back (several copies with labels, Bống every time). The mouth kit's front portrait or a reaction
  // picture is one character; the model sheet is the last resort.
  const cdir = ctx.charactersDir ?? CHARACTERS_DIR;
  const single = [join(cdir, slug, "mouthkit", "front.png"), join(cdir, slug, "stock", "gat-gu.png"), join(cdir, slug, "stock", "do-mat.png")].find((f) => existsSync(f));
  const refs = single ? [`data:image/png;base64,${readFileSync(single).toString("base64")}`] : [modelSheet(ctx, slug)].filter((x): x is string => !!x);
  for (const o of OUTFITS) {
    const file = join(dir, `${o.key}.png`);
    if (opts.only ? !opts.only.includes(o.key) : existsSync(file)) continue;
    opts.log?.(`${slug} ${o.key}: drawing`);
    const res = await generateSoftly(ctx.image, {
      prompt: `One single full-body picture of ${p.name} (${p.species}), ONE character in ONE pose, standing facing the viewer in the middle of a plain light grey background: ${p.look.description.replace(/\s+/g, " ")} For ${o.vi}: ${o.text}. The same character design, face, colours and line style as the reference; only the seasonal item is added. Not a character sheet: no turnaround, no second copy, no labels, no captions, no text anywhere.`,
      size: "1024x1024",
      references: refs,
    }, opts.log);
    writeFileSync(file, res.image);
    made++;
  }
  return made;
}
