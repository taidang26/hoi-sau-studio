import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { addTouchingInk, finishPanel, heldPhrases, segmentPhrases, type Segmenter } from "./finish.js";
import type { Profile } from "./profile.js";

const profile = (look: Partial<Profile["look"]>, species = "slow loris (cu li)", name = "Lolo") =>
  ({ name, species, look: { style: "", description: "", signature: [], palette: [], props: [], expressions: {}, character_sheet: null, ...look } }) as unknown as Profile;

test("segmentPhrases: colour + garment first, hyphens spaced, then species", () => {
  const p = profile({ description: "A chubby slow loris. Wears an oversized mustard-yellow hoodie with sleeves past the wrists." });
  assert.deepEqual(segmentPhrases(p), ["animal in mustard yellow hoodie", "slow loris", "cartoon animal"]);
  const boss = profile({ description: "Wears a black snapback cap and a sharp navy-blue boss suit." }, "binturong (cầy mực)", "Bino");
  assert.equal(segmentPhrases(boss)[0], "animal in navy blue suit");
});

test("heldPhrases: only what the icon says is carried", () => {
  assert.deepEqual(heldPhrases(profile({ icon: "the huge white walrus moustache and the white cat in his arm" })), ["white cat in his arm"]);
  assert.deepEqual(heldPhrases(profile({ icon: "the oversized mustard-yellow hoodie" })), []);
});

// 200x200 white picture: a "character" block in the middle, a small inked card touching its top,
// a far inked square in the corner and a long desk line touching the character.
const W = 200, H = 200;
function scene() {
  const rgb = Buffer.alloc(W * H * 3, 255);
  const ink = (x: number, y: number) => rgb.fill(0, (y * W + x) * 3, (y * W + x) * 3 + 3);
  const box = (x0: number, y0: number, x1: number, y1: number) => {
    for (let x = x0; x <= x1; x++) (ink(x, y0), ink(x, y1));
    for (let y = y0; y <= y1; y++) (ink(x0, y), ink(x1, y));
  };
  const character = new Uint8Array(W * H);
  for (let y = 80; y < 160; y++) for (let x = 70; x < 130; x++) {
    character[y * W + x] = 1;
    const k = (y * W + x) * 3;
    rgb[k] = 200, rgb[k + 1] = 120, rgb[k + 2] = 40;
  }
  box(90, 60, 110, 79); // card held up, touching the top
  box(5, 5, 25, 25); // far away
  for (let x = 0; x < W; x++) ink(x, 165); // desk edge right under the character
  return { rgb, character };
}

test("addTouchingInk keeps a held card with its inside, not far shapes or long lines", () => {
  const { rgb, character } = scene();
  const luma = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) luma[i] = rgb[i * 3];
  const near = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let hit = false;
    for (let dy = -3; dy <= 3 && !hit; dy++) for (let dx = -3; dx <= 3; dx++) if (character[(y + dy) * W + (x + dx)]) hit = true;
    near[y * W + x] = hit ? 255 : 0;
  }
  const focus = character.slice();
  assert.equal(addTouchingInk(focus, luma, near, W, H), 1);
  assert.equal(focus[70 * W + 100], 1, "inside of the card");
  assert.equal(focus[15 * W + 15], 0, "far square");
  assert.equal(focus[165 * W + 10], 0, "desk line");
});

test("finishPanel: main character sharp, far shapes softened", async () => {
  const { rgb, character } = scene();
  const png = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const sam: Segmenter = {
    segment: async (phrase, _url, w, h) => (phrase.startsWith("animal in") ? [{ width: w, height: h, mask: character }] : []),
  };
  const lolo = profile({ description: "Wears an oversized mustard-yellow hoodie." });
  const { image, focusShare } = await finishPanel(png, sam, { characters: [lolo], grain: 0, vignette: 0 });
  assert.ok(focusShare > 0.1);
  const out = await sharp(image).removeAlpha().raw().toBuffer();
  // A pixel on the far square's ink is washed out by the blur; one inside the character is unchanged.
  assert.ok(out[(5 * W + 15) * 3] > 60, "far ink softened");
  const k = (120 * W + 100) * 3;
  assert.deepEqual([out[k], out[k + 1], out[k + 2]], [200, 120, 40]);
});

test("finishPanel leaves the panel alone when no character is found", async () => {
  const { rgb } = scene();
  const png = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const none: Segmenter = { segment: async () => [] };
  const r = await finishPanel(png, none, { characters: [profile({})] });
  assert.equal(r.focusShare, 0);
  assert.equal(r.image, png);
});
