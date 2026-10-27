import assert from "node:assert/strict";
import { test } from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { composePanel, fitText, imageSize, loadFont, missingGlyphs, MissingGlyphError, renderSpeech, svgToPng, tokens } from "./index.js";

const font = loadFont();
const box = { x: 0, y: 0, width: 420, height: 260 };

// Every Vietnamese letter with every tone, upper and lower case.
const VOWELS = "aăâeêioôơuưy";
const TONES = ["", "̀", "́", "̉", "̃", "̣"];
const ALL_VIETNAMESE = [...VOWELS]
  .flatMap((v) => TONES.map((t) => (v + t).normalize("NFC")))
  .concat(["đ"])
  .flatMap((c) => [c, c.toUpperCase()])
  .join("");

test("font covers every Vietnamese letter and tone", () => {
  assert.deepEqual(missingGlyphs(font, ALL_VIETNAMESE), []);
});

test("decomposed input (combining marks) is normalised to NFC before layout", () => {
  const decomposed = "Tiếng Việt";
  const fit = fitText(decomposed, box, font);
  assert.equal(fit.lines.map((l) => l.text).join(" "), "Tiếng Việt");
});

test("lines break only between syllables", () => {
  const text = "Sếp ơi em xin phép nghỉ phép vì deadline đã cuộn tròn em lại rồi ạ";
  const fit = fitText(text, { x: 0, y: 0, width: 260, height: 300 }, font);
  assert.ok(fit.lines.length > 1);
  assert.deepEqual(fit.lines.flatMap((l) => l.text.split(" ")), text.split(" "));
});

test("~ and numbers keep words on the same line", () => {
  assert.deepEqual(tokens("họp~giao~ban lúc 5 giờ"), ["họp giao ban", "lúc", "5 giờ"]);
  const fit = fitText("Họp~giao~ban lúc 5 giờ chiều thứ Sáu", { x: 0, y: 0, width: 220, height: 260 }, font);
  for (const l of fit.lines) {
    assert.ok(!/^giờ/.test(l.text) && !/5$/.test(l.text), `"${l.text}" splits 5 giờ`);
  }
  assert.ok(fit.lines.some((l) => l.text.includes("Họp giao ban")));
});

test("longer dialogue gets a smaller font, never a larger one", () => {
  const short = fitText("Dạ.", box, font);
  const long = fitText("Dạ vâng ạ, em đang khởi động từ thứ Hai tuần trước, chắc thứ Hai tuần sau là xong ạ.", box, font);
  assert.ok(long.fontSize < short.fontSize);
  assert.ok(long.fits);
});

test("every line sits inside the ellipse", () => {
  const b = { x: 100, y: 50, width: 400, height: 240 };
  const fit = fitText("Cá Nóc hiền lắm, chỉ là đừng giao việc lúc 4 giờ 59 phút chiều thôi.", b, font, { padding: 10 });
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  for (const l of fit.lines) {
    for (const y of [l.baseline - fit.fontSize * 0.95, l.baseline + fit.fontSize * 0.25]) {
      const x = l.width / 2;
      const inside = (x / (b.width / 2)) ** 2 + ((y - cy) / (b.height / 2)) ** 2;
      assert.ok(inside <= 1, `line "${l.text}" leaves the bubble (${inside.toFixed(2)})`);
    }
    assert.equal(l.cx, cx);
  }
});

test("text that cannot fit is flagged, not silently clipped", () => {
  const fit = fitText("Một câu thoại rất dài ".repeat(20), { x: 0, y: 0, width: 120, height: 80 }, font);
  assert.equal(fit.fits, false);
});

test("missing glyphs are refused", () => {
  assert.throws(() => renderSpeech("Xin chào 😀", box), MissingGlyphError);
});

test("text mode escapes XML and keeps the Vietnamese text", () => {
  const { svg } = renderSpeech(`Sếp <bảo> "OK" & đi`, box, { mode: "text" });
  assert.ok(svg.includes("&lt;bảo&gt;") && svg.includes("&quot;OK&quot;") && svg.includes("&amp;"));
  assert.doesNotMatch(svg, /<bảo>/);
});

test("paths mode draws ink inside the bubble when rendered to PNG", () => {
  const { svg } = renderSpeech("Hồi sau sẽ rõ", { x: 0, y: 0, width: 400, height: 200, draw: true, tail: { x: 380, y: 260 } });
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="280">${svg}</svg>`;
  const png = new Resvg(doc).render();
  const { pixels, width } = png;
  // Count dark pixels in the middle band of the bubble: that is the lettering.
  let dark = 0;
  for (let y = 70; y < 130; y++) {
    for (let x = 60; x < 340; x++) {
      const i = (y * width + x) * 4;
      if (pixels[i + 3] > 200 && pixels[i] < 80) dark++;
    }
  }
  assert.ok(dark > 500, `expected lettering, found ${dark} dark pixels`);
});

test("composePanel keeps panel size and reports overflow; PNG round-trips", () => {
  const panel = svgToPng(`<svg xmlns="http://www.w3.org/2000/svg" width="540" height="675"><rect width="540" height="675" fill="#eee"/></svg>`);
  const size = imageSize(panel);
  assert.deepEqual(size, { width: 540, height: 675, mime: "image/png" });
  const { svg, overflow } = composePanel({ data: panel, ...size }, [
    { text: "Tê Tê cuộn tròn rồi.", bubble: { x: 40, y: 40, width: 300, height: 180, draw: true } },
    { text: "Quá dài ".repeat(40), bubble: { x: 40, y: 500, width: 80, height: 60 } },
  ]);
  assert.equal(overflow.length, 1);
  const out = svgToPng(svg);
  assert.deepEqual(imageSize(out), { width: 540, height: 675, mime: "image/png" });
});
