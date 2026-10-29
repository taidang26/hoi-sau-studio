import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { align, fillHoles, pasteOval, type Raster } from "./patch.js";
import { mockScript, PACE, scriptProblems, syllables } from "./script.js";
import { blinkTrack, chunkWords, wordTimes } from "./timeline.js";
import { hummedLine, joinLines, mouthTrack, RATE, ttsArg, ttsEnv, voiceShape, wavBytes } from "./voice.js";
import { setPrompt, SETS } from "./sets.js";
import { alignBackground, dilate, flatBands, frameProblem, gateToWords, ghostShare, groupLines, leadFeatures, leadMouth, overlapShare, parseCuts, pasteMouth, poseBProblem, popScale, poseAt, shotSpans, timeWords } from "./illustrate.js";

test("words share the line's time, with a pause after punctuation", () => {
  const w = wordTimes("Dạ, em đang làm", 1, 3);
  assert.equal(w.length, 4);
  assert.equal(w[0].start, 1);
  assert.ok(Math.abs(w[3].end - 3) < 1e-9);
  assert.ok(w[0].end - w[0].start > w[1].end - w[1].start);
});

test("caption chunks stop at punctuation and stay short", () => {
  const c = chunkWords(wordTimes("Một chút là bao lâu ạ? Một chút buồn hay một chút vui?", 0, 4));
  assert.deepEqual(c.map((x) => x.words.map((w) => w.text).join(" ")), ["Một chút là bao", "lâu ạ?", "Một chút buồn hay", "một chút vui?"]);
});

test("the mouth opens on speech and never stays open long", () => {
  const v = joinLines([hummedLine("một hai ba bốn năm")], { lead: 0.5, tail: 0.5 });
  const m = mouthTrack(v, 30, Math.ceil((v.pcm.length / RATE) * 30));
  assert.equal(m.slice(0, 12).some(Boolean), false, "shut during the lead-in");
  assert.ok(m.filter(Boolean).length > 10);
  let run = 0;
  for (const o of m) {
    run = o ? run + 1 : 0;
    assert.ok(run <= 6);
  }
  assert.equal(wavBytes(v.pcm).length, 44 + v.pcm.length * 2);
});

test("blinks are short and spaced", () => {
  const b = blinkTrack(30 * 20);
  const starts = b.flatMap((x, i) => (x && !b[i - 1] ? [i] : []));
  assert.ok(starts.length >= 4 && starts.length <= 9);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 60);
});

test("an edit drawn a few pixels off is lined up before its feature is pasted", () => {
  const W = 200, H = 200;
  const img = (dx: number, dy: number, mouth: boolean): Raster => {
    const data = Buffer.alloc(W * H * 3, 230);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        // Texture so the alignment has something to lock on to.
        const h = Math.sin((x - dx) * 12.9898 + (y - dy) * 78.233) * 43758.5453;
        const v = h - Math.floor(h) < 0.3 ? 40 : 230;
        data[i] = data[i + 1] = data[i + 2] = v;
        if (mouth && Math.abs(x - dx - 100) < 10 && Math.abs(y - dy - 120) < 5) data[i] = 255, data[i + 1] = data[i + 2] = 0;
      }
    return { data, width: W, height: H };
  };
  const base = img(0, 0, false);
  const edit = img(5, -3, true);
  const hole = { x: 80, y: 105, w: 40, h: 30 };
  const s = align(base, edit, hole);
  assert.deepEqual([s.dx, s.dy], [-5, 3]);
  const out = pasteOval(base, edit, hole, s.dx, s.dy);
  const i = (120 * W + 100) * 3;
  assert.deepEqual([...out.data.subarray(i, i + 3)], [255, 0, 0]);
});

test("the stand-in script is a usable length with varied gestures", () => {
  const s = mockScript();
  assert.ok(syllables(s.lines[0].text) > 5);
  assert.deepEqual(scriptProblems(s, 25), []);
  assert.match(scriptProblems({ ...s, lines: s.lines.slice(0, 2) }, 30).join(), /only/);
});

