/**
 * The office floor plan: series/office.yaml. Who sits where, which wall has
 * the windows, where the meeting room and pantry are, and the background
 * coworkers who fill the room. Storyboards and panel prompts both read it,
 * so a character's desk and the light from the windows stay put from one
 * episode to the next. `officePlanSvg` draws the plan for people to check.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { escapeXml } from "@hoi-sau/svg-text";
import { SERIES_DIR } from "./bible.js";

export interface Area {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** English, for prompts. */
  text: string;
}

export interface Desk {
  character: string;
  x: number;
  y: number;
  faces: "windows" | "entrance";
  text: string;
}

export interface Extra {
  label: string;
  /** A landmark id, or a spot of its own. */
  where?: string;
  x?: number;
  y?: number;
  /** Desks drawn on the plan; 2 when not set. */
  desks?: number;
  text: string;
}

export interface Office {
  room: string;
  landmarks: Area[];
  desks: Desk[];
  extras: Extra[];
  background_rule: string;
}

export const OFFICE_SIZE = { w: 10, h: 8 };

/** undefined when the series has no floor plan. */
export function loadOffice(dir = SERIES_DIR): Office | undefined {
  const file = join(dir, "office.yaml");
  if (!existsSync(file)) return undefined;
  const o = parse(readFileSync(file, "utf8")) as Office;
  const errors: string[] = [];
  if (typeof o?.room !== "string") errors.push("room is required");
  if (!Array.isArray(o?.desks) || !o.desks.every((d) => d?.character && typeof d.x === "number" && typeof d.y === "number")) errors.push("desks need { character, x, y }");
  const seen = new Set<string>();
  for (const d of o?.desks ?? []) {
    if (seen.has(d.character)) errors.push(`${d.character} has two desks`);
    seen.add(d.character);
  }
  if (errors.length) throw new Error(`series/office.yaml: ${errors.join("; ")}`);
  return { ...o, landmarks: o.landmarks ?? [], extras: o.extras ?? [], background_rule: o.background_rule ?? "" };
}

/** The plan in words for the storyboard writer: room, landmarks, every desk and the extras. */
export function officeBrief(o: Office): string {
  return [
    o.room.trim(),
    `Landmarks: ${o.landmarks.map((l) => l.text).join("; ")}.`,
    `Desks: ${o.desks.map((d) => d.text).join("; ")}.`,
    `Background coworkers: ${o.extras.map((e) => e.text).join("; ")}.`,
    "Stage characters where the plan puts them; a character at their own desk is in their own seat.",
  ].join(" ");
}

/** The lines a panel prompt needs: the room, the desks of the characters on stage, and the background rule. */
export function officePanelText(o: Office, onStage: string[]): string {
  const desks = o.desks.filter((d) => onStage.includes(d.character)).map((d) => d.text);
  return [
    `Setting, when in the office: ${o.room.trim()}`,
    desks.length ? `Seats from the floor plan: ${desks.join("; ")}.` : "",
    o.background_rule.trim(),
  ]
    .filter(Boolean)
    .join(" ");
}

/** A top-down floor plan as SVG, with each character's desk labelled by name. */
export function officePlanSvg(o: Office, names: Record<string, string>, colours: Record<string, string> = {}, scale = 100): string {
  const W = OFFICE_SIZE.w * scale;
  const H = OFFICE_SIZE.h * scale;
  const pad = 40;
  const s = (v: number) => Number((v * scale).toFixed(1));
  const text = (x: number, y: number, t: string, size = 22, weight = 600, fill = "#2b2b2b") =>
    `<text x="${x}" y="${y}" font-family="Be Vietnam Pro, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="middle">${escapeXml(t)}</text>`;
  const areas = o.landmarks
    .map((l) =>
      l.id === "windows"
        ? `<rect x="${s(l.x)}" y="${s(l.y)}" width="${s(l.w)}" height="${s(l.h)}" fill="#bfe3ff"/>${text(s(l.x + l.w / 2), s(l.y + l.h) + 26, l.label, 20, 600, "#3a78a8")}`
        : `<rect x="${s(l.x)}" y="${s(l.y)}" width="${s(l.w)}" height="${s(l.h)}" rx="10" fill="#f3efe6" stroke="#b9ad97" stroke-width="3"/>${text(s(l.x + l.w / 2), s(l.y + l.h / 2) + 8, l.label, 20, 600, "#7a6a50")}`,
    )
    .join("");
  const desk = (x: number, y: number, fill: string, stroke = "#a5825c") => `<rect x="${s(x) - 55}" y="${s(y) - 35}" width="110" height="70" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="3"/>`;
  const team = o.desks
    .map((d) => {
      const c = colours[d.character] ?? "#ffd77a";
      // A chair on the side the character sits.
      const cy = d.faces === "entrance" ? s(d.y) - 55 : s(d.y) + 55;
      return `${desk(d.x, d.y, "#f2dcb8")}<circle cx="${s(d.x)}" cy="${cy}" r="24" fill="${c}" stroke="#2b2b2b" stroke-width="3"/>${text(s(d.x), s(d.y) + 8, names[d.character] ?? d.character, 22, 800)}`;
    })
    .join("");
  const extras = o.extras
    .filter((e) => typeof e.x === "number")
    .map((e) => {
      const n = e.desks ?? 2;
      const row = Array.from({ length: n }, (_, i) => desk(e.x! + i * 1.2, e.y!, "#ece8e0", "#b8b0a2")).join("");
      return `${row}${text(s(e.x! + ((n - 1) * 1.2) / 2), s(e.y!) + 70, e.label, 18, 500, "#8a8274")}`;
    })
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W + 2 * pad}" height="${H + 2 * pad + 40}" viewBox="${-pad} ${-pad} ${W + 2 * pad} ${H + 2 * pad + 40}">` +
    `<rect x="${-pad}" y="${-pad}" width="${W + 2 * pad}" height="${H + 2 * pad + 40}" fill="#ffffff"/>` +
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#fbf8f2" stroke="#2b2b2b" stroke-width="5"/>` +
    areas +
    extras +
    `<rect x="${s(0.4)}" y="${s(0.4)}" width="${s(3.0)}" height="${s(2.8)}" rx="16" fill="none" stroke="#e0a34a" stroke-width="3" stroke-dasharray="10 8"/>` +
    text(s(1.9), s(3.5), "Team Hồi Sau", 20, 700, "#c98422") +
    team +
    text(W / 2, H + 34, "Lối vào ↓  (khung nhìn từ lối vào về phía cửa sổ)", 18, 500, "#8a8274") +
    "</svg>"
  );
}
