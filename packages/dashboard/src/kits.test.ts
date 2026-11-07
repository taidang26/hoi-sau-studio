import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHARACTERS_DIR, noteDesign } from "@hoi-sau/studio";
import { ReadyMade, readyLink, readyPage } from "./kits.js";

test("ready-made pictures are approved, redrawn and flagged after a redesign from one screen", async () => {
  const chars = mkdtempSync(join(tmpdir(), "hoisau-ready-"));
  cpSync(CHARACTERS_DIR, chars, { recursive: true });
  const dir = join(chars, "cu-li", "stock");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stock.json"), JSON.stringify([{ name: "do-mat", vi: "Đơ mặt", act: "", approved: false, used: [] }, { name: "om-dau", vi: "Ôm đầu", act: "", approved: false, used: [] }]));
  writeFileSync(join(dir, "do-mat.png"), "x");
  noteDesign(dir, "cu-li", chars);
  const runs: string[][] = [];
  const r = new ReadyMade({ charactersDir: () => chars, seriesDir: () => join(chars, "_series"), exec: async (_s, args) => { runs.push(args); return ""; }, cast: () => [{ slug: "cu-li", name: "Tũn" }] });
  assert.match(readyLink(r), /1 tranh chờ duyệt/);
  let html = readyPage(r);
  assert.match(html, /\/ready-media\/cu-li\/stock\/do-mat\.png/);
  assert.doesNotMatch(html, /om-dau\.png/);
  assert.doesNotMatch(html, /Thiết kế nhân vật đã đổi/);
  assert.equal(r.approve("cu-li", "all", true), 1);
  assert.equal(JSON.parse(readFileSync(join(dir, "stock.json"), "utf8"))[0].approved, true);
  assert.throws(() => r.approve("cu-li", "om-dau", true));
  r.redrawStock("cu-li", "do-mat");
  await new Promise((ok) => setTimeout(ok, 10));
  r.redrawKit("cu-li", true);
  assert.deepEqual(runs, [["stock", "cu-li", "--only", "do-mat"], ["mouthkit", "cu-li", "--only", "front,side"]]);
  assert.ok(r.file("cu-li/stock/do-mat.png"));
  assert.equal(r.file("cu-li/../../etc/passwd"), undefined);
  // A new model sheet: the page says to draw them again.
  const profile = join(chars, "cu-li", "profile.yaml");
  writeFileSync(profile, readFileSync(profile, "utf8").replace(/description: /, "description: taller, "));
  html = readyPage(r);
  assert.match(html, /Thiết kế nhân vật đã đổi/);
  assert.match(readyLink(r), /1 nhân vật đổi thiết kế/);
});
