import assert from "node:assert/strict";
import { test } from "node:test";
import { align, pasteOval, type Raster } from "./patch.js";
import { mockScript, scriptProblems, syllables } from "./script.js";
import { blinkTrack, chunkWords, wordTimes } from "./timeline.js";
import { hummedLine, joinLines, mouthTrack, RATE, wavBytes } from "./voice.js";

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
  const { OUT } = await import("./timeline.js");
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
  const mid = Math.round(OUT.h * (1 - ON_PHOTO.bottom - ON_PHOTO.height / 2));
  assert.ok(px(540, mid)[0] > 200 && px(540, mid)[2] < 60, "the character in the middle");
  assert.ok(px(60, mid)[2] > 120, "the photo at the side, not the drawn white");
  // A see-through cut: outside the mask, inside the character's box, is the photo.
  const holed = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600"/><circle cx="200" cy="350" r="100" fill="#fff"/></svg>')).png().toBuffer();
  const out2 = await onPhoto(pic, holed, await photoBackdrop(photo));
  const c = (x: number, y: number) => [...out2.data.subarray((y * out2.width + x) * 3, (y * out2.width + x) * 3 + 3)];
  // The circle's bounding square corner (inside the box, outside the circle) shows the photo's blue, not white.
  const r = Math.round(OUT.h * ON_PHOTO.height / 2);
  const cy = Math.round(OUT.h * (1 - ON_PHOTO.bottom) - r);
  assert.ok(c(Math.round(OUT.w / 2) - Math.round(r * 0.9), cy - Math.round(r * 0.9))[2] > 120, "transparent outside the mask");
});
