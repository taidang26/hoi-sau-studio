/**
 * Phông văn phòng: the rooms of the Hồi Sau office drawn once, empty, and handed to Muse Image as a
 * reference whenever a scene happens in one, so the boss's office or the pantry looks the same in every clip.
 *
 *   series/backgrounds/<name>.png        an empty room, vertical 1080x1920
 *   series/backgrounds/backgrounds.json  name, Vietnamese label, approved
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSoftly, SERIES_DIR, styleReference, type StudioContext } from "@hoi-sau/studio";
import { OUT } from "./timeline.js";

export interface Room {
  name: string;
  vi: string;
  /** English, for Muse Image: the empty room. */
  text: string;
  /** Words in a scene (English act) that put it in this room. */
  words: RegExp;
}

export const ROOMS: Room[] = [
  { name: "ban-lam-viec", vi: "Bàn làm việc", text: "the open-plan office of a small Hanoi company: rows of white desks with monitors and keyboards (screens facing the chairs), black office chairs on the floor, a few potted plants, a window wall with blinds", words: /\b(open[- ]plan|desks? row|coworkers' desks)\b/ },
  { name: "phong-sep", vi: "Phòng sếp", text: "the boss's private office: a big dark wooden desk with one leather executive chair behind it on the floor, a laptop facing the chair, a bookshelf with folders and a trophy, a framed certificate, a window with city view", words: /\b(boss'?s? (private )?office|director'?s office|manager'?s office|executive office)\b/ },
  { name: "phong-hop", vi: "Phòng họp", text: "a meeting room: one long table with chairs around it on the floor, a wall screen showing a plain blue slide, a whiteboard with a few scribbles, a glass wall", words: /\b(meeting room|conference room|meeting table|in a meeting)\b/ },
  { name: "pantry", vi: "Pantry", text: "the office pantry: a counter with a coffee machine, an electric kettle and mugs, a small fridge, a microwave, a round table with two stools on the floor", words: /\b(pantry|kitchen|coffee machine|microwave|break room)\b/ },
  { name: "thang-may", vi: "Thang máy", text: "the lift lobby of an office building: two closed steel lift doors with floor buttons between them, a floor number display above, a polished floor", words: /\b(lift|elevator)\b/ },
  { name: "cham-cong", vi: "Cửa chấm công", text: "the office entrance: a glass door, a fingerprint time-clock machine on the wall beside it, a small reception counter with the Hồi Sau logo as a plain shape (no letters), a wall clock", words: /\b(time[- ]clock|clock(s|ing)? in|check[- ]in machine|fingerprint|entrance|front door|reception)\b/ },
  // Outside the office, only when the joke needs it (the house rule: the office by default).
  { name: "phong-tro", vi: "Phòng trọ", text: "a small rented room in Hanoi: a narrow bed with a crumpled blanket on the floor, a plastic wardrobe, a small desk with a laptop facing the chair, clothes on a rack, one small window", words: /\b(rented room|bedroom|at home|in bed|phòng trọ|boarding room)\b/ },
  { name: "nha-tam", vi: "Nhà tắm", text: "a small tiled bathroom: a wall shower head, a plastic bucket and a scoop on the floor, a small mirror over a basin, a towel on a hook", words: /\b(bathroom|shower|toilet)\b/ },
  { name: "tra-da", vi: "Quán trà đá", text: "a Hanoi street-side iced tea stall on the pavement: low blue plastic stools on the ground, a small low table with glasses of iced tea, a thermos and a jar of sunflower seeds, a tree trunk and a wall behind", words: /\b(iced tea|tea stall|trà đá|street stall|plastic stools?)\b/ },
  { name: "duong-pho", vi: "Đường phố", text: "a busy Hanoi street in the morning: a few parked motorbikes on the road, shop fronts with plain coloured awnings and no lettering, overhead tangled power lines, a pavement", words: /\b(street|motorbike|traffic|scooter|on the road|commut)/ },
];

export const backgroundsDir = (seriesDir = SERIES_DIR) => join(seriesDir, "backgrounds");

export interface RoomEntry { name: string; vi: string; approved: boolean }

export function loadRooms(seriesDir = SERIES_DIR): RoomEntry[] {
  const f = join(backgroundsDir(seriesDir), "backgrounds.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as RoomEntry[]) : [];
}

/** The room a scene happens in, from its English act, when that room has been drawn and approved by the owner. */
export function roomFor(act: string, seriesDir = SERIES_DIR): { room: Room; file: string } | undefined {
  const t = act.toLowerCase();
  const room = ROOMS.find((r) => r.words.test(t));
  const file = room && join(backgroundsDir(seriesDir), `${room.name}.png`);
  const ok = room && loadRooms(seriesDir).some((e) => e.name === room.name && e.approved);
  return room && file && ok && existsSync(file) ? { room, file } : undefined;
}

/** The sentence a scene prompt gets with a room reference (the last reference picture). */
export const roomPrompt = (room: Room) =>
  `The scene takes place in ${room.text.split(":")[0]}: the last reference picture shows that room empty; keep its layout, furniture and colours, seen from the same or a nearby angle, at a size that leaves the characters small in it.`;

/** Draws the missing rooms (or `only`), empty, in the series style. */
export async function makeBackgrounds(ctx: StudioContext, opts: { only?: string[]; seriesDir?: string; log?: (s: string) => void } = {}): Promise<RoomEntry[]> {
  const dir = backgroundsDir(opts.seriesDir);
  mkdirSync(dir, { recursive: true });
  const entries = loadRooms(opts.seriesDir);
  const style = styleReference(ctx.style);
  for (const r of ROOMS) {
    const file = join(dir, `${r.name}.png`);
    if (opts.only ? !opts.only.includes(r.name) : existsSync(file)) continue;
    opts.log?.(`${r.name}: drawing`);
    const res = await generateSoftly(ctx.image, {
      prompt: `Full-frame vertical background for a cartoon office comedy: ${r.text}. Empty: no people, no animals, no characters. Drawn loosely with clean lines and pale flat colour washes, warm daylight. Everything stands on the floor, screens face their chairs, one of each object. No text, no letters, no logos with words. Fill the whole vertical 9:16 frame.`,
      size: `${OUT.w}x${OUT.h}`,
      references: style ? [style] : [],
    }, opts.log);
    writeFileSync(file, res.image);
    const e = { name: r.name, vi: r.vi, approved: false };
    const at = entries.findIndex((x) => x.name === r.name);
    if (at >= 0) entries[at] = e;
    else entries.push(e);
    writeFileSync(join(dir, "backgrounds.json"), `${JSON.stringify(entries, null, 1)}\n`);
  }
  return entries;
}
