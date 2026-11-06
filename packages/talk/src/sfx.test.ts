import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { availableSfx, sfxDir, sfxFile, sfxMix } from "./sfx.js";

test("only made sounds are offered, and the mix lands the sound at the punchline", () => {
  const root = mkdtempSync(join(tmpdir(), "hoisau-sfx-"));
  assert.deepEqual(availableSfx(root), []);
  mkdirSync(sfxDir(root), { recursive: true });
  writeFileSync(join(sfxDir(root), "ting.wav"), "x");
  assert.deepEqual(availableSfx(root).map((s) => s.name), ["ting"]);
  assert.ok(sfxFile(root, "ting"));
  assert.equal(sfxFile(root, "boing"), undefined);
  assert.equal(sfxFile(root, undefined), undefined);
  assert.match(sfxMix(true, 2.5, 8), /adelay=2500\|2500/);
  assert.match(sfxMix(true, 2.5, 8), /afade=t=out:st=6\.80/);
  assert.doesNotMatch(sfxMix(false, 1, 8), /afade/);
});
