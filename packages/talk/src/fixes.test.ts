import assert from "node:assert/strict";
import { test } from "node:test";
import { describePlan, speechGaps, validAction, type FixAction } from "./fixes.js";
import type { Plan } from "./illustrate.js";

const plan: Plan = {
  slug: "cu-li",
  clip: "clip.mp4",
  end: 8,
  lines: [{ text: "Mày ạ", start: 0.2, end: 1.8 }, { text: "đi ngủ sớm", start: 5.4, end: 7 }],
  shots: [
    { id: "s01", t: 0, act: "Rico at a concert", pose: "", bubble: "", cast: [] },
    { id: "s02", t: 5, act: "Rico in bed", pose: "turns over", bubble: "Ngủ!", cast: [], src: undefined },
  ],
};
const a = (x: Partial<FixAction>): FixAction => ({ do: "line_text", shot: "", line: -1, text: "", start: -1, end: -1, what: "", find: "", say: "", ...x });

test("the plan reads with times, lines by index and shots by id", () => {
  const d = describePlan(plan);
  assert.match(d, /line 0 \[0\.20–1\.80s\]: "Mày ạ"/);
  assert.match(d, /s02 \[5\.00–8\.00s\]: Rico in bed \| pose 2: turns over \| bubble: "Ngủ!"/);
});

test("edits that point at nothing, or outside the clip, are dropped", () => {
  assert.ok(validAction(plan, a({ line: 0, text: "Mẹ ạ" })));
  assert.ok(!validAction(plan, a({ line: 5, text: "x" })));
  assert.ok(validAction(plan, a({ do: "add_line", text: "Taeyang về", start: 1.9, end: 5.3 })));
  assert.ok(!validAction(plan, a({ do: "add_line", text: "x", start: 6, end: 9 })));
  assert.ok(validAction(plan, a({ do: "fix_detail", shot: "s01", what: "remove the pin", find: "pin" })));
  assert.ok(!validAction(plan, a({ do: "fix_detail", shot: "s09", what: "x" })));
  assert.ok(!validAction(plan, a({ do: "add_shot", start: 0.1, what: "x" })));
});

test("speech with no subtitle is found between lines; a clip full of music says nothing", () => {
  const rate = 1000, pcm = new Int16Array(12 * rate);
  const loud = (s: number, e: number) => { for (let i = s * rate; i < e * rate; i++) pcm[i] = i % 2 ? 8000 : -8000; };
  loud(0.2, 1.8); loud(2, 5); loud(5.4, 7);
  const gaps = speechGaps(pcm, plan.lines, rate);
  assert.equal(gaps.length, 1);
  assert.ok(gaps[0].start >= 1.9 && gaps[0].start <= 2.1 && gaps[0].end >= 4.9, JSON.stringify(gaps));
  loud(0, 12);
  assert.deepEqual(speechGaps(pcm, [], rate), []);
});