test("a transcript with only segments still gets word times", async () => {
  const { parseTranscript, linesFromWords } = await import("./transcribe.js");
  const t = parseTranscript({ text: "a b c d", segments: [{ text: "Em chào anh.", start: 1, end: 2.5 }, { text: "Sếp gọi", start: 3.5, end: 4 }] });
  assert.equal(t.words.length, 5);
  assert.equal(t.words[0].start, 1);
  assert.deepEqual(linesFromWords(t.words).map((l) => l.length), [3, 2]);
});

test("typed lyrics land on the voiced parts of the sound", async () => {
  const { voicedRegions, timeLyrics, gateMouth } = await import("./sync.js");
  const v = joinLines([hummedLine("một hai ba"), hummedLine("bốn năm")], { gap: 1, lead: 0.5 });
  const regions = voicedRegions(v.pcm);
  assert.equal(regions.length, 2);
  const lines = timeLyrics(["một hai ba", "bốn năm"], regions);
  assert.ok(Math.abs(lines[1][0].start - regions[1].start) < 0.15);
  const gated = gateMouth(new Array(150).fill(true), lines, 30);
  assert.equal(gated[3], false, "shut before the first word");
  assert.equal(gated[30], true);
});

test("a cut-out character stands bottom-centre on the photo", async () => {
  const sharp = (await import("sharp")).default;
  const { onPhoto, photoBackdrop, ON_PHOTO } = await import("./render.js");
  const { OUT, SAFE, SAFE_CX } = await import("./timeline.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const pic = await sharp({ create: { width: 400, height: 600, channels: 3, background: "#ffffff" } })
    .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect x="100" y="200" width="200" height="300" fill="#ff0000"/></svg>') }])
    .png()
    .toBuffer();
  const mask = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600"/><rect x="100" y="200" width="200" height="300" fill="#fff"/></svg>')).png().toBuffer();
  const photo = join(mkdtempSync(join(tmpdir(), "talk-")), "bg.png");
  writeFileSync(photo, await sharp({ create: { width: 800, height: 600, channels: 3, background: "#2050a0" } }).png().toBuffer());
  const out = await onPhoto(pic, mask, await photoBackdrop(photo));
  assert.equal(out.width, OUT.w);
  const px = (x: number, y: number) => [...out.data.subarray((y * out.width + x) * 3, (y * out.width + x) * 3 + 3)];
  // The red block's bottom edge is cut straight across, so it stands as a waist-up cut, flush with the bottom.
  const mid = Math.round(OUT.h * (1 - ON_PHOTO.cutHeight / 2));
  assert.ok(px(540, mid)[0] > 200 && px(540, mid)[2] < 60, "the character in the middle");
  assert.ok(px(60, mid)[2] > 120, "the photo at the side, not the drawn white");
  // A see-through cut: outside the mask, inside the character's box, is the photo.
  const holed = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600"/><circle cx="200" cy="350" r="100" fill="#fff"/></svg>')).png().toBuffer();
  const out2 = await onPhoto(pic, holed, await photoBackdrop(photo));
  const c = (x: number, y: number) => [...out2.data.subarray((y * out2.width + x) * 3, (y * out2.width + x) * 3 + 3)];
  // The circle's bounding square corner (inside the box, outside the circle) shows the photo's blue, not white.
  const r = Math.round(OUT.h * ON_PHOTO.height / 2);
  const cy = Math.round(OUT.h * (1 - ON_PHOTO.bottom) - r);
  assert.ok(c(Math.round(SAFE_CX) - Math.round(r * 0.9), cy - Math.round(r * 0.9))[2] > 120, "transparent outside the mask");
  // Standing on the safe area's bottom line, centred on the safe area.
  assert.equal(Math.round(OUT.h * (1 - ON_PHOTO.bottom)), SAFE.bottom);
  assert.ok(c(Math.round(SAFE_CX), SAFE.bottom - 5)[0] > 200, "feet end on the safe line");
  assert.ok(c(Math.round(SAFE_CX), SAFE.bottom + 40)[0] < 200, "nothing of the character below it");
  // Moved right for a set with furniture on the left, but never past the safe area's right edge.
  const right = await onPhoto(pic, holed, await photoBackdrop(photo), OUT.w);
  const rp = (x: number, y: number) => [...right.data.subarray((y * right.width + x) * 3, (y * right.width + x) * 3 + 3)];
  assert.ok(rp(SAFE.right - 5, cy)[0] > 200, "pushed right up to the safe edge");
  assert.ok(rp(SAFE.right + 20, cy)[0] < 200, "nothing beyond the safe area");
});

test("set prompts keep the faded sketch look and leave out sparkles", () => {
  for (const s of SETS) {
    const p = setPrompt(s);
    assert.match(p, /faded watercolour/);
    assert.match(p, /No sparkles/);
  }
});

test("depth of field: the near ground and side walls stay sharp, the end of the street blurs", async () => {
  const { depthBlur, nearness, VANISHING_POINT } = await import("./render.js");
  assert.equal(nearness(0.5, 1), 1, "ground at the bottom is near");
  assert.equal(nearness(0.5, 0.85), 1, "the ground the feet stand on is as sharp as the character");
  assert.equal(nearness(0, 0.3), 1, "a side wall is near");
  assert.equal(nearness(VANISHING_POINT.x, VANISHING_POINT.y), 0, "the end of the street is far");
  assert.equal(nearness(0.5, 0.1), 0, "the sky above it is far");
  // Fine stripes everywhere: they survive where the plate is sharp and wash out where it is blurred.
  const { OUT } = await import("./timeline.js");
  const stripes = Buffer.alloc(OUT.w * OUT.h * 3);
  for (let y = 0; y < OUT.h; y++) for (let x = 0; x < OUT.w; x++) stripes.fill(x % 4 < 2 ? 0 : 255, (y * OUT.w + x) * 3, (y * OUT.w + x) * 3 + 3);
  const plate = await sharp(stripes, { raw: { width: OUT.w, height: OUT.h, channels: 3 } }).png().toBuffer();
  const out = await sharp(await depthBlur(plate)).raw().toBuffer();
  const contrast = (y: number) => {
    let lo = 255, hi = 0;
    for (let x = OUT.w / 2 - 8; x < OUT.w / 2 + 8; x++) (lo = Math.min(lo, out[(y * OUT.w + x) * 3])), (hi = Math.max(hi, out[(y * OUT.w + x) * 3]));
    return hi - lo;
  };
  assert.ok(contrast(OUT.h - 20) > 150, "near ground keeps its detail");
  assert.ok(contrast(Math.round(OUT.h * VANISHING_POINT.y)) < 30, "far end is out of focus");
  const { vanishingPointFor } = await import("./sets.js");
  assert.deepEqual(vanishingPointFor("C:\\x\\series\\sets\\hem-ha-noi.png"), { x: 0.58, y: 0.72 });
  assert.equal(vanishingPointFor("photo.jpg"), undefined);
  const { setFor, setPrompt } = await import("./sets.js");
  const shutter = setFor("series/sets/via-he-cua-cuon.png")!;
  assert.equal(shutter.far, 3, "a shallow set blurs less");
  assert.match(setPrompt(shutter), /knee height/);
  assert.doesNotMatch(setPrompt(shutter), /standing head height/);
  const office = setFor("van-phong-goc.png")!;
  assert.equal(office.far, 6, "the office corner is blurred behind like a portrait lens");
  const officePrompt = setPrompt(office, "SERIES STYLE TEXT");
  assert.match(officePrompt, /Style: SERIES STYLE TEXT/);
  assert.match(officePrompt, /same place as in the reference comic panels/);
  assert.doesNotMatch(officePrompt, /faded watercolour/);
  assert.match(setPrompt(shutter), /faded watercolour/, "street sets keep the watercolour look");
  // Framing: zoomed in from the bottom right, the picture's bottom-right corner stays in the frame's corner.
  const { framePlate } = await import("./render.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const pic = join(mkdtempSync(join(tmpdir(), "talk-")), "set.png");
  writeFileSync(pic, await sharp({ create: { width: 1024, height: 1536, channels: 3, background: "#ffffff" } }).composite([{ input: { create: { width: 40, height: 40, channels: 3, background: "#ff0000" } }, left: 984, top: 1496 }]).png().toBuffer());
  const framed = await sharp(await framePlate(pic, { zoom: 1.3, x: 1, y: 1 })).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([framed.info.width, framed.info.height], [OUT.w, OUT.h]);
  const k = ((OUT.h - 5) * OUT.w + (OUT.w - 5)) * 3;
  assert.ok(framed.data[k] > 200 && framed.data[k + 1] < 60, "bottom-right corner kept");
});

test("--tts defaults to SeamlessM4T with the cartoon pitch and speed", () => {
  assert.equal(ttsArg(undefined), "seamless");
  assert.equal(ttsArg("mms"), "mms");
  assert.throws(() => ttsArg("elevenlabs"), /seamless, mms, mms-hn/);
  assert.deepEqual(voiceShape("seamless"), { pitch: 1.12, tempo: 1.05 });
  assert.deepEqual(voiceShape("mms"), { pitch: 1.12, tempo: 1 });
  assert.deepEqual(voiceShape("seamless", { tempo: 1 }), { pitch: 1.12, tempo: 1 });
});

test("joined lines keep one span per line in order", () => {
  const v = joinLines([hummedLine("một hai"), hummedLine("ba bốn năm")]);
  assert.equal(v.spans.length, 2);
  assert.ok(v.spans[0].end <= v.spans[1].start);
});

test("a Seamless script needs more words for the same seconds", () => {
  const line = (n: number) => ({ text: Array(n).fill("chữ").join(" "), gesture: "explain" });
  const s = { title: "t", caption: "c", lines: [line(15), { ...line(15), gesture: "shrug" }, { ...line(15), gesture: "think" }, line(15), line(15), line(15)] };
  assert.deepEqual(scriptProblems(s, 25, PACE.mms), []);
  assert.match(scriptProblems(s, 25 * 1.5, PACE.seamless).join(), /only/);
});

test("cut holes: a missed jacket patch is filled, the wall between arm and body is not", () => {
  const w = 12, h = 12;
  const data = Buffer.alloc(w * h * 3, 255);
  const mask = new Uint8Array(w * h);
  for (let y = 2; y < 10; y++) for (let x = 2; x < 10; x++) {
    mask[y * w + x] = 255;
    data.fill(0, (y * w + x) * 3, (y * w + x) * 3 + 1); // blue-ish character
  }
  mask[4 * w + 4] = 0; // a hole the character's colour: SAM missed it
  mask[7 * w + 7] = 0; // a hole showing the white wall
  data.fill(255, (7 * w + 7) * 3, (7 * w + 7) * 3 + 3);
  assert.equal(fillHoles(mask, { data, width: w, height: h }), 1);
  assert.equal(mask[4 * w + 4], 255);
  assert.equal(mask[7 * w + 7], 0);
});

test("--tts mms-hn reads the fine-tuned voice's folder from TALK_HN_MODEL", () => {
  assert.equal(ttsArg("mms-hn"), "mms-hn");
  assert.throws(() => ttsEnv("mms-hn", {}), /TALK_HN_MODEL/);
  assert.equal(ttsEnv("mms-hn", { TALK_HN_MODEL: "C:/dv/vits-hn-out" }).TALK_TTS_MODEL, "C:/dv/vits-hn-out");
  assert.equal(ttsEnv("mms", { X: "1" }).TALK_TTS_MODEL, undefined);
  assert.deepEqual(voiceShape("mms-hn"), { pitch: 1, tempo: 1 });
});

test("illustrate: the voice splits into lines at pauses, and lines go to the shot they start in", () => {
  const w = (text: string, start: number, end: number) => ({ text, start, end });
  const lines = groupLines([w("đi", 0, 0.3), w("làm", 0.35, 0.6), w("cuối", 1.4, 1.6), w("tháng", 1.65, 1.9)], 0.45);
  assert.deepEqual(lines.map((l) => l.text), ["đi làm", "cuối tháng"]);
  assert.deepEqual(parseCuts("x pts_time:0.1 y pts_time:1.2 z pts_time:3.5"), [1.2, 3.5]);
  const spans = shotSpans(lines, [1.2], 4);
  assert.deepEqual(spans.map((s) => s.lines), [[0], [1]]);
  assert.deepEqual([spans[0].t, spans[1].t, spans[1].end], [0, 1.2, 4]);
});

test("illustrate: corrected words keep the recogniser's times when the counts match", () => {
  const heard = [{ text: "dăm", start: 1, end: 1.2 }, { text: "mê", start: 1.3, end: 1.5 }];
  assert.deepEqual(timeWords([{ text: "đam mê", start: 1, end: 1.5 }], heard), [{ text: "đam", start: 1, end: 1.2 }, { text: "mê", start: 1.3, end: 1.5 }]);
  const spread = timeWords([{ text: "ab c", start: 0, end: 3 }], []);
  assert.equal(spread.length, 2);
  assert.ok(Math.abs(spread[0].end - 2) < 1e-9 && Math.abs(spread[1].end - 3) < 1e-9);
});

test("illustrate: poses take turns on caption chunks and the bubble pops", () => {
  const c = (start: number, end: number) => ({ words: [], start, end });
  const chunks = [c(0, 1), c(1, 2), c(2, 3), c(3, 4)];
  assert.deepEqual([0, 1, 2, 3].map((i) => poseAt(chunks, i, 1, 2)), [0, 0, 1, 0]);
  assert.equal(poseAt(chunks, 2, 0, 1), 0);
  // A shot holding a single chunk switches on its words.
  assert.deepEqual([0, 1, 2].map((w) => poseAt(chunks, 1, 1, 2, w, 2)), [0, 1, 0]);
  assert.equal(popScale(-0.1), null);
  assert.deepEqual([0, 0.06, 0.5].map(popScale), [0.82, 1.06, 1]);
});

test("illustrate: pose B's background is found again after a shift", () => {
  const w = 120, h = 160;
  const a = new Uint8Array(w * h * 3), b = new Uint8Array(w * h * 3);
  const tex = (x: number, y: number) => ((x * 37) ^ (y * 59) ^ ((x * y) >> 3)) & 255;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < 3; k++) a[(y * w + x) * 3 + k] = tex(x, y);
      for (let k = 0; k < 3; k++) b[(y * w + x) * 3 + k] = tex(x + 4, y - 2);
    }
  const keep = new Uint8Array(w * h).fill(1);
  const t = alignBackground(a, b, w, h, keep, { range: 8, scales: [1, 1] });
  assert.deepEqual([t.dx, t.dy], [4, -2]);
  assert.equal(t.err, 0);
  const m = new Uint8Array(w * h);
  m[80 * w + 60] = 1;
  const d = dilate(m, w, h, 2);
  assert.equal(d.reduce((n, v) => n + v, 0), 25);
});

