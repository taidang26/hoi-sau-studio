import assert from "node:assert/strict";
import { test } from "node:test";
import { align, pasteOval, type Raster } from "./patch.js";
import { mockScript, scriptProblems, syllables } from "./script.js";
import { blinkTrack, chunkWords, cropWindow, CANVAS, wordTimes } from "./timeline.js";
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

test("the camera crop stays inside the canvas", () => {
  for (const zoom of [1, 1.12, 1.3])
    for (const cx of [0, 640, 2000]) {
      const w = cropWindow({ zoom, cx, cy: 3000 });
      assert.ok(w.x >= 0 && w.y >= 0 && w.x + w.w <= CANVAS.w && w.y + w.h <= CANVAS.h);
    }
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
