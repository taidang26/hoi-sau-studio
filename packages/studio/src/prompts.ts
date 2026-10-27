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
    `Below them, a row of head close-ups with these expressions: ${expressions}.`,
    `Must keep: ${p.look.signature.join("; ")}.`,
    iconLine(p),
    `Color palette: ${palette(p)}.`,
    `Style: ${drawStyle(p, style)} Plain white background, ${NO_TEXT}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Six reusable full-body poses, chained from the character sheet. Episodes
 * attach it with the sheet, so a slumped or shocked character is drawn from an
 * approved pose instead of reinvented each panel.
 */
export const POSES = [
  "standing neutral",
  "sitting at an office desk typing",
  "slumped face-down on a desk",
  "pointing and explaining",
  "jumping back in shock",
  "looking up, daydreaming",
];

export function poseSheetPrompt(p: Profile, style?: string): string {
  return [
    `A pose sheet of the character from the sheet: six full-body poses in a 3x2 grid, evenly spaced: ${POSES.join("; ")}.`,
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
    `Single comic panel. Style: ${drawStyle(p, style)} Bright, cheerful daylight. Leave the top third of the panel calm and empty for dialogue added later. ${NO_TEXT}.`,
  ]
    .filter(Boolean)
    .join(" ");
}