test("illustrate: a picture drawn smaller than the 9:16 frame fails; a plain wall at one end does not", () => {
  const w = 40, h = 100;
  const g = new Uint8Array(w * h).fill(200);
  for (let y = 20; y < 80; y++) for (let x = 0; x < w; x++) g[y * w + x] = (x * 37 + y * 11) % 255;
  assert.deepEqual(flatBands(g, w, h), { top: 20, bottom: 20 });
  assert.match(frameProblem(1080, 1920, { top: 307, bottom: 302 }), /bands/);
  assert.match(frameProblem(1080, 1920, { top: 0, bottom: 382 }), /bands/);
  assert.equal(frameProblem(1080, 1920, { top: 83, bottom: 172 }), "");
  assert.equal(frameProblem(1080, 1920, { top: 197, bottom: 0 }), "");
  assert.match(frameProblem(1024, 1536, { top: 0, bottom: 0 }), /not 9:16/);
});

test("illustrate: the mouth is the lead's, at a mouth's size, and opens only on words", () => {
  const w = 100, h = 100;
  const box = (x: number, y: number, bw: number, bh: number) => {
    const m = new Uint8Array(w * h);
    for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) m[yy * w + xx] = 1;
    return m;
  };
  const lead = box(0, 0, 50, 100);
  const theirs = { mask: box(70, 40, 10, 5) }, ours = { mask: box(20, 40, 10, 5) }, face = { mask: box(10, 10, 40, 40) };
  assert.deepEqual(leadMouth([theirs, face, ours], lead, w, h)?.box, { x: 20, y: 40, w: 10, h: 5 });
  assert.equal(leadMouth([theirs], lead, w, h), undefined);
  assert.deepEqual(gateToWords([true, true, true, true], [{ text: "a", start: 0.1, end: 0.2 }], 10), [false, true, true, false]);
});

