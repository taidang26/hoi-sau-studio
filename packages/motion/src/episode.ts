/**
 * A Studio episode folder (episodes/<id>/) → a motion comic spec.
 *
 * Reads only what Studio saved: letter.json for the lettered pages, script.json
 * for dialogue (timing and subtitles), storyboard.json for shot size and
 * staging (camera moves), premise.json for the title, episode.json for credits.
 *
 * When the unlettered panels are there (panels.json), the camera moves the art
 * only and each speech bubble is a still layer on top that pops in when its
 * line starts, laid out exactly as Studio's letter step does. Otherwise the
 * lettered page moves as a whole, gently.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bubbleLayout, type EpisodeSpec, type PanelRender, type Premise, type Script, type ScriptPanel, type BoardPanel, type Storyboard } from "@hoi-sau/studio";
import { composePanel, imageSize, svgToPng } from "@hoi-sau/svg-text";
import { moveForShot } from "./camera.js";
import { MotionError } from "./ffmpeg.js";
import type { MotionSpec, Shot } from "./render.js";
import { readingSeconds } from "./text.js";

export interface Lettered {
  pages: Array<{ n: number; file: string; overflow: number }>;
}

const read = <T>(dir: string, name: string): T | undefined => {
  const f = join(dir, `${name}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : undefined;
};

/** Episode number from ids like "cu-li-ep-003" or "ep-12"; undefined otherwise. */
export const episodeNumber = (id: string): number | undefined => {
  const m = /(?:^|-)ep-?(\d+)$/.exec(id);
  return m ? Number(m[1]) : undefined;
};

export interface EpisodeMotionOptions {
  /** Display names by slug, for subtitles ("Cu Li: …"). */
  names?: Record<string, string>;
  quality?: MotionSpec["quality"];
  audio?: MotionSpec["audio"];
  font?: string;
}

export function specFromEpisode(dir: string, opts: EpisodeMotionOptions = {}): MotionSpec {
  const letter = read<Lettered>(dir, "letter");
  if (!letter?.pages.length) throw new MotionError(`${dir} has no lettered pages yet (letter.json). Run the Studio episode first.`);
  const script = read<Script>(dir, "script");
  const board = read<Storyboard>(dir, "storyboard");
  const premise = read<Premise>(dir, "premise");
  const ep = read<EpisodeSpec>(dir, "episode");
  const id = ep?.id ?? dir.split(/[\\/]/).filter(Boolean).at(-1)!;
  const n = episodeNumber(id);
  const label = n ? `TẬP ${n}` : "";

  const renders = read<{ renders: PanelRender[] }>(dir, "panels")?.renders;
  const pages = [...letter.pages].sort((a, b) => a.n - b.n);
  const shots: Shot[] = pages.map((page, i) => {
    const sp = script?.panels[page.n - 1];
    const bp = board?.panels[page.n - 1];
    const lines = sp?.dialogue ?? [];
    const art = renders?.find((r) => r.n === page.n)?.file;
    const split = art && sp && bp && existsSync(join(dir, art)) ? bubbleLayers(dir, art, page.n, sp, bp) : undefined;
    // Follow whoever speaks first; otherwise the first character on stage.
    const focusOn = lines[0]?.speaker ?? bp?.staging[0]?.character;
    const position = bp?.staging.find((s) => s.character === focusOn)?.position;
    const last = i === pages.length - 1;
    return {
      image: split ? art! : page.file,
      layers: split,
      duration: readingSeconds(lines.map((l) => l.text)) + (last ? 0.8 : 0),
      move: moveForShot(bp?.shot, position, { index: i, last }),
      dialogue: lines.map((l) => ({ speaker: l.speaker, text: `${opts.names?.[l.speaker] ?? l.speaker}: ${l.text}` })),
      transition: last ? "none" : i === pages.length - 2 ? "fadewhite" : "fade",
    };
  });

  const credits = ep?.credits?.map((c) => c.name).filter(Boolean) ?? [];
  return {
    shots,
    baseDir: dir,
    header: ["HỒI SAU", label].filter(Boolean).join(" · "),
    intro: {
      duration: 2.2,
      blocks: [
        { text: "HỒI SAU", fontSize: 120, y: 640, color: "#FFD45C", border: 8 },
        ...(label ? [{ text: label, fontSize: 56, y: 800 }] : []),
        ...(premise?.title ? [{ text: premise.title, fontSize: 64, y: 900, width: 900 }] : []),
      ],
    },
    outro: {
      duration: 3.5,
      blocks: [
        ...(premise?.hook ? [{ text: premise.hook, fontSize: 58, y: 560, width: 920 }] : []),
        { text: "Tập sau do bạn viết", fontSize: 72, y: 860, color: "#FFD45C" },
        { text: "Bình luận ý tưởng ở dưới nhé", fontSize: 50, y: 960 },
        ...(credits.length ? [{ text: `Cảm ơn ý tưởng của ${credits.join(", ")}`, fontSize: 38, y: 1110, width: 900 }] : []),
        { text: "Muốn biết sự thể ra sao, xem hồi sau sẽ rõ.", fontSize: 36, y: 1300, color: "#DDDDDD" },
      ],
    },
    transition: { kind: "fade", duration: 0.35 },
    quality: opts.quality,
    audio: opts.audio,
    font: opts.font,
  };
}

/** Seconds into the shot when each dialogue line appears: one after another, as they would be read. */
export function lineTimes(texts: string[]): number[] {
  let t = 0.35;
  return texts.map((text) => {
    const at = Math.round(t * 100) / 100;
    t += 0.4 + [...text].length / 14;
    return at;
  });
}

/** One transparent PNG per speech bubble, in motion/layers/. */
function bubbleLayers(dir: string, art: string, n: number, sp: ScriptPanel, bp: BoardPanel): Shot["layers"] {
  const data = readFileSync(join(dir, art));
  const size = imageSize(data);
  const out = join(dir, "motion", "layers");
  mkdirSync(out, { recursive: true });
  const times = lineTimes(sp.dialogue.map((d) => d.text));
  return bubbleLayout(sp, bp, size.width, size.height).map((line, j) => {
    // Same layout and renderer as the letter step, minus the art.
    const { svg } = composePanel({ data, ...size }, [line]);
    const file = join("motion", "layers", `${String(n).padStart(2, "0")}-${j + 1}.png`);
    writeFileSync(join(dir, file), svgToPng(svg.replace(/<image\b[^>]*\/>/, "")));
    return { image: file, at: times[j] };
  });
}
