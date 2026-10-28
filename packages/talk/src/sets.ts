/**
 * Background sets the cut-out characters stand in front of: real Vietnamese
 * places drawn once by Muse Image as faded watercolour sketches, shared by
 * every character so the channel has one recognisable world.
 * Real photos (--bg photo.jpg) work the same way.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSoftly, type StudioContext } from "@hoi-sau/studio";

export interface TalkSet {
  id: string;
  vi: string;
  scene: string;
  /** Where the scene recedes to, as shares of the 1080x1920 frame (estimated by eye on the drawn set). */
  vp?: { x: number; y: number };
  /** Blur at the farthest point (sigma); a shallow set with a wall close behind needs less than a deep street. */
  far?: number;
  /** Camera for this set, in place of the default standing eye-level view down a street. */
  camera?: string;
}

export const SETS: TalkSet[] = [
  {
    id: "hem-ha-noi",
    vi: "ngõ Hà Nội",
    vp: { x: 0.58, y: 0.72 },
    scene:
      "a quiet residential alley in Hanoi in the morning: narrow tube houses of different heights with balconies and rooftop water tanks, a big tangle of black electric wires across the sky between concrete poles, a leafy tree on one side, pink bougainvillea over a gate, two motorbikes parked by a wall, a clean concrete street in front",
  },
  {
    id: "via-he-cua-cuon",
    vi: "vỉa hè trước cửa cuốn",
    vp: { x: 0.5, y: 0.45 },
    far: 3,
    scene:
      "a Hanoi pavement in front of a narrow tube-house shop that is closed: a grey metal roll-up shutter (cua cuon) with horizontal ribs fills the wall about one to two metres behind, a little faded paint and a power meter box on the wall beside it, a red plastic stool and a potted plant at one side by the wall, square pavement tiles in the foreground, a few fallen bougainvillea petals",
    camera:
      "Shallow scene, no deep street perspective: the camera is low, at about the knee height of an adult, facing the shutter straight on. The line where the pavement meets the wall runs across the picture at about 62% of its height, so the pavement fills the lower part and comes right up to the camera; the middle of the pavement is clear, where a character will stand in front of the shutter.",
  },
  {
    id: "van-phong-that",
    vi: "văn phòng Việt",
    vp: { x: 0.64, y: 0.52 },
    scene:
      "the inside of a real small Vietnamese office in the afternoon: rows of plain desks with monitors and office chairs further back, a window with blinds and city buildings outside, a water dispenser, a potted plant, a few files on shelves",
  },
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

/**
 * Painted the way cartoon talk channels paint their streets: thin loose ink,
 * faded watercolour, hazy and pale, so the bold character in front carries
 * the picture. The series style is left out on purpose: its sparkles and
 * motion lines are what made earlier sets look generated.
 */
export function setPrompt(s: TalkSet): string {
  return [
    `Background plate for a vertical cartoon talking video: ${s.scene}.`,
    "Style: hand-drawn comic illustration with thin, slightly loose ink lines and flat, muted, washed-out colours like a faded watercolour; soft hazy daylight, low contrast, the far background paler and simpler (atmospheric perspective). Calm and real, like a sketch of an actual place.",
    "No sparkles, no stars, no motion lines, no puffs, no stickers, no decorations, no cute props. No people, no animals, no characters. No readable text, letters, signs or logos.",
    s.camera ?? "Eye-level camera at standing head height, one-point perspective down the middle, the centre of the frame calm so a character can stand in front.",
  ].join(" ");
}

export async function drawSets(ctx: StudioContext, dir: string, opts: { only?: string[]; force?: boolean; log?: (s: string) => void } = {}): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  for (const s of SETS.filter((x) => !opts.only || opts.only.includes(x.id))) {
    const file = join(dir, `${s.id}.png`);
    if (existsSync(file) && !opts.force) {
      out.push(file);
      continue;
    }
    opts.log?.(`drawing set ${s.id}`);
    const res = await generateSoftly(ctx.image, { prompt: setPrompt(s), size: "1024x1536" }, opts.log);
    writeFileSync(file, res.image);
    out.push(file);
  }
  return out;
}

/** The drawn set a backdrop file is (series/sets/<id>.png); undefined for photos. */
export function setFor(file: string): TalkSet | undefined {
  const id = file.replace(/\\/g, "/").split("/").pop()?.replace(/\.png$/i, "");
  return SETS.find((s) => s.id === id);
}

/** The vanishing point of a drawn set, from its file name; undefined for photos. */
export const vanishingPointFor = (file: string) => setFor(file)?.vp;

/** --bg takes a set id or a path to a photo. */
export function resolveBackground(bg: string, dir: string): string {
  if (bg === "plain" || bg.startsWith("plain:")) return bg;
  const set = join(dir, `${bg}.png`);
  return SETS.some((s) => s.id === bg) ? set : bg;
}
