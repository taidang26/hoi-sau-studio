/**
 * Kho phản ứng: reaction pictures of each character, drawn once, checked by the
 * owner, then reused as the punchline scene of text memes. A meme that takes one
 * draws only its first scene, so it costs about half and skips the drawing
 * mistakes a new picture can bring (the owner already approved this one).
 *
 * Each reaction is a full-frame picture in the Hồi Sau office with the meme
 * layout (empty wall on top for the text) plus its second pose, made by the
 * same draw, poses and stabilize steps as any meme, so it plays the same way.
 *
 *   characters/<slug>/stock/stock.json   the entries: name, Vietnamese label, approved, when used
 *   characters/<slug>/stock/<name>.png   pose A; <name>-b2.png pose B on the same background
 *   characters/<slug>/stock/sheet.jpg    every pose A on one sheet, for the owner to approve
 *   characters/<slug>/stock/<name>-blink.png, -s.png, -m.png   shut eyes and the talking mouth pair (stockExtras)
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import type { Sam } from "@hoi-sau/dance";
import { CHARACTERS_DIR, designChanged, noteDesign, type StudioContext } from "@hoi-sau/studio";
import { facesBox } from "./cover.js";
import { drawMouths, drawPoses, drawShots, stabilizePoses, type Plan, type Shot } from "./illustrate.js";
import { MEME_FRAME, makeBlink } from "./meme.js";

export interface Reaction {
  name: string;
  /** What the owner reads on the sheet and the dashboard. */
  vi: string;
  /** English for Muse Image: the picture. */
  act: string;
  /** English: the second pose. */
  pose: string;
  /** For SAM: what moves between the poses. */
  moving: string[];
  /** A second character in the picture: "boss" (the director, or a colleague when the lead is the director) or a slug. */
  with?: string;
}

