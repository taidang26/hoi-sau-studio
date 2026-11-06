import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHARACTERS_DIR, openStudio } from "@hoi-sau/studio";
import { planMeme } from "./meme.js";
import { makeSeasons, OUTFITS, outfitOf, seasonRef, seasonsDir } from "./seasons.js";

test("an occasion's meme dresses the lead from the seasonal picture and takes no everyday reaction", async () => {
  const chars = mkdtempSync(join(tmpdir(), "hoisau-seasons-"));
  cpSync(CHARACTERS_DIR, chars, { recursive: true });
  const ctx = openStudio({ mock: true, charactersDir: chars });
  assert.equal(await makeSeasons(ctx, "cu-li", { only: ["tet"] }), 1);
  assert.ok(existsSync(join(seasonsDir(chars, "cu-li"), "tet.png")));
  assert.equal(outfitOf("Tết")?.key, "tet");
  assert.ok(seasonRef(chars, "cu-li", "Tết")?.file);
  assert.equal(seasonRef(chars, "cu-li", "Noel")?.file, undefined);
  assert.equal(seasonRef(chars, "cu-li", undefined), undefined);
  assert.equal(OUTFITS.length, 6);
  let asked = "";
  const spark = { json: async (_n: string, _s: unknown, m: Array<{ content: string }>) => ((asked = m[0].content), { shots: [{ act: "a", pose: "", cast: [], moving: ["character"], stock: "" }, { act: "b", pose: "", cast: [], moving: ["character"], stock: "do-mat" }], sfx: "boing" }) };
  const plan = await planMeme({ ...ctx, spark } as never, "cu-li", { top: "Thưởng Tết năm nay", punch: "là một tràng pháo tay", scenes: ["", ""], music: "", seconds: 0, season: "Tết" }, [{ name: "do-mat", vi: "Đơ mặt", act: "stares" }]);
  assert.equal(plan.season, "Tết");
  assert.ok(plan.shots.every((s) => !s.stock));
  assert.match(asked, /áo dài/);
  assert.doesNotMatch(asked, /ready-made pictures/);
  // A sound that was not offered is dropped.
  assert.equal(plan.sfx, undefined);
});
