/**
 * Muse Image prompts built from a profile. Panels never contain text: the
 * Vietnamese dialogue is added later by @hoi-sau/svg-text.
 */

import type { Profile } from "./profile.js";

const NO_TEXT = "no text, no letters, no speech bubbles, no thought clouds, no captions, no logos";

const palette = (p: Profile) => p.look.palette.map((s) => `${s.name} ${s.hex}`).join(", ");

/** The series style (series/style.yaml) when there is one, else the profile's own look.style. */
const drawStyle = (p: Profile, style?: string) => (style ?? p.look.style).trim().replace(/\.?$/, ".");

/** The thumbnail-size identifier, named in every prompt that draws the character. */
export function iconLine(p: Profile): string {
  return p.look.icon ? `Always visible and drawn slightly oversized: ${p.look.icon}.` : "";
}

export function characterSheetPrompt(p: Profile, style?: string): string {
  const expressions = Object.entries(p.look.expressions)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
  return [
    `An original character sheet for a comic series. ${p.look.description}`,
    `Show the same character four times in a row: front view, three-quarter view, side view, back view, full body, standing, evenly spaced.`,
    `Below them, a row of head close-ups with these expressions, each pushed to a cartoon extreme (big eyes, wide mouths, squashed and stretched faces): ${expressions}.`,
    `Must keep: ${p.look.signature.join("; ")}.`,
    iconLine(p),
    `Color palette: ${palette(p)}.`,
    `Style: ${drawStyle(p, style)} Plain white background, ${NO_TEXT}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Drawn comic effects are pictures, so they are allowed where text is not. */
export const COMIC_FX =
  "Exaggerated cartoon acting: squash and stretch, extreme faces, strong lines of action; drawn comic effects (sweat drops, motion lines, shock lines, anger veins, steam puffs, sparkles, dust clouds) are welcome, never as letters";

/**
 * Twelve reusable full-body poses, chained from the character sheet. Episodes
 * attach it with the sheet, so a slumped or shocked character is drawn from an
 * approved pose instead of reinvented each panel. All but the first are pushed
 * to cartoon extremes.
 */
export const POSES = [
  "standing relaxed with a cheeky grin",
  "hunched over the keyboard typing furiously, motion lines on the paws, sweat drops flying",
  "melting off the office chair in despair like a puddle, eyes turned to spirals",
  "leaping a metre into the air in shock, fur standing on end, eyes popping out",
  "triumphant fist pump, one leg kicked up, sparkles all around",
  "sneaking on tiptoe with exaggerated stretched steps, eyes darting sideways",
  "collapsed on the knees, arms raised to the sky, tears streaming like fountains",
  "furious, face red, steam puffs from the ears, anger vein on the forehead",
  "sprinting late with a coffee cup, legs a blur of motion lines, dust cloud behind",
  "squashed flat under a toppling stack of paperwork, only the paws sticking out",
  "jaw dropped to the floor, body stretched tall with disbelief",
  "pointing dramatically straight at the viewer, strong foreshortening, smug face",
];

export function poseSheetPrompt(p: Profile, style?: string): string {
  return [
    `A pose sheet of the character from the sheet: ${POSES.length} full-body poses in a 4x3 grid, evenly spaced, each in its own cell: ${POSES.join("; ")}.`,
    `${COMIC_FX}. Push every pose further than feels safe, like a classic animated cartoon.`,
    `Keep exactly: ${p.look.signature.join("; ")}.`,
    iconLine(p),
    `Style: ${drawStyle(p, style)} Plain white background, ${NO_TEXT}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export interface PoseBeat {
  id: string;
  /** What the panel shows; refers to the character as "the character from the sheet". */
  scene: string;
  size: string;
}

/** Three test beats: a normal office moment, a meeting, and the character's own gag. */
export function consistencyBeats(p: Profile): PoseBeat[] {
  const prop = p.look.props[0] ?? "a laptop";
  return [
    {
      id: "desk",
      scene: `the character from the sheet sitting at an office desk with ${prop}, ${p.look.expressions.default}, three-quarter view`,
      size: "1024x1280",
    },
    {
      id: "meeting",
      scene: `the character from the sheet in a small office meeting room with two other cartoon animal coworkers seen from behind, ${p.look.expressions.stressed ?? p.look.expressions.default}`,
      size: "1024x1280",
    },
    {
      id: "gag",
      scene: `the character from the sheet acting out its signature gag: ${gagInEnglish(p)}, wide shot of an open-plan office`,
      size: "1024x1280",
    },
  ];
}

// The core gag in the profile is Vietnamese for writers; the image model gets look.gag_scene in English.
function gagInEnglish(p: Profile): string {
  const firstOther = Object.keys(p.look.expressions).find((k) => !["default", "stressed", "happy"].includes(k));
  return p.look.gag_scene ?? `${p.office_type}, ${firstOther ? p.look.expressions[firstOther] : p.look.expressions.default}`;
}

export function panelPrompt(p: Profile, scene: string, style?: string): string {
  return [
    `${scene}.`,
    `Keep the character exactly as on the sheet: ${p.look.signature.join("; ")}.`,
    iconLine(p),
    `Single comic panel. Style: ${drawStyle(p, style)} Bright, cheerful daylight. ${COMIC_FX}. The scene fills the whole panel; the top third shows soft, simple background for dialogue added later, never a blank band. ${NO_TEXT}.`,
  ]
    .filter(Boolean)
    .join(" ");
}