/** The reactions office jokes land on most (from the Than Thở stock): one clear body and face each. */
export const REACTIONS: Reaction[] = [
  { name: "do-mat", vi: "Đơ mặt", act: "sits at the desk staring blankly straight ahead, face frozen, eyes dead, mouth a flat line", pose: "blinks slowly, the face still frozen", moving: ["character"] },
  { name: "om-dau", vi: "Ôm đầu", act: "stands by the desk clutching the head with both hands in despair", pose: "squeezes the head harder and leans forward", moving: ["character"] },
  { name: "guc-ban", vi: "Gục bàn", act: "slumps face down on the desk next to the laptop, arms hanging, defeated", pose: "one arm twitches weakly on the desk", moving: ["character"] },
  { name: "cuoi-guong", vi: "Cười gượng", act: "sits at the desk with a forced awkward smile, eyebrows up, hands together", pose: "the smile wobbles and the eyes look sideways", moving: ["character"] },
  { name: "tron-man-hinh", vi: "Trốn sau màn hình", act: "hides behind the desk monitor, only the eyes and the top of the head peeking over its edge (the screen faces the character, away from us)", pose: "sinks a little lower behind the monitor", moving: ["character"] },
  { name: "ha-hoc", vi: "Há hốc", act: "stands shocked with the jaw dropped and both hands raised, eyes wide", pose: "leans back a little more, hands higher", moving: ["character"] },
  { name: "ngua-ghe", vi: "Ngửa ghế, hồn lìa khỏi xác", act: "leans far back in the office chair staring at the ceiling, arms hanging, completely drained; the chair stands on the floor", pose: "slides a little lower in the chair", moving: ["character", "chair"] },
  { name: "dem-tien", vi: "Đếm tiền lẻ", act: "sits at the desk sadly counting a few small coins in one open palm", pose: "turns one coin over with a finger", moving: ["character", "coins"] },
  { name: "gat-gu", vi: "Gật gù biết thừa", act: "stands with arms crossed nodding knowingly, eyes half closed, a small smug smile", pose: "the head dips in a nod", moving: ["character"] },
  { name: "khoc-rong", vi: "Khóc ròng", act: "sits at the desk crying comically, two streams of tears, mouth wobbling", pose: "wipes the eyes with the back of one hand", moving: ["character"] },
  { name: "an-mung", vi: "Ăn mừng", act: "jumps up beside the desk with a fist pump, big happy grin", pose: "lands with both fists up", moving: ["character"] },
  { name: "lau-mo-hoi", vi: "Lau mồ hôi", act: "stands nervously wiping the forehead with the back of one hand, an uneasy smile", pose: "glances sideways while still wiping", moving: ["character"] },
  { name: "luot-dien-thoai", vi: "Lướt điện thoại", act: "sits at the desk slouched, scrolling a phone with a bored blank face, the screen facing the character", pose: "the thumb flicks up the screen", moving: ["character", "phone"] },
  { name: "chay-deadline", vi: "Chạy deadline", act: "types frantically at the laptop with both hands, eyes wide, a few sweat drops, papers piled on the desk", pose: "the hands blur over the keys, leaning closer to the screen", moving: ["character"] },
  { name: "ngu-gat", vi: "Ngủ gật", act: "dozes off sitting at the desk, the head drooping forward, eyes shut, a little drool", pose: "the head jerks up half awake", moving: ["character"] },
  { name: "chay-tre", vi: "Chạy trễ giờ", act: "runs in through the office door in a hurry with a backpack, hair messy, a bread roll in the mouth", pose: "the legs swing forward mid-run", moving: ["character"] },
  { name: "nop-don", vi: "Nộp đơn nghỉ", act: "stands holding out a plain white envelope with both hands, a determined serious face", pose: "pushes the envelope a little further forward", moving: ["character", "envelope"] },
  { name: "vi-rong", vi: "Nhìn ví rỗng", act: "sits at the desk holding an open empty wallet upside down, staring into it in despair, one moth flying out", pose: "shakes the wallet once", moving: ["character", "wallet"] },
  { name: "ngoi-hop", vi: "Ngồi họp", act: "sits at the long meeting table in the meeting room with a notebook, eyes glazed, chin propped on one hand", pose: "the chin slips off the hand", moving: ["character"] },
  { name: "sep-giao-viec", vi: "Sếp giao việc", act: "sits at the desk as the boss drops a tall pile of folders on it with a smile; the character stares at the pile", pose: "the pile wobbles and the character slumps", moving: ["character", "folders"], with: "boss" },
  { name: "sep-mang", vi: "Sếp mắng", act: "stands shrinking small in front of the boss, who scolds pointing a finger; the character looks at the floor", pose: "the character shrinks a little more", moving: ["character"], with: "boss" },
  { name: "hong-chuyen", vi: "Hóng chuyện", act: "leans in eagerly with wide curious eyes as a colleague whispers gossip behind one hand", pose: "leans in even closer", moving: ["character"], with: "colleague" },
];

export interface StockEntry {
  name: string;
  vi: string;
  act: string;
  /** The other character in the picture, if any. */
  cast?: string[];
  approved: boolean;
  /** Clip folders that used it, with the day (yyyy-mm-dd). */
  used: Array<{ clip: string; on: string }>;
}

/** The files that go with a reaction picture into a clip: pose B, the blink and the mouth pairs. */
const EXTRAS = ["-b2", "-blink", "-s", "-m", "-b2-s", "-b2-m"];

export const stockDir = (charactersDir: string, slug: string) => join(charactersDir, slug, "stock");

