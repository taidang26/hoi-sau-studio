/**
 * Background sets the cut-out characters stand in front of: empty rooms drawn
 * once by Muse Image in the series style, full of specific, lived-in details,
 * shared by every character so the channel has one recognisable world.
 * Real photos (--bg photo.jpg) work the same way.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSoftly, styleReference, styleText, type StudioContext } from "@hoi-sau/studio";

export interface TalkSet {
  id: string;
  vi: string;
  scene: string;
}

export const SETS: TalkSet[] = [
  {
    id: "office",
    vi: "góc văn phòng",
    scene:
      "a real Vietnamese open-plan office corner at eye level: a desk with a monitor covered in sticky notes, a tangle of chargers, a half-drunk iced milk coffee in a plastic cup with a straw, a big water bottle with time marks, a small cactus, a stack of folders, a whiteboard with scribbled boxes and arrows (no readable words), a wall calendar, a window with Hanoi buildings and daylight, a coworker's chair pushed back",
  },
  {
    id: "pantry",
    vi: "pantry công ty",
    scene:
      "a small Vietnamese office pantry: a water dispenser, a microwave with a queue note stuck on it (no readable words), a fridge covered in magnets, instant noodle cups and a jar of coffee sachets on the counter, a sink with a few mugs, fluorescent light mixed with window daylight, a plant on the windowsill",
  },
  {
    id: "phong-tro",
    vi: "phòng trọ",
    scene:
      "a cosy, slightly messy 15 square metre rented room in Hanoi at evening: a narrow bed with a cartoon blanket, a standing fan, clothes on a rack, a desk with a laptop and an instant-noodle cup, fairy lights on the wall, a small window with a neighbour's air-conditioner unit outside, warm lamp light",
  },
  {
    id: "cafe",
    vi: "quán cà phê",
    scene:
      "a Hanoi sidewalk-style cafe corner indoors: small low wooden tables and plastic stools, a glass of iced coffee and a phone on the table, potted plants, string lights, a menu board on the wall (no readable words), the street glimpsed through the open front, afternoon light",
  },
];

export const setsDir = (seriesDir: string) => join(seriesDir, "sets");

export function setPrompt(ctx: StudioContext, s: TalkSet): string {
  return [
    `An empty background plate for a vertical talking video: ${s.scene}.`,
    "No people, no animals, no characters anywhere: the room is empty, waiting for a character to stand in front of it. Eye-level camera at about seated head height, the middle and lower part of the frame kept a little calmer so a character can stand there, details towards the sides and top.",
    "Depth: things in front slightly larger, the far wall softer. Feels like a real, used place, not a showroom.",
    "No text, letters, numbers, logos or signs that can be read.",
    ctx.style ? styleText(ctx.style) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export async function drawSets(ctx: StudioContext, dir: string, opts: { only?: string[]; force?: boolean; log?: (s: string) => void } = {}): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  const style = styleReference(ctx.style);
  for (const s of SETS.filter((x) => !opts.only || opts.only.includes(x.id))) {
    const file = join(dir, `${s.id}.png`);
    if (existsSync(file) && !opts.force) {
      out.push(file);
      continue;
    }
    opts.log?.(`drawing set ${s.id}`);
    const res = await generateSoftly(ctx.image, { prompt: setPrompt(ctx, s), size: "1024x1536", references: style ? [style] : undefined }, opts.log);
    writeFileSync(file, res.image);
    out.push(file);
  }
  return out;
}

/** --bg takes a set id or a path to a photo. */
export function resolveBackground(bg: string, dir: string): string {
  const set = join(dir, `${bg}.png`);
  return SETS.some((s) => s.id === bg) ? set : bg;
}
