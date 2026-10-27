/**
 * Renders a sample 4:5 panel with Vietnamese dialogue to output/svg-text-demo.png.
 * The "panel" is a flat placeholder drawn here, so the demo runs without a model.
 *
 *   npm run demo -w @hoi-sau/svg-text [-- path/to/panel.png]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { composePanel, imageSize, svgToPng } from "./compose.js";

function placeholderPanel(): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350">
    <rect width="1080" height="1350" fill="#f3e9d2"/>
    <rect y="900" width="1080" height="450" fill="#c9b79c"/>
    <rect x="140" y="760" width="800" height="40" fill="#7a5c3e"/>
    <circle cx="380" cy="640" r="130" fill="#b48a64" stroke="#111" stroke-width="8"/>
    <circle cx="340" cy="620" r="44" fill="#fff" stroke="#111" stroke-width="6"/>
    <circle cx="430" cy="620" r="44" fill="#fff" stroke="#111" stroke-width="6"/>
    <circle cx="345" cy="625" r="20" fill="#111"/><circle cx="435" cy="625" r="20" fill="#111"/>
    <circle cx="780" cy="660" r="110" fill="#8fb3c9" stroke="#111" stroke-width="8"/>
  </svg>`;
  return svgToPng(svg);
}

const panelPath = process.argv[2];
const data = panelPath ? readFileSync(panelPath) : placeholderPanel();
const size = imageSize(data);

const { svg, overflow } = composePanel({ data, ...size }, [
  {
    speaker: "sep",
    text: "Cu Li ơi, báo cáo quý hạn 5 giờ chiều nay nhé. Sếp tin em!",
    bubble: { x: 520, y: 80, width: 500, height: 300, draw: true, tail: { x: 760, y: 540 } },
  },
  {
    speaker: "cu-li",
    text: "Dạ vâng ạ… em đang “khởi~động” từ thứ Hai tuần trước rồi ạ.",
    bubble: { x: 60, y: 160, width: 440, height: 290, draw: true, tail: { x: 360, y: 500 } },
  },
  {
    text: "HỒI SAU SẼ RÕ",
    bubble: { x: 300, y: 1180, width: 480, height: 110, shape: "rect", draw: true },
    options: { maxFontSize: 52, color: "#b3261e" },
  },
]);

mkdirSync("output", { recursive: true });
writeFileSync("output/svg-text-demo.svg", svg);
writeFileSync("output/svg-text-demo.png", svgToPng(svg));
console.log(`wrote output/svg-text-demo.png (${size.width}x${size.height})${overflow.length ? `, ${overflow.length} line(s) overflow` : ""}`);
