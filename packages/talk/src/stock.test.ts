import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { CHARACTERS_DIR, openStudio } from "@hoi-sau/studio";
import type { Sam } from "@hoi-sau/dance";
import { planMeme } from "./meme.js";
import { approveStock, availableStock, loadStock, makeStock, partnerOf, REACTIONS, reactionsFor, stockDir, useStock } from "./stock.js";

const chars = mkdtempSync(join(tmpdir(), "hoisau-stock-"));
// Profiles and model sheets only: the real stock, mouth kits and outfits are large and would change the answers.
cpSync(CHARACTERS_DIR, chars, { recursive: true, filter: (src) => !/[\\/](stock|mouthkit|seasons|talk)([\\/]|$)/.test(src.slice(CHARACTERS_DIR.length)) });
const meme = mkdtempSync(join(tmpdir(), "hoisau-meme-"));
after(() => {
  rmSync(chars, { recursive: true, force: true });
  rmSync(meme, { recursive: true, force: true });
});
const noSam = { segment: async () => [] } as unknown as Sam;

test("reactions are drawn once, wait for the owner's approval, then stand in for the punchline scene", async () => {
  const base = openStudio({ mock: true, charactersDir: chars });
  // The mock knows the drawing check but not the pose check: a pose that passes.
  const checks = { json: (name: string, schema: never, messages: never) => (name === "frame_check" ? Promise.resolve({ pass: true, problems: [], fix: "" }) : base.spark.json(name, schema, messages)) };
  const ctx = { ...base, spark: checks } as never as typeof base;
  const made = await makeStock(ctx, noSam, "cu-li", { only: ["guc-ban", "om-dau"] });
  assert.deepEqual(made.map((e) => e.name).sort(), ["guc-ban", "om-dau"]);
  assert.ok(made.every((e) => !e.approved), "new reactions start unapproved");
  assert.ok(existsSync(join(stockDir(chars, "cu-li"), "guc-ban.png")));
  assert.ok(existsSync(join(stockDir(chars, "cu-li"), "sheet.jpg")));
  assert.deepEqual(availableStock(chars, "cu-li"), [], "nothing unapproved is offered");
  approveStock(chars, "cu-li", ["guc-ban"]);
  assert.deepEqual(availableStock(chars, "cu-li", "2026-11-07").map((e) => e.name), ["guc-ban"]);

  // Muse Spark picks it for scene 2: the shot takes the reaction alone, with no new pose to draw.
  const offered = availableStock(chars, "cu-li", "2026-11-07");
  const spark = { json: async () => ({ shots: [{ act: "Tũn reads a message", pose: "looks up", cast: [], moving: ["character"], stock: "" }, { act: "x", pose: "y", cast: ["cay-muc"], moving: ["character"], stock: "guc-ban" }] }) };
  const plan = await planMeme({ ...ctx, spark } as never, "cu-li", { top: "Lương về", punch: "Lương đi", scenes: ["", ""], music: "", seconds: 0 }, offered);
  assert.equal(plan.shots[1].stock, "guc-ban");
  assert.deepEqual(plan.shots[1].cast, []);
  assert.equal(plan.shots[0].stock, undefined);
  // A name that was not offered is ignored.
  const other = await planMeme({ ...ctx, spark: { json: async () => ({ shots: [{ act: "a", pose: "", cast: [], moving: ["character"], stock: "" }, { act: "b", pose: "", cast: [], moving: ["character"], stock: "om-dau" }] }) } } as never, "cu-li", { top: "a", punch: "b", scenes: ["", ""], music: "", seconds: 0 }, offered);
  assert.equal(other.shots[1].stock, undefined);

  const shots = join(meme, "shots");
  useStock(chars, plan, shots, "meme-1");
  assert.deepEqual(readFileSync(join(shots, "s02.png")), readFileSync(join(stockDir(chars, "cu-li"), "guc-ban.png")));
  assert.ok(!existsSync(join(shots, "s01.png")), "the first scene is still drawn as usual");
  assert.equal(loadStock(chars, "cu-li").find((e) => e.name === "guc-ban")!.used[0].clip, "meme-1");
  assert.deepEqual(availableStock(chars, "cu-li"), [], "a used reaction rests a few days");
  assert.equal(REACTIONS.length, 22);
  // A two-person reaction gets the director as the boss, or a colleague when the lead is the director.
  assert.equal(partnerOf(base, "cu-li", "boss"), "cay-muc");
  assert.notEqual(partnerOf(base, "cay-muc", "boss"), "cay-muc");
  assert.equal(partnerOf(base, "cu-li", undefined), undefined);
  // The director gets no "boss" reactions: nobody is drawn as his boss.
  assert.ok(reactionsFor(base, "cay-muc").every((r) => r.with !== "boss"));
  assert.equal(reactionsFor(base, "cu-li").length, REACTIONS.length);
  assert.ok(!REACTIONS.some((r) => /\bhair\b/.test(r.act)), "no reaction asks for hair: most of the cast has none");
  assert.ok(REACTIONS.every((r) => /^[a-z-]+$/.test(r.name)));
});
