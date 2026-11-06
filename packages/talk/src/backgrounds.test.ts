import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openStudio } from "@hoi-sau/studio";
import { backgroundsDir, loadRooms, makeBackgrounds, roomFor, ROOMS } from "./backgrounds.js";

test("office rooms are drawn once and used for scenes in them only after the owner approves", async () => {
  const series = mkdtempSync(join(tmpdir(), "hoisau-rooms-"));
  const ctx = openStudio({ mock: true });
  await makeBackgrounds(ctx, { seriesDir: series, only: ["phong-sep", "pantry"] });
  assert.deepEqual(loadRooms(series).map((r) => [r.name, r.approved]), [["phong-sep", false], ["pantry", false]]);
  assert.equal(roomFor("stands in the boss's office looking scared", series), undefined);
  writeFileSync(join(backgroundsDir(series), "backgrounds.json"), JSON.stringify(loadRooms(series).map((r) => ({ ...r, approved: true }))));
  assert.equal(roomFor("stands in the boss's office looking scared", series)?.room.name, "phong-sep");
  assert.equal(roomFor("makes instant noodles at the microwave", series)?.room.name, "pantry");
  assert.equal(roomFor("waits for the elevator", series), undefined);
  assert.equal(roomFor("sits at the desk", series), undefined);
  assert.equal(ROOMS.length, 6);
});
