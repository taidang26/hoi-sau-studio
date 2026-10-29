/**
 * A placeholder puppet drawn from a character's palette, so the dance module
 * runs before the real parts are cut from a Muse Image drawing. Every part is
 * a full-canvas SVG in the rest drawing's coordinates.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { Bone, Vec } from "./pose.js";

export interface Palette {
  fur: string;
  face: string;
  dark: string;
  eyes: string;
  outfit: string;
}

const W = 600;
const H = 900;
const INK = "#1b1410";

const BONES: Record<Bone, { pivot: Vec; tip: Vec }> = {
  torso: { pivot: [300, 580], tip: [300, 400] },
  head: { pivot: [300, 395], tip: [300, 150] },
  upperArmL: { pivot: [372, 420], tip: [415, 510] },
  foreArmL: { pivot: [415, 510], tip: [440, 600] },
  upperArmR: { pivot: [228, 420], tip: [185, 510] },
  foreArmR: { pivot: [185, 510], tip: [160, 600] },
  thighL: { pivot: [338, 590], tip: [345, 700] },
  shinL: { pivot: [345, 700], tip: [350, 810] },
  thighR: { pivot: [262, 590], tip: [255, 700] },
  shinR: { pivot: [255, 700], tip: [250, 810] },
};

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;

/** A thick rounded limb with an ink outline. */
const limb = ([x1, y1]: Vec, [x2, y2]: Vec, width: number, fill: string) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${INK}" stroke-width="${width + 12}" stroke-linecap="round"/>` +
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${fill}" stroke-width="${width}" stroke-linecap="round"/>`;

export function placeholderParts(c: Palette): { bone: Bone; name: string; svg: string; z: number }[] {
  const b = BONES;
  const head = svg(
    `<g stroke="${INK}" stroke-width="8" stroke-linejoin="round">` +
      `<circle cx="200" cy="175" r="34" fill="${c.fur}"/><circle cx="400" cy="175" r="34" fill="${c.fur}"/>` +
      `<ellipse cx="300" cy="270" rx="135" ry="125" fill="${c.fur}"/>` +
      `<ellipse cx="300" cy="300" rx="95" ry="80" fill="${c.face}"/>` +
      `<ellipse cx="250" cy="275" rx="44" ry="48" fill="${c.dark}"/><ellipse cx="350" cy="275" rx="44" ry="48" fill="${c.dark}"/>` +
      `<circle cx="250" cy="275" r="30" fill="${c.eyes}"/><circle cx="350" cy="275" r="30" fill="${c.eyes}"/>` +
      `</g>` +
      `<circle cx="250" cy="275" r="12" fill="${INK}"/><circle cx="350" cy="275" r="12" fill="${INK}"/>` +
      `<circle cx="256" cy="268" r="5" fill="#fff"/><circle cx="356" cy="268" r="5" fill="#fff"/>` +
      `<path d="M300 150 L300 240" stroke="${c.dark}" stroke-width="16" stroke-linecap="round"/>` +
      `<ellipse cx="300" cy="330" rx="12" ry="8" fill="#e58c8a" stroke="${INK}" stroke-width="5"/>` +
      `<path d="M285 352 Q300 362 315 352" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>`,
  );
  const torso = svg(
    `<path d="M220 400 Q300 375 380 400 L392 590 Q300 612 208 590 Z" fill="${c.outfit}" stroke="${INK}" stroke-width="8" stroke-linejoin="round"/>` +
      `<path d="M262 410 L292 490 M338 410 L308 490" stroke="${INK}" stroke-width="5"/>` +
      `<rect x="280" y="488" width="40" height="50" rx="5" fill="#fff" stroke="${INK}" stroke-width="5"/>`,
  );
  const hand = ([x, y]: Vec) => `<circle cx="${x}" cy="${y}" r="20" fill="${c.fur}" stroke="${INK}" stroke-width="7"/>`;
  const foot = ([x, y]: Vec, dx: number) => `<ellipse cx="${x + dx}" cy="${y + 8}" rx="34" ry="18" fill="${c.dark}" stroke="${INK}" stroke-width="7"/>`;
  return [
    { bone: "thighR", name: "thigh-r", svg: svg(limb(b.thighR.pivot, b.thighR.tip, 46, c.fur)), z: 0 },
    { bone: "shinR", name: "shin-r", svg: svg(limb(b.shinR.pivot, b.shinR.tip, 40, c.fur) + foot(b.shinR.tip, -12)), z: 1 },
    { bone: "thighL", name: "thigh-l", svg: svg(limb(b.thighL.pivot, b.thighL.tip, 46, c.fur)), z: 0 },
    { bone: "shinL", name: "shin-l", svg: svg(limb(b.shinL.pivot, b.shinL.tip, 40, c.fur) + foot(b.shinL.tip, 12)), z: 1 },
    { bone: "torso", name: "torso", svg: torso, z: 2 },
    { bone: "upperArmR", name: "upper-arm-r", svg: svg(limb(b.upperArmR.pivot, b.upperArmR.tip, 44, c.outfit)), z: 3 },
    { bone: "foreArmR", name: "fore-arm-r", svg: svg(limb(b.foreArmR.pivot, b.foreArmR.tip, 40, c.outfit) + hand(b.foreArmR.tip)), z: 4 },
    { bone: "upperArmL", name: "upper-arm-l", svg: svg(limb(b.upperArmL.pivot, b.upperArmL.tip, 44, c.outfit)), z: 3 },
    { bone: "foreArmL", name: "fore-arm-l", svg: svg(limb(b.foreArmL.pivot, b.foreArmL.tip, 40, c.outfit) + hand(b.foreArmL.tip)), z: 4 },
    { bone: "head", name: "head", svg: head, z: 5 },
  ];
}

/** Writes rig.yaml and the parts into `dir`. */
export function writePlaceholderRig(dir: string, name: string, palette: Palette): void {
  mkdirSync(dir, { recursive: true });
  const parts = placeholderParts(palette).map((p) => {
    writeFileSync(join(dir, `${p.name}.svg`), p.svg);
    return { name: p.name, bone: p.bone, image: `${p.name}.svg`, at: [0, 0], size: [W, H], z: p.z };
  });
  const doc = { name, placeholder: true, size: [W, H], bones: BONES, parts };
  writeFileSync(join(dir, "rig.yaml"), `# Placeholder puppet for ${name}, drawn from the palette. Replace with parts cut from the model sheet.\n${stringify(doc, { flow: false })}`);
}

/** Picks puppet colours from a profile palette by name where it can (eyes, outfit), else by order. */
export function paletteFrom(entries: { name: string; hex: string }[]): Palette {
  const find = (re: RegExp) => entries.find((e) => re.test(e.name))?.hex;
  const hex = entries.map((e) => e.hex);
  return {
    fur: hex[0] ?? "#B07A4F",
    face: hex[1] ?? "#F3E2C7",
    dark: hex[2] ?? "#5A3A24",
    eyes: find(/\beyes?\b/i) ?? "#2b2320",
    outfit: find(/hoodie|blazer|shirt|suit|jacket|dress|tee|cardigan|vest|outfit/i) ?? hex[0] ?? "#E3B23C",
  };
}
