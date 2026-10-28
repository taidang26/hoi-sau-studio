/**
 * Camera moves over a still panel, as zoompan expressions.
 *
 * A move goes from one framing to another. A framing is a zoom (1 = whole
 * panel) and a focus point (0..1 on each axis: which part of the panel stays
 * in view when zoomed). The panel is upscaled before zoompan so the sub-pixel
 * steps do not jitter.
 */

export interface Framing {
  zoom: number;
  /** 0 = left edge, 1 = right edge. */
  x: number;
  /** 0 = top edge, 1 = bottom edge. */
  y: number;
}

export type Ease = "smooth" | "linear" | "punch";

export interface CameraMove {
  from: Framing;
  to: Framing;
  ease?: Ease;
  /** Shake amplitude as a fraction of the frame width, fading out over the shot. */
  shake?: number;
}

export type MovePreset =
  | "still"
  | "hold"
  | "push-in"
  | "pull-out"
  | "pan-left"
  | "pan-right"
  | "pan-up"
  | "pan-down"
  | "punch";

/** `focus` is where push-in and punch end up, e.g. the speaker's face. */
export function preset(name: MovePreset, focus: { x: number; y: number } = { x: 0.5, y: 0.4 }): CameraMove {
  const f = { x: clamp01(focus.x), y: clamp01(focus.y) };
  switch (name) {
    case "still":
      return { from: { zoom: 1, x: 0.5, y: 0.5 }, to: { zoom: 1, x: 0.5, y: 0.5 } };
    case "hold":
      return { from: { zoom: 1, x: 0.5, y: 0.5 }, to: { zoom: 1.04, ...f } };
    case "push-in":
      return { from: { zoom: 1, x: 0.5, y: 0.5 }, to: { zoom: 1.18, ...f } };
    case "pull-out":
      return { from: { zoom: 1.2, ...f }, to: { zoom: 1, x: 0.5, y: 0.5 } };
    case "pan-left":
      return { from: { zoom: 1.2, x: 1, y: f.y }, to: { zoom: 1.2, x: 0, y: f.y } };
    case "pan-right":
      return { from: { zoom: 1.2, x: 0, y: f.y }, to: { zoom: 1.2, x: 1, y: f.y } };
    case "pan-up":
      return { from: { zoom: 1.2, x: f.x, y: 1 }, to: { zoom: 1.2, x: f.x, y: 0 } };
    case "pan-down":
      return { from: { zoom: 1.2, x: f.x, y: 0 }, to: { zoom: 1.2, x: f.x, y: 1 } };
    case "punch":
      return { from: { zoom: 1, x: 0.5, y: 0.5 }, to: { zoom: 1.3, ...f }, ease: "punch", shake: 0.008 };
  }
}

export const isPreset = (s: string): s is MovePreset =>
  ["still", "hold", "push-in", "pull-out", "pan-left", "pan-right", "pan-up", "pan-down", "punch"].includes(s);

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const num = (v: number) => (Math.round(v * 10000) / 10000).toString();

/** Progress 0..1 over the shot, eased. `on` is zoompan's output frame number. */
export function easeExpr(ease: Ease, frames: number): string {
  const p = `(on/${Math.max(1, frames - 1)})`;
  switch (ease) {
    case "linear":
      return p;
    case "smooth":
      return `(${p}*${p}*(3-2*${p}))`;
    case "punch": {
      // Fast ease-out over the first fifth, then hold.
      const q = `min(1,${p}/0.2)`;
      return `(1-pow(1-${q},3))`;
    }
  }
}

const lerp = (a: number, b: number, e: string) => (a === b ? num(a) : `(${num(a)}+(${num(b - a)})*${e})`);

export interface ZoompanExprs {
  z: string;
  x: string;
  y: string;
}

/**
 * zoompan expressions for one shot of `frames` frames. Inside zoompan, iw/ih
 * are the (upscaled) input size and `zoom` is the current zoom.
 */
export function zoompanExprs(move: CameraMove, frames: number): ZoompanExprs {
  const e = easeExpr(move.ease ?? "smooth", frames);
  const z = lerp(Math.max(1, move.from.zoom), Math.max(1, move.to.zoom), e);
  const fx = lerp(move.from.x, move.to.x, e);
  const fy = lerp(move.from.y, move.to.y, e);
  let x = `(iw-iw/zoom)*${fx}`;
  let y = `(ih-ih/zoom)*${fy}`;
  if (move.shake) {
    // Decaying wobble; zoompan clamps x/y to the frame, so edges stay covered.
    const decay = `(1-on/${Math.max(1, frames - 1)})`;
    x += `+iw*${num(move.shake)}*${decay}*sin(on*1.9)`;
    y += `+ih*${num(move.shake)}*${decay}*cos(on*2.3)`;
  }
  return { z, x, y };
}

/** Shot types from the storyboard, mapped to a move. Close shots push in harder. */
export function moveForShot(
  shot: string | undefined,
  position: "left" | "center" | "right" | undefined,
  opts: { index?: number; last?: boolean } = {},
): CameraMove {
  const fx = position === "left" ? 0.25 : position === "right" ? 0.75 : 0.5;
  const focus = { x: fx, y: 0.4 };
  if (opts.last) return preset("punch", focus);
  switch (shot) {
    case "wide":
      // Alternate direction so consecutive wide shots do not look identical.
      return preset((opts.index ?? 0) % 2 ? "pan-left" : "pan-right", { x: fx, y: 0.5 });
    case "medium":
      return preset("push-in", focus);
    case "close-up":
      return { ...preset("push-in", focus), to: { zoom: 1.25, ...focus } };
    case "extreme close-up":
      return preset("punch", focus);
    default:
      return preset((opts.index ?? 0) % 2 ? "pull-out" : "push-in", focus);
  }
}
