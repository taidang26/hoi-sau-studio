import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Backup, backupSkips } from "./backup.js";

test("backups copy what is not in git, never the secrets, and keep the last few", () => {
  const root = mkdtempSync(join(tmpdir(), "hoisau-backup-"));
  const data = join(root, "data");
  mkdirSync(join(data, "research"), { recursive: true });
  writeFileSync(join(data, "comments.json"), "[1]");
  writeFileSync(join(data, "research", "a.png"), "png");
  writeFileSync(join(data, ".env"), "SECRET=1");
  let minute = 0;
  const b = new Backup({ sources: [data, join(root, "missing")], dir: () => join(root, "backups"), keep: 2, now: () => new Date(2026, 9, 27, 9, minute++) });
  assert.equal(b.info().count, 0);
  const first = b.run();
  assert.equal(first, "2026-10-27_0900");
  assert.equal(readFileSync(join(root, "backups", first, "data", "comments.json"), "utf8"), "[1]");
  assert.ok(existsSync(join(root, "backups", first, "data", "research", "a.png")));
  assert.ok(!existsSync(join(root, "backups", first, "data", ".env")), "secrets are never copied");
  b.run();
  b.run();
  assert.deepEqual(readdirSync(join(root, "backups")).sort(), ["2026-10-27_0901", "2026-10-27_0902"]);
  assert.equal(b.info().count, 2);
  assert.equal(b.info().last?.name, "2026-10-27_0902");
});

test("backups leave out what the videos can make again, and never fill the drive", () => {
  for (const f of ["data/video/x/x.mp4", "data/video/x/undo/shots/s01.png", "data/video/x/shots/s01-fix1.raw.png", "data/video/x/shots/s01-prev.png", "data/talk/a/voice.m4a", "data/video/x/shots/s01-m.raw.png", "data/.env"])
    assert.ok(backupSkips(f), f);
  for (const f of ["data/video/x/shots/s01.png", "data/video/x/plan.json", "data/video/x/meta.json", "data/research/a.png", "data/comments.json"]) assert.ok(!backupSkips(f), f);
  const root = mkdtempSync(join(tmpdir(), "hoisau-backup-"));
  mkdirSync(join(root, "data"));
  const b = new Backup({ sources: [join(root, "data")], dir: () => join(root, "backups"), freeBytes: () => 2 * 1024 ** 3 });
  assert.throws(() => b.run(), /2.0 GB/);
  assert.equal(b.info().count, 0);
  assert.match(b.info().error ?? "", /chưa sao lưu/);
});
