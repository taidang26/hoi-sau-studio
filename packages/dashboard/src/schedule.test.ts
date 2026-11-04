import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addHouseRule, houseRulesPrompt, loadHouseRules, removeHouseRule } from "@hoi-sau/studio";
import { fromPlanTime, parsePlan, planFromForm, planText, planTime, randomTimes, Schedule, taskClip } from "./schedule.js";

const HN = 7 * 3_600_000;
const hnMinutes = (iso: string) => Math.round(((Date.parse(iso) + HN) % 86_400_000) / 60_000);

test("plan file: Hanoi times round-trip, comments and bad lines are skipped", () => {
  const slots = parsePlan("# x\n2026-11-05 09:44 pilot-gui500k-15\nnonsense\n2026-11-05 14:39 pilot-luoi-16\n");
  assert.deepEqual(slots.map((s) => s.id), ["pilot-gui500k-15", "pilot-luoi-16"]);
  assert.equal(slots[0].at, "2026-11-05T02:44:00.000Z");
  assert.equal(planTime(slots[0].at), "2026-11-05 09:44");
  assert.equal(fromPlanTime("2026-11-05 09:44"), slots[0].at);
  assert.deepEqual(parsePlan(planText(slots)), slots);
});

test("the clip id comes from the post-clip.ps1 arguments", () => {
  assert.equal(taskClip('-NoProfile -File "C:\\x\\scripts\\post-clip.ps1" pilot-luoi-16'), "pilot-luoi-16");
  assert.equal(taskClip("-File backup.ps1"), undefined);
});

test("random times: 7–23h Hanoi, two hours apart, after now", () => {
  const now = new Date("2026-11-04T10:00:00Z"); // 17:00 Hanoi
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const times = randomTimes(9, now, [3, 5], rand);
  assert.equal(times.length, 9);
  const ms = times.map(Date.parse);
  assert.ok(ms.every((m) => m >= now.getTime() + 30 * 60_000));
  for (const iso of times) assert.ok(hnMinutes(iso) >= 7 * 60 && hnMinutes(iso) <= 23 * 60, iso);
  for (let i = 1; i < ms.length; i++) assert.ok(ms[i] - ms[i - 1] >= 120 * 60_000);
});

test("form: move, drop and add clips; shuffle keeps every clip", () => {
  const cur = [
    { id: "pilot-a-1", at: "2026-11-05T02:00:00.000Z" },
    { id: "pilot-b-2", at: "2026-11-05T06:00:00.000Z" },
  ];
  const f = new URLSearchParams([["at:pilot-a-1", "2026-11-05T10:15"], ["drop", "pilot-b-2"], ["add", "pilot-c-3"], ["do", "save"]]);
  const plan = planFromForm(f, cur, new Date("2026-11-04T10:00:00Z"));
  assert.deepEqual(plan.map((s) => s.id), ["pilot-a-1", "pilot-c-3"]);
  assert.equal(plan[0].at, "2026-11-05T03:15:00.000Z");
  assert.ok(Date.parse(plan[1].at) > Date.parse(plan[0].at));
  const shuffled = planFromForm(new URLSearchParams([["do", "shuffle"], ["perday", "3-4"]]), cur, new Date("2026-11-04T10:00:00Z"));
  assert.deepEqual(shuffled.map((s) => s.id).sort(), ["pilot-a-1", "pilot-b-2"]);
});

test("Windows: reads tasks, installs the plan, removes stale tasks only after it worked", () => {
  const repo = mkdtempSync(join(tmpdir(), "hoisau-sched-"));
  const calls: string[] = [];
  const s = new Schedule({
    repo,
    windows: true,
    run: (script) => {
      calls.push(script);
      if (script.includes("Get-ScheduledTaskInfo"))
        return { code: 0, out: JSON.stringify([{ name: "HoiSau post pilot-a-1", args: '-File "x\\post-clip.ps1" pilot-a-1', next: "2026-11-05T02:00:00Z" }, { name: "Backup", args: "-File b.ps1", next: "" }]) };
      return { code: 1, out: "Access denied" };
    },
  });
  const l = s.list();
  assert.equal(l.source, "windows");
  assert.deepEqual(l.slots.map((x) => x.id), ["pilot-a-1"]);
  assert.deepEqual(l.unknown, ["Backup"]);
  // No schedule-posts.ps1 in this repo: the plan is written, nothing runs.
  const r = s.save([{ id: "pilot-a-1", at: "2026-11-05T03:00:00.000Z" }]);
  assert.equal(r.installed, false);
  assert.match(readFileSync(s.planFile(), "utf8"), /2026-11-05 10:00 pilot-a-1/);
  assert.ok(!calls.some((c) => c.includes("Unregister")));
});

test("house rules: add, dedupe, prompt block, remove", () => {
  const file = join(mkdtempSync(join(tmpdir(), "hoisau-rules-")), "house-rules.json");
  assert.equal(houseRulesPrompt(["caption"], file), "");
  const r = addHouseRule("caption", "  Caption   ngắn ", "test", file);
  assert.equal(r.text, "Caption ngắn");
  assert.equal(addHouseRule("caption", "caption ngắn", undefined, file).id, r.id);
  addHouseRule("art", "Văn phòng mặc định", undefined, file);
  assert.match(houseRulesPrompt(["caption"], file), /- \[Captions\] Caption ngắn/);
  assert.doesNotMatch(houseRulesPrompt(["caption"], file), /Văn phòng/);
  removeHouseRule(r.id, file);
  assert.deepEqual(loadHouseRules(file).map((x) => x.area), ["art"]);
});

test("one site address: /tai links follow MEDIA_BASE_URL, and the QR code is plain SVG", async () => {
  const { siteUrl, taiUrl, qrSvg, mediaBaseUrl, SITE_DEFAULT } = await import("./phone.js");
  assert.equal(siteUrl({}), SITE_DEFAULT);
  assert.equal(mediaBaseUrl({}), `${SITE_DEFAULT}/media/`);
  assert.equal(siteUrl({ MEDIA_BASE_URL: "https://x.example/media" }), "https://x.example");
  assert.equal(taiUrl("v-abc", {}), `${SITE_DEFAULT}/tai#v-abc`);
  const svg = qrSvg(taiUrl("v-abc", {}));
  assert.match(svg, /^<svg class="qr"[^>]+viewBox="0 0 \d+ \d+"/);
  assert.doesNotMatch(svg, /<script/);
});
