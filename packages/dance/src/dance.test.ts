import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { cutRig, writeCutRig } from "./cut.js";
import { paletteFrom, placeholderParts, writePlaceholderRig } from "./placeholder.js";
import { bodyFrame, BONES, cleanTrack, rankTracks } from "./pose.js";
import { renderDance } from "./render.js";
import { apply, loadRig, placement, poseRig } from "./rig.js";
import { decodeSegments, type Segment } from "./sam.js";
import { keepComposition } from "./scene.js";
import { syntheticPoses } from "./synth.js";

const hasFfmpeg = (() => {
  try {
    execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const palette = paletteFrom([
  { name: "fur", hex: "#B07A4F" },
  { name: "face", hex: "#F3E2C7" },
  { name: "patches", hex: "#5A3A24" },
  { name: "eyes", hex: "#F2A93B" },
  { name: "hoodie", hex: "#E3B23C" },
]);

function placeholderRig() {
  const dir = mkdtempSync(join(tmpdir(), "rig-"));
  writePlaceholderRig(dir, "Lolo", palette);
  return loadRig(dir);
}

test("palette picks eyes and outfit by name", () => {
  assert.equal(palette.eyes, "#F2A93B");
  assert.equal(palette.outfit, "#E3B23C");
});

test("a pose equal to the rest pose leaves every part where it was drawn", () => {
  const rig = placeholderRig();
  const angles = Object.fromEntries(BONES.map((b) => [b, Math.atan2(rig.bones[b].tip[1] - rig.bones[b].pivot[1], rig.bones[b].tip[0] - rig.bones[b].pivot[0])]));
  const place = placement(rig, [540, 1200], 900);
  const world = poseRig(rig, { place, body: { hips: [0, 0], angles: angles as never } });
  for (const b of BONES) {
    const p = apply(world[b], rig.bones[b].tip);
    const q = apply(place, rig.bones[b].tip);
    assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6, b);
  }
  assert.deepEqual(apply(place, rig.bones.torso.pivot).map(Math.round), [540, 1200]);
});

test("raising the arm turns the forearm with it, and limits hold the head", () => {
  const rig = placeholderRig();
  const rest = Object.fromEntries(BONES.map((b) => [b, Math.atan2(rig.bones[b].tip[1] - rig.bones[b].pivot[1], rig.bones[b].tip[0] - rig.bones[b].pivot[0])])) as Record<string, number>;
  const up = { ...rest, upperArmL: -Math.PI / 2, foreArmL: -Math.PI / 2, head: rest.head + 2 };
  const world = poseRig(rig, { place: placement(rig, [0, 0], rig.size[1]), body: { hips: [0, 0], angles: up as never }, limit: { head: 0.5 } });
  const shoulder = apply(world.upperArmL, rig.bones.upperArmL.pivot);
  const wrist = apply(world.foreArmL, rig.bones.foreArmL.tip);
  assert.ok(wrist[1] < shoulder[1] - 100, "the hand ends above the shoulder");
  assert.ok(Math.abs(wrist[0] - shoulder[0]) < 5, "straight up");
  const top = apply(world.head, rig.bones.head.tip);
  const neck = rig.bones.head.pivot;
  assert.ok(Math.abs(Math.atan2(top[0] - neck[0], neck[1] - top[1])) <= 0.5 + 1e-9, "the head turns no more than its limit");
});

test("the dancer is the person who moves most; gaps are filled", () => {
  const file = syntheticPoses(2);
  assert.equal(rankTracks(file)[0].id, 2);
  const track = { ...file.tracks[1], frames: file.tracks[1].frames.map((p, i) => (i % 5 === 2 ? null : p)) };
  const clean = cleanTrack(track);
  assert.equal(clean.length, track.frames.length);
  assert.ok(clean.every((p) => p[11][2] > 0), "every frame has hips after filling");
  const f = bodyFrame(clean[0]);
  assert.ok(f.angles.torso < 0, "the torso points up the screen");
});

test("SAM output text decodes into full-size masks with @meta-sam/parser", async () => {
  const text =
    "<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|><|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>\n";
  const segs = await decodeSegments(text, 320, 334);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].mask.length, 320 * 334);
  assert.ok(segs[0].area > 0);
  assert.deepEqual(await decodeSegments("", 10, 10), []);
  // A big object's mask comes back smaller than its box (here 30x14 for a 60x28 box) and is stretched over it.
  const shrunk = "<0f>0<|box;x1=10;y1=20;x2=69;y2=47;w=100;h=80|><|mask;x=0;y=0;data=14,30,!!!!!'y:OIOjO|>\n";
  const [full] = await decodeSegments(shrunk, 100, 80);
  assert.equal(full.area, 60 * 28);
  assert.equal(full.mask[20 * 100 + 10], 1);
  assert.equal(full.mask[47 * 100 + 69], 1);
  assert.equal(full.mask[48 * 100 + 69], 0);
});

