import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Backup } from "./backup.js";

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
