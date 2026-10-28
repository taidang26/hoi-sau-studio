/**
 * Comic balloon outlines, drawn as if by hand.
 *
 * Each kind of line has its own balloon: a slightly wobbly oval with a short
 * curved tail for speech, a cloud with trailing puffs for thoughts, a spiky
 * burst for shouts and a dashed oval for whispers. The wobble is seeded by
 * the text, so the same line always gets the same outline.
 */

import type { Box } from "./layout.js";

export type BubbleKind = "speech" | "thought" | "shout" | "whisper";

export const BUBBLE_KINDS: BubbleKind[] = ["speech", "thought", "shout", "whisper"];

export interface BalloonStyle {
  fill: string;
  stroke: string;
  strokeWidth: number;
  /** Seed for the hand-drawn wobble. */
  seed: number;
}

type Pt = { x: number; y: number };

const n = (v: number) => Number(v.toFixed(1));

/** Small deterministic PRNG (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashText(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return h >>> 0;
}

/** Closed smooth path through points (Catmull-Rom as cubic Béziers). */
function smoothClosed(p: Pt[]): string {
  const k = p.length;
  const at = (i: number) => p[(i + k) % k];
  let d = `M${n(p[0].x)},${n(p[0].y)}`;
  for (let i = 0; i < k; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${n(c1.x)},${n(c1.y)} ${n(c2.x)},${n(c2.y)} ${n(p2.x)},${n(p2.y)}`;
  }
  return d + " Z";
}

const centre = (b: Box): Pt => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const onEllipse = (b: Box, t: number, scale = 1): Pt => {
  const c = centre(b);
  return { x: c.x + Math.cos(t) * (b.width / 2) * scale, y: c.y + Math.sin(t) * (b.height / 2) * scale };
};
/** Parameter t of the ellipse point that faces `p`. */
const facing = (b: Box, p: Pt) => {
  const c = centre(b);
  return Math.atan2((p.y - c.y) / b.height, (p.x - c.x) / b.width);
};

function wobblyOval(b: Box, rnd: () => number): string {
  const k = 14;
  const phase = rnd() * Math.PI;
  const pts = Array.from({ length: k }, (_, i) => onEllipse(b, phase + (i / k) * Math.PI * 2, 1 + (rnd() - 0.5) * 0.035));
  return smoothClosed(pts);
}

/**
 * A tail that leaves the balloon facing the speaker and bends a little,
 * the way a letterer flicks it with one stroke. It reaches most of the way to
 * the speaker but stops short so it never covers a face.
 */
function curvedTail(b: Box, aim: Pt, rnd: () => number): string {
  const t = facing(b, aim);
  const c = centre(b);
  const base = Math.min(b.width, b.height) * 0.13;
  // The base sits just inside the outline so the seam is hidden by the body fill.
  const spread = base / Math.max(b.width, b.height) * 2.2;
  const a = onEllipse(b, t - spread, 0.94);
  const z = onEllipse(b, t + spread, 0.94);
  const edge = onEllipse(b, t, 1);
  const dx = aim.x - edge.x, dy = aim.y - edge.y;
  const dist = Math.hypot(dx, dy) || 1;
  // Long enough to reach most of the way to a speaker standing far below the balloon.
  const len = Math.min(dist * 0.78, Math.max(b.height * 2.2, 34));
  const tip = { x: edge.x + (dx / dist) * len, y: edge.y + (dy / dist) * len };
  // Bend sideways, away from the balloon's vertical centre line.
  const side = (aim.x >= c.x ? -1 : 1) * (0.25 + rnd() * 0.1) * len;
  const px = -dy / dist, py = dx / dist;
  const mid = (p: Pt) => ({ x: (p.x + tip.x) / 2 + px * side, y: (p.y + tip.y) / 2 + py * side });
  const m1 = mid(a), m2 = mid(z);
  return `M${n(a.x)},${n(a.y)} Q${n(m1.x)},${n(m1.y)} ${n(tip.x)},${n(tip.y)} Q${n(m2.x)},${n(m2.y)} ${n(z.x)},${n(z.y)} Z`;
}

function cloud(b: Box, rnd: () => number): string {
  const k = 11;
  const phase = rnd() * Math.PI;
  const pts = Array.from({ length: k }, (_, i) => onEllipse(b, phase + ((i + (rnd() - 0.5) * 0.3) / k) * Math.PI * 2, 0.97));
  let d = `M${n(pts[0].x)},${n(pts[0].y)}`;
  for (let i = 0; i < k; i++) {
    const p = pts[i], q = pts[(i + 1) % k];
    const r = (Math.hypot(q.x - p.x, q.y - p.y) / 2) * (1.05 + rnd() * 0.25);
    d += ` A${n(r)},${n(r)} 0 0 1 ${n(q.x)},${n(q.y)}`;
  }
  return d + " Z";
}

/** Two or three shrinking puffs from the cloud towards the thinker. */
function puffs(b: Box, aim: Pt): Array<Pt & { r: number }> {
  const edge = onEllipse(b, facing(b, aim), 1.08);
  const dx = aim.x - edge.x, dy = aim.y - edge.y;
  const dist = Math.hypot(dx, dy) || 1;
  const len = Math.min(dist * 0.8, Math.max(b.height * 2, 48));
  const r0 = Math.min(b.width, b.height) * 0.075;
  return [0.2, 0.55, 0.88].map((f, i) => ({ x: edge.x + (dx / dist) * len * f, y: edge.y + (dy / dist) * len * f, r: r0 * (1 - i * 0.3) }));
}

function burst(b: Box, aim: Pt | undefined, rnd: () => number): string {
  const k = 20;
  const phase = rnd() * Math.PI;
  const aimT = aim ? facing(b, aim) : null;
  const pts: Pt[] = [];
  for (let i = 0; i < k * 2; i++) {
    const t = phase + (i / (k * 2)) * Math.PI * 2;
    const outer = i % 2 === 0;
    let scale = outer ? 1.12 + rnd() * 0.12 : 0.9 + rnd() * 0.04;
    // The spike nearest the speaker is pulled out into a tail.
    if (outer && aimT !== null && Math.abs(Math.atan2(Math.sin(t - aimT), Math.cos(t - aimT))) < Math.PI / k) scale = 1.75;
    pts.push(onEllipse(b, t, scale));
  }
  return `M${pts.map((p) => `${n(p.x)},${n(p.y)}`).join(" L")} Z`;
}

/**
 * The balloon for one line, as SVG markup in panel coordinates. `tail` is the
 * point the balloon refers to, usually the speaker's head.
 */
export function balloon(kind: BubbleKind, b: Box, tail: Pt | undefined, s: BalloonStyle): string {
  const rnd = random(s.seed);
  const sw = s.strokeWidth;
  const ink = `stroke="${s.stroke}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"`;
  if (kind === "thought") {
    const extra = tail ? puffs(b, tail).map((p) => `<ellipse cx="${n(p.x)}" cy="${n(p.y)}" rx="${n(p.r * 1.15)}" ry="${n(p.r)}" fill="${s.fill}" ${ink}/>`).join("") : "";
    return extra + `<path d="${cloud(b, rnd)}" fill="${s.fill}" ${ink}/>`;
  }
  if (kind === "shout") {
    return `<path d="${burst(b, tail, rnd)}" fill="${s.fill}" stroke="${s.stroke}" stroke-width="${sw * 1.15}" stroke-linejoin="miter" stroke-miterlimit="8"/>`;
  }
  const body = wobblyOval(b, rnd);
  const dash = kind === "whisper" ? ` stroke-dasharray="${n(sw * 3)} ${n(sw * 2.4)}"` : "";
  if (!tail) return `<path d="${body}" fill="${s.fill}" ${ink}${dash}/>`;
  const t = curvedTail(b, tail, rnd);
  // Tail, then body, then the tail's fill again over the seam between them.
  // That fill hides the inner half of the tail's ink, so it is drawn twice as wide.
  return (
    `<path d="${t}" fill="${s.fill}" stroke="${s.stroke}" stroke-width="${sw * 2}" stroke-linejoin="round"${dash}/>` +
    `<path d="${body}" fill="${s.fill}" ${ink}${dash}/>` +
    `<path d="${t}" fill="${s.fill}"/>`
  );
}
