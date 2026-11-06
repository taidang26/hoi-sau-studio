import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelRotation } from "./rotation.js";

test("a set-aside model comes back when its pause ends", () => {
  let t = 0;
  const r = new ModelRotation(["a", "b"], { now: () => t });
  assert.equal(r.current(), "a");
  assert.equal(r.block("a", 1000), true);
  assert.equal(r.current(), "b");
  t = 1000;
  assert.equal(r.current(), "a");
});

test("all set aside: the one free soonest, and how long to wait", () => {
  let t = 0;
  const r = new ModelRotation(["a", "b"], { now: () => t });
  r.block("a", 5000);
  assert.equal(r.block("b", 2000), false);
  assert.equal(r.current(), "b");
  assert.equal(r.waitMs(), 2000);
});
