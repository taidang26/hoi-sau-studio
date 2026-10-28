import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { addTouchingInk, finishPanel, heldPhrases, segmentPhrases, type Segmenter } from "./finish.js";
import type { Profile } from "./profile.js";

const profile = (look: Partial<Profile["look"]>, species = "slow loris (cu li)", name = "Lolo") =>
  ({ name, species, look: { style: "", description: "", signature: [], palette: [], props: [], expressions: {}, character_sheet: null, ...look } }) as unknown as Profile;

test("segmentPhrases: colour + garment first, hyphens spaced, then species", () => {
  const p = profile({ description: "A chubby slow loris. Wears an oversized mustard-yellow hoodie with sleeves past the wrists." });
  assert.deepEqual(segmentPhrases(p), ["animal in mustard yellow hoodie", "animal in yellow hoodie", "slow loris", "cartoon animal"]);
  const rico = profile({ description: "Wears a tight slim-fit lilac shirt, a skinny black tie." }, "ferret-badger (chồn bạc má)", "Rico");
  assert.deepEqual(segmentPhrases(rico), ["animal in lilac shirt", "animal in purple shirt", "ferret badger", "cartoon animal"]);
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

test("withDuplicateCheck fails a panel with a cast member drawn twice and says to remove the copy", async () => {
  const { withDuplicateCheck } = await import("./episode.js");
  const ok = withDuplicateCheck({ pass: true, fix: "", issues: [], counts: [{ character: "cu-li", count: 1 }] });
  assert.equal(ok.pass, true);
  assert.equal("counts" in ok, false);
  const twice = withDuplicateCheck({ pass: true, fix: "", issues: [], counts: [{ character: "cu-li", count: 2 }, { character: "cay-muc", count: 1 }] }, () => "Lolo");
  assert.equal(twice.pass, false);
  assert.match(twice.fix, /Lolo is drawn 2 times: keep only the copy doing the scene's action and erase the other completely/);
  const placed = withDuplicateCheck(
    { pass: true, fix: "", issues: [], counts: [{ character: "cu-li", count: 2 }], heads: [{ character: "cu-li", x: 0.15, y: 0.47 }, { character: "cu-li", x: 0.2, y: 0.75 }] },
    () => "Lolo",
    "reclining with tea",
  );
  assert.match(placed.fix, /head about 15% from the left and 47% from the top; one with its head about 20% from the left and 75% from the top\): keep only the copy doing the scene's action \(reclining with tea\)/);
  assert.deepEqual(twice.issues, [{ character: "cu-li", feature: "drawn once", problem: "appears 2 times" }]);
});

// A panel with clear line art: boxes at different places, so alignment has something to lock on to.
async function lineArt(): Promise<Buffer> {
  const boxes = [[60, 80, 200, 260], [300, 120, 460, 420], [120, 420, 380, 600], [420, 520, 500, 620]]
    .map(([x0, y0, x1, y1]) => `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="#f5c542" stroke="#000" stroke-width="6"/>`)
    .join("");
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="640"><rect width="512" height="640" fill="#efe6d8"/>${boxes}</svg>`)).png().toBuffer();
}

test("alignBack undoes an edit that zoomed into the padded panel", async () => {
  const { alignBack, framingZoom, padPanel } = await import("./finish.js");
  const src = await lineArt();
  const padded = await padPanel(src);
  const zoomed = await sharp(padded).extract({ left: 23, top: 33, width: 466, height: 582 }).resize(512, 640).png().toBuffer(); // about 1.1x, a little low
  assert.ok((await framingZoom(padded, zoomed)) >= 1.05, "the edit zoomed into what it was given");
  const back = await alignBack(src, zoomed);
  assert.ok((await framingZoom(src, back)) < 1.05);
});

test("recolourPanel pads the panel, finds it in the edit and returns it at its own size", async () => {
  const { recolourPanel, RECOLOUR_PROMPT } = await import("./finish.js");
  const src = await lineArt();
  let seen: any;
  // The "edit" hands back exactly what it was given, so the panel must come back unchanged in framing.
  const image = { generate: async (turn: any) => ((seen = turn), { id: "r1", image: Buffer.from(String(turn.references[0]).split(",")[1], "base64"), usage: {}, note: "" }) };
  const out = await recolourPanel(image as any, src, "1024x1280");
  assert.ok(seen.prompt.startsWith(RECOLOUR_PROMPT));
  assert.equal(seen.size, "1024x1280");
  assert.equal(out.recoloured, true);
  assert.ok(out.zoom < 1.05);
  const meta = await sharp(out.image).metadata();
  assert.deepEqual([meta.width, meta.height], [512, 640]);
});