export function loadStock(charactersDir: string, slug: string): StockEntry[] {
  const f = join(stockDir(charactersDir, slug), "stock.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as StockEntry[]) : [];
}

function saveStock(charactersDir: string, slug: string, entries: StockEntry[]): void {
  mkdirSync(stockDir(charactersDir, slug), { recursive: true });
  writeFileSync(join(stockDir(charactersDir, slug), "stock.json"), `${JSON.stringify(entries, null, 1)}\n`);
}

const day = (d = new Date()) => new Date(d.getTime() + 7 * 3600000).toISOString().slice(0, 10);

/** Approved reactions with their picture, minus those used in the last `rest` days (so the feed does not repeat itself). */
export function availableStock(charactersDir: string, slug: string, today = day(), rest = 5): StockEntry[] {
  const cut = new Date(Date.parse(`${today}T00:00:00Z`) - rest * 86400000).toISOString().slice(0, 10);
  return loadStock(charactersDir, slug).filter((e) => e.approved && existsSync(join(stockDir(charactersDir, slug), `${e.name}.png`)) && !e.used.some((u) => u.on > cut));
}

/** The second character of a two-person reaction: the director for "boss" (or Tũn when the lead is the director), a colleague for "colleague". */
export function partnerOf(ctx: Pick<StudioContext, "profiles">, slug: string, who: string | undefined): string | undefined {
  if (!who) return undefined;
  const all = [...ctx.profiles.values()];
  const boss = all.find((c) => /giám đốc|director|founder/i.test(c.role))?.slug;
  const mate = all.find((c) => c.slug !== slug && c.slug !== boss)?.slug;
  if (who === "boss") return boss && boss !== slug ? boss : mate;
  if (who === "colleague") return mate;
  return ctx.profiles.has(who) && who !== slug ? who : undefined;
}

/** The reactions as a plan of one shot each, laid out like a meme picture. */
export function stockPlan(slug: string, reactions: Reaction[], ctx?: Pick<StudioContext, "profiles">): Plan {
  const shots: Shot[] = reactions.map((r) => {
    const other = ctx ? partnerOf(ctx, slug, r.with) : undefined;
    const who = other ? `with ${ctx!.profiles.get(other)!.name}` : "alone in the picture";
    return { id: r.name, t: 0, act: `In the Hồi Sau office, ${who}: ${r.act.replace(/\bthe boss\b|\ba colleague\b/, other ? ctx!.profiles.get(other)!.name : "$&")}. ${MEME_FRAME}`, pose: r.pose, bubble: "", cast: other ? [other] : [], moving: r.moving };
  });
  return { slug, clip: "", end: 1, lines: [], shots };
}

/**
 * Draws the missing reactions (or `only`), with their second poses, and keeps the new ones unapproved.
 * Drawing again (`only`) replaces the pictures and takes the approval back.
 */
export async function makeStock(ctx: StudioContext, sam: Sam, slug: string, opts: { only?: string[]; log?: (s: string) => void } = {}): Promise<StockEntry[]> {
  if (!ctx.profiles.has(slug)) throw new Error(`No character "${slug}".`);
  const cdir = ctx.charactersDir ?? CHARACTERS_DIR;
  const dir = stockDir(cdir, slug), work = join(dir, "_work");
  mkdirSync(work, { recursive: true });
  const have = loadStock(cdir, slug);
  // A changed design (profile look or model sheet) redraws every reaction, and they wait for approval again.
  const stale = designChanged(dir, slug, cdir);
  if (stale) opts.log?.(`${slug}: the design changed since the reactions were drawn; drawing them all again`);
  const todo = REACTIONS.filter((r) => (stale ? true : opts.only ? opts.only.includes(r.name) : !existsSync(join(dir, `${r.name}.png`))));
  if (!todo.length) {
    noteDesign(dir, slug, cdir);
    return have;
  }
  const plan = stockPlan(slug, todo, ctx);
  writeFileSync(join(work, "plan.json"), JSON.stringify(plan, null, 2));
  const only = opts.only || stale ? todo.map((r) => r.name) : undefined;
  await drawShots(ctx, plan, work, { only, log: opts.log });
  await drawPoses(ctx, plan, work, { only, log: opts.log });
  await stabilizePoses(sam, ctx, plan, work, { only, log: opts.log });
  const entries = [...have];
  for (const r of todo) {
    const a = join(work, `${r.name}.png`);
    if (!existsSync(a)) {
      opts.log?.(`${r.name}: not drawn`);
      continue;
    }
    // A new picture: the old pose B, blink and mouths were made for the old one.
    for (const x of EXTRAS) rmSync(join(dir, `${r.name}${x}.png`), { force: true });
    copyFileSync(a, join(dir, `${r.name}.png`));
    const b2 = join(work, `${r.name}-b2.png`);
    if (existsSync(b2)) copyFileSync(b2, join(dir, `${r.name}-b2.png`));
    const old = entries.findIndex((e) => e.name === r.name);
    const shot = plan.shots.find((x) => x.id === r.name)!;
    const entry: StockEntry = { name: r.name, vi: r.vi, act: shot.act.replace(` ${MEME_FRAME}`, ""), ...(shot.cast.length ? { cast: shot.cast } : {}), approved: false, used: old >= 0 ? entries[old].used : [] };
    if (old >= 0) entries[old] = entry;
    else entries.push(entry);
  }
  saveStock(cdir, slug, entries);
  // Not stale (or just redrawn in full): the pictures match the design as it is now.
  noteDesign(dir, slug, cdir);
  await stockSheet(cdir, slug);
  return entries;
}

/** Every reaction's pose A on one sheet with its name, for the owner to look over before approving. */
export async function stockSheet(charactersDir: string, slug: string): Promise<string | undefined> {
  const dir = stockDir(charactersDir, slug);
  const entries = loadStock(charactersDir, slug).filter((e) => existsSync(join(dir, `${e.name}.png`)));
  if (!entries.length) return undefined;
  const tw = 270, th = 480, label = 56, cols = 4, rows = Math.ceil(entries.length / cols);
  const tiles = await Promise.all(
    entries.map(async (e, i) => {
      const pic = await sharp(join(dir, `${e.name}.png`)).resize(tw, th, { fit: "cover" }).png().toBuffer();
      const text = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${label}"><rect width="100%" height="100%" fill="${e.approved ? "#dff3e3" : "#ffffff"}"/><text x="${tw / 2}" y="36" font-family="sans-serif" font-size="22" font-weight="700" text-anchor="middle" fill="#222">${e.approved ? "✓ " : ""}${e.vi.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text></svg>`);
      const x = (i % cols) * tw, y = Math.floor(i / cols) * (th + label);
      return [{ input: pic, left: x, top: y }, { input: text, left: x, top: y + th }];
    }),
  );
  const out = join(dir, "sheet.jpg");
  await sharp({ create: { width: cols * tw, height: rows * (th + label), channels: 3, background: "#ffffff" } }).composite(tiles.flat()).jpeg({ quality: 85 }).toFile(out);
  return out;
}

/** The owner's word on reactions: approved ones may go into memes. `names` "all" means every one that has a picture. */
export function approveStock(charactersDir: string, slug: string, names: string[] | "all", approved = true): StockEntry[] {
  const entries = loadStock(charactersDir, slug);
  for (const e of entries) if (names === "all" || names.includes(e.name)) e.approved = approved;
  saveStock(charactersDir, slug, entries);
  return entries;
}

/**
 * Puts the chosen reaction into a meme's shots folder as its pictures, so draw and poses skip
 * that shot, and notes the use (the same reaction then rests a few days).
 */
export function useStock(charactersDir: string, plan: Plan, shotsDir: string, clip: string, log?: (s: string) => void): void {
  const entries = loadStock(charactersDir, plan.slug);
  let changed = false;
  mkdirSync(shotsDir, { recursive: true });
  for (const s of plan.shots) {
    if (!s.stock || existsSync(join(shotsDir, `${s.id}.png`))) continue;
    const dir = stockDir(charactersDir, plan.slug), a = join(dir, `${s.stock}.png`);
    if (!existsSync(a)) {
      log?.(`${s.id}: reaction ${s.stock} has no picture; drawing the scene instead`);
      s.stock = undefined;
      continue;
    }
    copyFileSync(a, join(shotsDir, `${s.id}.png`));
    for (const x of EXTRAS) if (existsSync(join(dir, `${s.stock}${x}.png`))) copyFileSync(join(dir, `${s.stock}${x}.png`), join(shotsDir, `${s.id}${x}.png`));
    log?.(`${s.id}: ready-made reaction ${s.stock}, nothing to draw`);
    const e = entries.find((x) => x.name === s.stock);
    if (e && !e.used.some((u) => u.clip === clip)) {
      e.used.push({ clip, on: day() });
      changed = true;
    }
  }
  if (changed) saveStock(charactersDir, plan.slug, entries);
}


/**
 * Ready eyes and mouths for every reaction picture, so a clip that takes one draws nothing more:
 * a shut-eye copy for blinks (free, on the machine) and the shut/open mouth pair for lip-sync (the mouth kit first).
 */
export async function stockExtras(ctx: StudioContext, sam: Sam, slug: string, opts: { only?: string[]; log?: (s: string) => void } = {}): Promise<{ blinks: number; mouths: number }> {
  const cdir = ctx.charactersDir ?? CHARACTERS_DIR, dir = stockDir(cdir, slug);
  const species = (ctx.profiles.get(slug)?.species ?? "character").split("(")[0].trim();
  const have = REACTIONS.filter((r) => existsSync(join(dir, `${r.name}.png`)) && (!opts.only || opts.only.includes(r.name)));
  let blinks = 0;
  for (const r of have) {
    const a = join(dir, `${r.name}.png`), out = join(dir, `${r.name}-blink.png`);
    if (existsSync(out) && !opts.only) { blinks++; continue; }
    const rgb = new Uint8Array(await sharp(a).resize(1080, 1920, { fit: "cover" }).removeAlpha().raw().toBuffer());
    const face = await facesBox(sam, rgb, species);
    if (face && makeBlink(a, out, face, opts.log)) blinks++;
  }
  const report = await drawMouths(sam, ctx, stockPlan(slug, have, ctx), dir, { only: opts.only, log: opts.log });
  opts.log?.(`${slug}: ${report.filter((x) => x.ok).length} new mouth pairs`);
  return { blinks, mouths: have.filter((r) => existsSync(join(dir, `${r.name}-m.png`))).length };
}

/**
 * Tries the second pose again for the drawn reactions that have none (or `only`): a reaction with two
 * poses moves in the meme, one with a single picture only blinks. Pose A and its approval stay.
 */
export async function retryPoses(ctx: StudioContext, sam: Sam, slug: string, opts: { only?: string[]; log?: (s: string) => void } = {}): Promise<number> {
  const cdir = ctx.charactersDir ?? CHARACTERS_DIR, dir = stockDir(cdir, slug), work = join(dir, "_work");
  mkdirSync(work, { recursive: true });
  const todo = REACTIONS.filter((r) => existsSync(join(dir, `${r.name}.png`)) && (opts.only ? opts.only.includes(r.name) : !existsSync(join(dir, `${r.name}-b2.png`))));
  if (!todo.length) return 0;
  const plan = stockPlan(slug, todo, ctx), only = todo.map((r) => r.name);
  for (const r of todo) {
    copyFileSync(join(dir, `${r.name}.png`), join(work, `${r.name}.png`));
    for (const x of ["-b", "-b2"]) rmSync(join(work, `${r.name}${x}.png`), { force: true });
  }
  await drawPoses(ctx, plan, work, { only, log: opts.log });
  await stabilizePoses(sam, ctx, plan, work, { only, log: opts.log });
  let made = 0;
  for (const r of todo) {
    const b2 = join(work, `${r.name}-b2.png`);
    if (!existsSync(b2)) continue;
    copyFileSync(b2, join(dir, `${r.name}-b2.png`));
    for (const x of ["-b2-s", "-b2-m"]) rmSync(join(dir, `${r.name}${x}.png`), { force: true });
    made++;
  }
  opts.log?.(`${slug}: ${made}/${todo.length} new second poses`);
  return made;
}
