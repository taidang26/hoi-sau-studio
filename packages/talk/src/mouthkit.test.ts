import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHARACTERS_DIR, openStudio } from "@hoi-sau/studio";
import type { Sam } from "@hoi-sau/dance";
import { blendPatch, eraseMouth, kitDir, loadKit, makeMouthKit, noseOffset, pasteKit, pickAngle, placeShape, SHAPES, type MouthKit } from "./mouthkit.js";

const rect = (w: number, h: number, x0: number, y0: number, x1: number, y1: number) => {
  const m = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1;
  return m;
};

test("the kit angle follows the nose, mirrored when the face turns the other way", () => {
  const kit = { slug: "x", angles: [{ angle: "front", base: { w: 40, cx: 500, top: 600 }, nose: 0, shapes: [] }, { angle: "side", base: { w: 40, cx: 500, top: 600 }, nose: 0.5, shapes: [] }] } as MouthKit;
  assert.equal(pickAngle(kit, 0.05)!.angle.angle, "front");
  assert.equal(pickAngle(kit, undefined)!.angle.angle, "front");
  assert.deepEqual([pickAngle(kit, 0.6)!.angle.angle, pickAngle(kit, 0.6)!.mirror], ["side", false]);
  assert.equal(pickAngle(kit, -0.6)!.mirror, true);
  assert.equal(noseOffset({ x: 100, y: 0, w: 20, h: 5 }, { x: 115, y: 0, w: 10, h: 5 }), 0.5);
  // A 20 px mouth is half the kit's 40: the shape halves and sits on the mouth's top centre, mirrored about it.
  const shape = { name: "open", file: "", ox: -30, oy: -4, w: 50, h: 30 };
  assert.deepEqual(placeShape(kit.angles[0], shape, { x: 100, y: 200, w: 20, h: 6 }, false), { s: 0.5, x: 95, y: 198, w: 25, h: 15 });
  assert.equal(placeShape(kit.angles[0], shape, { x: 100, y: 200, w: 20, h: 6 }, true).x, 100);
});

test("erasing a mouth fills it with the skin around it and leaves the nose; a patch never covers the nose", () => {
  const w = 40, h = 40, data = Buffer.alloc(w * h * 3, 200);
  const mouth = rect(w, h, 15, 20, 25, 23), nose = rect(w, h, 18, 12, 22, 16);
  for (let i = 0; i < w * h; i++) if (mouth[i]) data.fill(10, i * 3, i * 3 + 3); else if (nose[i]) data.fill(50, i * 3, i * 3 + 3);
  const clean = eraseMouth({ data, width: w, height: h }, mouth, 1, nose);
  assert.equal(clean.data[(21 * w + 20) * 3], 200);
  assert.equal(clean.data[(14 * w + 20) * 3], 50);
  const patch = Buffer.alloc(10 * 10 * 4, 0);
  for (let i = 0; i < 100; i++) patch.set([0, 0, 0, 255], i * 4);
  const out = blendPatch(clean, patch, 10, 10, 15, 10, nose);
  assert.equal(out.data[(14 * w + 20) * 3], 50);
  assert.equal(out.data[(11 * w + 16) * 3], 0);
});

test("the kit is drawn once per angle, cut by SAM, and pasted in place of a picture's mouth", async () => {
  const chars = mkdtempSync(join(tmpdir(), "hoisau-kit-"));
  cpSync(CHARACTERS_DIR, chars, { recursive: true });
  const ctx = openStudio({ mock: true, charactersDir: chars });
  const sam = {
    segment: async (ph: string, _url: string, w: number, h: number) =>
      ph.startsWith("cartoon") ? [{ mask: rect(w, h, 0, 0, w, h), score: 0.9 }]
      : ph.startsWith("nose") ? [{ mask: rect(w, h, w / 2 - 20, h / 2 - 60, w / 2 + 20, h / 2 - 30), score: 0.9 }]
      : ph.includes("mouth") || ph === "mouth" ? [{ mask: rect(w, h, w / 2 - 40, h / 2, w / 2 + 40, h / 2 + 16), score: 0.9 }]
      : [],
  } as unknown as Sam;
  const kit = await makeMouthKit(ctx, sam, "cu-li");
  assert.deepEqual(kit.angles.map((a) => a.angle), ["front", "side"]);
  assert.equal(kit.angles[0].shapes.length, SHAPES.length);
  assert.ok(existsSync(join(kitDir(chars, "cu-li"), "front-open.png")));
  assert.ok(existsSync(join(kitDir(chars, "cu-li"), "sheet.jpg")));
  assert.deepEqual(loadKit(chars, "cu-li"), kit);
  // Asked again, nothing is drawn: the kit is kept.
  let drawn = 0;
  const counting = { ...ctx, image: { ...ctx.image, generate: async (...a: never[]) => { drawn++; return (ctx.image.generate as (...x: never[]) => Promise<unknown>)(...a); } } } as typeof ctx;
  await makeMouthKit(counting, sam, "cu-li");
  assert.equal(drawn, 0);
  const w = 200, h = 200, base = { data: Buffer.alloc(w * h * 3, 180), width: w, height: h };
  const mouth = { mask: rect(w, h, 90, 120, 110, 124), box: { x: 90, y: 120, w: 20, h: 4 } };
  const pasted = await pasteKit(chars, kit, base, mouth, "open", pickAngle(kit, 0)!);
  assert.ok(pasted && !pasted.data.equals(base.data));
});

test("the skin round a mouth tells one character's face from another's", async () => {
  const { ringColour, colourGap, KIT_SKIN_GAP } = await import("./mouthkit.js");
  const w = 30, h = 30, tan = Buffer.alloc(w * h * 3), dark = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { tan.set([210, 160, 110], i * 3); dark.set([60, 50, 50], i * 3); }
  const mouth = rect(w, h, 12, 14, 18, 16);
  const a = ringColour({ data: tan, width: w, height: h }, mouth), b = ringColour({ data: dark, width: w, height: h }, mouth);
  assert.deepEqual(a, [210, 160, 110]);
  assert.ok(colourGap(a, b) > KIT_SKIN_GAP);
});
