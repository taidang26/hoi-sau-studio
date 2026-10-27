# @hoi-sau/svg-text

Image models distort Vietnamese diacritics, so Muse Image draws panels **without text** and the dialogue is composited on top as an SVG layer. Editing a line never needs a redraw, and an English edition is a text swap.

![Sample panel lettered by svg-text](../../docs/images/svg-text-demo.png)

## What it does

- **Real font metrics.** Lines are measured with the same font file that draws them ([Be Vietnam Pro](https://github.com/bettergui/BeVietnamPro) SemiBold and Bold, SIL OFL 1.1, licence in [`fonts/OFL.txt`](fonts/OFL.txt)).
- **Breaks only between syllables.** Vietnamese writes each syllable as its own token, so a line never splits inside one. Glue words that must stay together with `~` (`họp~giao~ban`) or a no-break space. A number stays with the word after it (`5 giờ`).
- **Fits the bubble shape.** Ellipse bubbles give each line the width the ellipse has at that height. The largest font that fits wins, with a small penalty for a line holding a single syllable, and the split with the most even fill is chosen.
- **Never clips silently.** Text that does not fit at the minimum size comes back with `fits: false` (and in `overflow` from `composePanel`) so self-review can fail the panel.
- **Refuses missing glyphs.** Characters the font cannot draw (emoji, for example) throw `MissingGlyphError` instead of falling back to a box.
- **Glyphs as paths by default.** Output looks identical in every renderer and needs no installed font. `mode: "text"` keeps live text and embeds the font as `@font-face`.
- **Draws the bubble too, if asked.** `draw: true` adds the bubble and a tail aimed at the speaker, for panels drawn with no bubbles at all.
- **PNG export** through resvg, with no system fonts.

## Use

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { composePanel, imageSize, svgToPng } from "@hoi-sau/svg-text";

const data = readFileSync("panel-1.webp");
const { svg, overflow } = composePanel({ data, ...imageSize(data) }, [
  {
    speaker: "cu-li",
    text: "Dạ vâng ạ… em đang “khởi~động” từ thứ Hai tuần trước rồi ạ.",
    bubble: { x: 60, y: 160, width: 440, height: 290, draw: true, tail: { x: 360, y: 500 } },
  },
]);
if (overflow.length) throw new Error("dialogue too long for its bubble");
writeFileSync("panel-1.png", svgToPng(svg));
```

```bash
npm test -w @hoi-sau/svg-text        # 11 tests: glyph coverage, wrapping, ellipse fit, PNG render
npm run demo -w @hoi-sau/svg-text    # writes output/svg-text-demo.png; pass a panel path to letter a real image
```
