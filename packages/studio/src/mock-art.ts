/**
 * Pictures for offline runs. Instead of a blank tile, the mock draws what the
 * prompt asks for out of each character's placeholder portrait
 * (characters/<slug>/portrait.svg): a character sheet, or an office panel with
 * the staged characters on the left, centre or right. Real runs never use this.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHARACTERS_DIR, listCharacters, loadProfile } from "./profile.js";

export interface MockCast {
  name: string;
  description: string;
  /** Inner markup of the portrait, drawn in a 512 x 512 box. */
  art: string;
}

export function loadMockCast(dir = CHARACTERS_DIR): MockCast[] {
  if (!existsSync(dir)) return [];
  return listCharacters(dir).flatMap((slug) => {
    const file = join(dir, slug, "portrait.svg");
    if (!existsSync(file)) return [];
    try {
      const p = loadProfile(slug, dir);
      const svg = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
      const art = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
      return [{ name: p.name, description: p.look.description.slice(0, 80), art }];
    } catch {
      return [];
    }
  });
}

export type Place = { cast: MockCast; position: "left" | "center" | "right" };

export interface Scene {
  kind: "sheet" | "panel";
  places: Place[];
  shot: "close-up" | "medium" | "wide";
  hue: number;
}

/** Read who is where from a panel or sheet prompt. */
export function sceneFromPrompt(prompt: string, cast: MockCast[], n: number, previous?: Scene): Scene {
  const hue = (n * 47 + 20) % 360;
  if (/^An original character sheet/.test(prompt)) {
    const who = cast.find((c) => prompt.includes(c.description)) ?? cast[n % Math.max(cast.length, 1)];
    return { kind: "sheet", places: who ? [{ cast: who, position: "center" }] : [], shot: "wide", hue };
  }
  // An edit keeps the panel it edits.
  if (/^Edit this panel/.test(prompt) && previous) return previous;
  const found: Array<Place & { at: number }> = [];
  for (const c of cast) {
    const m = new RegExp(`${c.name} \\([^)]*\\)*\\)? on the (left|center|right)`).exec(prompt);
    if (m) found.push({ cast: c, position: m[1] as Place["position"], at: m.index });
  }
  // In prompt order, which is the storyboard's staging order.
  const places: Place[] = found.sort((a, b) => a.at - b.at).map(({ cast, position }) => ({ cast, position }));
  // Test panels say "the character from the sheet": reuse the sheet's character.
  if (!places.length && previous?.places[0]) places.push({ cast: previous.places[0].cast, position: "center" });
  const shot = /close-up/i.test(prompt) ? "close-up" : /wide|establishing/i.test(prompt) ? "wide" : "medium";
  return { kind: "panel", places, shot, hue };
}

const figure = (c: MockCast, x: number, y: number, size: number, flip = false) =>
  `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 512 512" overflow="visible">${flip ? `<g transform="translate(512 0) scale(-1 1)">${c.art}</g>` : c.art}</svg>`;

export function renderScene(s: Scene, w: number, h: number): string {
  const ink = "#1b1410";
  if (s.kind === "sheet") {
    const c = s.places[0]?.cast;
    const size = Math.min(w / 4.4, h * 0.62);
    const figs = c ? [0, 1, 2, 3].map((i) => figure(c, w * 0.06 + i * (w * 0.88 - size) / 3, h * 0.08, size, i === 2)).join("") : "";
    const heads = c ? [0, 1, 2, 3, 4].map((i) => figure(c, w * 0.12 + i * (w * 0.76 - size * 0.42) / 4, h * 0.68, size * 0.42)).join("") : "";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#ffffff"/>
<line x1="${w * 0.05}" y1="${h * 0.64}" x2="${w * 0.95}" y2="${h * 0.64}" stroke="#d8d8d8" stroke-width="3"/>${figs}${heads}</svg>`;
  }
  const wall = `hsl(${s.hue} 42% 86%)`;
  const wall2 = `hsl(${s.hue} 38% 78%)`;
  const deskY = h * 0.8;
  const size = (s.shot === "close-up" ? 0.8 : s.shot === "wide" ? 0.5 : 0.66) * h * (s.places.length > 2 ? 0.82 : 1);
  const X = { left: 0.24, center: 0.5, right: 0.76 } as const;
  const people = s.places
    .map((p, i) => {
      const cx = s.places.length === 1 ? w * 0.5 : w * X[p.position];
      return figure(p.cast, cx - size / 2, deskY - size * 0.82, size, p.position === "right" && i > 0);
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="100%" height="100%" fill="${wall}"/>
<rect x="0" y="${h * 0.62}" width="${w}" height="${h * 0.38}" fill="${wall2}"/>
<g stroke="${ink}" stroke-width="8" stroke-linejoin="round">
  <rect x="${w * 0.62}" y="${h * 0.3}" width="${w * 0.28}" height="${h * 0.24}" rx="10" fill="#cfe8ff"/>
  <path d="M${w * 0.76} ${h * 0.3} V${h * 0.54} M${w * 0.62} ${h * 0.42} H${w * 0.9}" fill="none" stroke-width="6"/>
  <rect x="${w * 0.08}" y="${h * 0.36}" width="${w * 0.16}" height="${h * 0.12}" rx="6" fill="#ffffff"/>
  <path d="M${w * 0.11} ${h * 0.44} l${w * 0.03} -${h * 0.04} l${w * 0.03} ${h * 0.02} l${w * 0.04} -${h * 0.04}" fill="none" stroke="#e05a47" stroke-width="6"/>
</g>
${people}
<g stroke="${ink}" stroke-width="8" stroke-linejoin="round">
  <rect x="-10" y="${deskY}" width="${w + 20}" height="${h - deskY + 10}" fill="#c98f5a"/>
  <rect x="${w * 0.36}" y="${deskY - h * 0.08}" width="${w * 0.28}" height="${h * 0.08}" rx="8" fill="#9aa3ad"/>
  <path d="M${w * 0.06} ${deskY} q${w * 0.03} -${h * 0.1} ${w * 0.08} -${h * 0.12} M${w * 0.1} ${deskY} q-${w * 0.01} -${h * 0.08} ${w * 0.04} -${h * 0.14}" fill="none" stroke="#3f8f4a" stroke-width="10"/>
  <rect x="${w * 0.84}" y="${deskY - h * 0.06}" width="${w * 0.07}" height="${h * 0.06}" rx="6" fill="#ffffff"/>
</g>
</svg>`;
}