test("cut: a rest drawing becomes a rig with joints where the limbs bend", async () => {
  // Draw the placeholder at rest, and answer SAM from its own parts.
  const W = 600;
  const H = 900;
  const parts = placeholderParts(palette);
  const alpha = (names: string[]) => {
    const svg = parts.filter((p) => names.includes(p.name)).map((p) => p.svg.replace(/^<svg[^>]*>|<\/svg>$/g, "")).join("");
    const px = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svg}</svg>`).render().pixels;
    const m = new Uint8Array(W * H);
    for (let i = 0; i < m.length; i++) m[i] = px[i * 4 + 3] > 128 ? 1 : 0;
    return m;
  };
  const seg = (m: Uint8Array): Segment => ({ objectId: "0", width: W, height: H, mask: m, area: m.reduce((a, b) => a + b, 0) });
  const answers: Record<string, Uint8Array[]> = {
    "cartoon character": [alpha(parts.map((p) => p.name))],
    head: [alpha(["head"])],
    arm: [alpha(["upper-arm-l", "fore-arm-l"]), alpha(["upper-arm-r", "fore-arm-r"])],
    leg: [alpha(["thigh-l", "shin-l"]), alpha(["thigh-r", "shin-r"])],
  };
  const asked: string[] = [];
  const sam = { segment: async (phrase: string) => (asked.push(phrase), (answers[phrase] ?? []).map(seg)) };
  const all = parts.map((p) => p.svg.replace(/^<svg[^>]*>|<\/svg>$/g, "")).join("");
  const png = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${all}</svg>`).render().asPng();

  const { img, cut } = await cutRig(sam, png);
  assert.deepEqual(asked, ["cartoon character", "head", "arm", "leg"]);
  const near = (a: number[], b: number[], tol: number) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
  // The placeholder's left arm hangs on the image's right, from about (372,420) to (440,600).
  assert.ok(cut.bones.upperArmL.pivot[0] > 300, "the character's left arm is on the image's right");
  assert.ok(near(cut.bones.foreArmL.tip, [440, 600], 40), `wrist at ${cut.bones.foreArmL.tip}`);
  assert.ok(cut.bones.torso.tip[1] < cut.bones.torso.pivot[1], "shoulders above hips");
  assert.equal(cut.parts.length, 10);

  const dir = mkdtempSync(join(tmpdir(), "cut-"));
  await writeCutRig(dir, "Lolo", img, cut);
  const rig = loadRig(dir);
  assert.equal(rig.parts.length, 10);
  assert.ok(existsSync(join(dir, "check.png")));
  assert.match(readFileSync(join(dir, "rig.yaml"), "utf8"), /cut from rest.png by SAM 3.1/);
});

test("render: the cast takes the places of the people in the clip", { skip: !hasFfmpeg && "ffmpeg not installed", timeout: 120_000 }, async () => {
  const file = syntheticPoses(0.5);
  const rigs = [placeholderRig(), placeholderRig()];
  const scene = keepComposition(file, rigs);
  assert.ok(scene.actors[0].height < scene.actors[1].height, "the dancer at the back is drawn smaller");
  assert.ok((scene.actors[1].layer ?? 0) > (scene.actors[0].layer ?? 0), "the one in front is painted last");
  const out = join(mkdtempSync(join(tmpdir(), "dance-")), "d.mp4");
  const r = await renderDance(file, scene, out);
  assert.equal(r.frames, 15);
  assert.ok(existsSync(out));
});