test("illustrate: a pose B drawn at another size, cut at the edge, or leaving pose A behind is refused", () => {
  assert.equal(poseBProblem({ k: 1, uncovered: 0, ghost: 0.005 }), "");
  assert.match(poseBProblem({ k: 0.92, uncovered: 0, ghost: 0 }), /92\.0% of pose A/);
  assert.match(poseBProblem({ k: 1, uncovered: 70000, ghost: 0 }), /outside pose B/);
  assert.match(poseBProblem({ k: 1, uncovered: 0, ghost: 0.05 }), /leftovers of pose A/);
  // A ring that differs only as much as the far background does is not a ghost.
  const w = 60, h = 60;
  const a = new Uint8Array(w * h * 3).fill(100), b = new Uint8Array(w * h * 3).fill(100);
  const region = new Uint8Array(w * h);
  for (let y = 25; y < 35; y++) for (let x = 25; x < 35; x++) region[y * w + x] = 1;
  assert.equal(ghostShare(a, b, region, w, h, 5, 60), 0);
  for (let y = 21; y < 25; y++) for (let x = 25; x < 35; x++) b[(y * w + x) * 3] = 250;
  assert.ok(ghostShare(a, b, region, w, h, 5, 60) > 0.1);
});

test("illustrate: a mouth paste stays near the mouth and leaves the nose alone", () => {
  const w = 60, h = 60;
  const base = { data: Buffer.alloc(w * h * 3, 200), width: w, height: h }, edit = { data: Buffer.alloc(w * h * 3, 0), width: w, height: h };
  const mouth = new Uint8Array(w * h);
  for (let y = 40; y < 44; y++) for (let x = 25; x < 35; x++) mouth[y * w + x] = 1;
  const out = pasteMouth(base, edit, mouth, mouth, 0, 0, 3);
  assert.equal(out.data[(42 * w + 30) * 3], 0);
  assert.equal(out.data[(30 * w + 30) * 3], 200);
});

test("illustrate: the nose stays on top of a pasted mouth, and a mouth reaching it is seen", () => {
  const w = 60, h = 60;
  const base = { data: Buffer.alloc(w * h * 3, 200), width: w, height: h }, edit = { data: Buffer.alloc(w * h * 3, 0), width: w, height: h };
  const mouth = new Uint8Array(w * h), nose = new Uint8Array(w * h), lead = new Uint8Array(w * h).fill(1);
  for (let y = 30; y < 44; y++) for (let x = 25; x < 35; x++) mouth[y * w + x] = 1;
  for (let y = 28; y < 32; y++) for (let x = 27; x < 33; x++) nose[y * w + x] = 1;
  const keep = leadFeatures([{ mask: nose }], lead, w, h);
  const out = pasteMouth(base, edit, mouth, mouth, 0, 0, 3, keep);
  assert.equal(out.data[(30 * w + 30) * 3], 200);
  assert.equal(out.data[(40 * w + 30) * 3], 0);
  assert.ok(overlapShare(mouth, keep, w, h) > 0.03);
  assert.equal(overlapShare(mouth, keep, w, h, 0, 20), 0);
});
