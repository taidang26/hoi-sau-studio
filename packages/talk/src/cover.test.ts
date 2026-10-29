import assert from "node:assert/strict";
import test from "node:test";
import { COMIC_FONT_PATH, loadFont } from "@hoi-sau/svg-text";
import { COVER_PIN, COVER_SAFE, coverLayout, coverProblem, coverSvg, fitQuote, parseQuote, safeSvg } from "./cover.js";

const font = loadFont(COMIC_FONT_PATH);
const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

test("cover: the quote splits into lines and red key words", () => {
  assert.deepEqual(parseQuote("“Đam mê không trả|được *tiền trọ*.”"), [
    [{ text: "“Đam mê không trả", key: false }],
    [{ text: "được ", key: false }, { text: "tiền trọ", key: true }, { text: ".”", key: false }],
  ]);
});

test("cover: the badge shrinks until its widest line fits the safe width", () => {
  const room = COVER_SAFE.x1 - COVER_SAFE.x0;
  const shrunk = fitQuote(parseQuote("“Hết tiền *thật* đấy!”"), font);
  assert.ok(shrunk.size < 88 && shrunk.badge.w <= room);
  // Too long even at the smallest size: the layout refuses it rather than spill over the edges.
  const long = fitQuote(parseQuote("“Hết tiền *thật* đấy, thật đấy mà!”"), font);
  assert.ok(long.badge.w > room && "problem" in coverLayout(long.block, undefined));
  const short = fitQuote(parseQuote("“*Thứ Sáu* ơi!!”"), font);
  assert.equal(short.size, 88);
  assert.ok(short.block.h > short.badge.h);
});

test("cover: the badge goes to the bottom of the safe zone, else above the faces, else nowhere", () => {
  const block = { w: 700, h: 340 };
  const low = coverLayout(block, box(300, 500, 400, 400));
  assert.ok(!("problem" in low) && low.y + low.h === COVER_SAFE.y1 && low.x === 190);
  const above = coverLayout(block, box(300, 1100, 400, 400));
  assert.ok(!("problem" in above) && above.y + above.h <= 1100 - 24 && above.y >= COVER_SAFE.y0);
  assert.ok("problem" in coverLayout(block, box(200, 400, 600, 1100)));
  assert.ok("problem" in coverLayout({ w: 1000, h: 200 }, undefined));
  // Above the faces but up in the pin corner is no good either.
  assert.ok("problem" in coverLayout({ w: 900, h: 340 }, box(100, 640, 800, 1000)));
});

test("cover: emoji, missing glyphs, the edges, the pin corner and faces are refused", () => {
  const ok = box(190, 1167, 700, 340);
  assert.equal(coverProblem("“Đam mê không trả được tiền trọ.”", font, ok), "");
  assert.match(coverProblem("“Thứ Sáu ơi!!” 🎉", font, ok), /emoji/);
  assert.match(coverProblem("“Hết tiền” 🥲", font, ok), /emoji/);
  assert.match(coverProblem("“漢字”", font, ok), /no glyph/);
  assert.match(coverProblem("ok", font, box(40, 1167, 700, 340)), /safe zone/);
  assert.match(coverProblem("ok", font, box(190, 1300, 700, 340)), /safe zone/);
  assert.match(coverProblem("ok", font, { ...COVER_PIN, x: 700, w: 280 }), /pin corner/);
  assert.match(coverProblem("ok", font, ok, box(300, 1200, 300, 300)), /face/);
});

test("cover: the drawing is plain paths in the badge colours, no tilt, with the tag", () => {
  const lines = parseQuote("“được *tiền trọ*.”");
  const svg = coverSvg("data:image/png;base64,AA==", lines, box(190, 1167, 700, 340), font, "data:image/png;base64,AA==");
  assert.match(svg, /fill="#D61F1F"/);
  assert.doesNotMatch(svg, /rotate\(/);
  assert.doesNotMatch(svg, /<text/);
  assert.match(svg, /clip-path="url\(#av\)"/);
  assert.match(safeSvg("data:image/png;base64,AA=="), new RegExp(`y="${COVER_SAFE.y0}"`));
});
