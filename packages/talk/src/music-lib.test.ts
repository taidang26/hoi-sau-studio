import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeLibrary, MOODS, moodOf, moodsOnHand, takeTrack } from "./music-lib.js";

test("the music library is made once, and memes take the least used track of their mood", () => {
  const root = mkdtempSync(join(tmpdir(), "hoisau-music-"));
  const out = join(root, "music.wav");
  assert.equal(takeTrack(root, MOODS[0].prompt, out, 10), false, "an empty library leaves it to MusicGen");
  const seeds: number[] = [];
  assert.equal(makeLibrary(root, (f, _s, _p, seed) => { seeds.push(seed); writeFileSync(f, `track ${seed}`); }, 2), MOODS.filter((m) => !m.envato).length * 2, "Envato-only moods are never made");
  assert.equal(makeLibrary(root, () => assert.fail("nothing to make"), 2), 0);
  assert.deepEqual(seeds.slice(0, 2), [1, 2], "each track has its own seed");
  assert.equal(moodOf("light playful lo-fi office background music, soft marimba and pizzicato, no vocals").name, "vui-nhon");
  assert.equal(moodOf("chan").name, "chan");
  const picked = [1, 2, 3].map(() => (takeTrack(root, "", out, 12), readFileSync(out, "utf8")));
  assert.deepEqual(picked, ["track 1", "track 2", "track 1"], "rotates");
  assert.equal(takeTrack(root, "", out, 30), false, "longer than a track: MusicGen");
  assert.ok(existsSync(join(root, "series", "music", "used.json")));
  assert.ok(!moodsOnHand(root).includes("lang-man"));
  // An Envato track of the mood goes before the MusicGen ones.
  writeFileSync(join(root, "series", "music", "vui-nhon-env1.wav"), "envato");
  takeTrack(root, "", out, 12);
  assert.equal(readFileSync(out, "utf8"), "envato");
});
