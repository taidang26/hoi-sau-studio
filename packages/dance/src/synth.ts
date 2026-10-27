/**
 * A made-up pose file: one person dancing on a beat and one standing still,
 * the same shape the extractor writes. For tests and the offline demo.
 */

import { KP, type Pose, type PoseFile, type Vec } from "./pose.js";

function person(hips: Vec, size: number, t: number, dancing: boolean, bpm: number): Pose {
  const beat = (t * bpm) / 60;
  const ph = beat * Math.PI;
  const bounce = dancing ? Math.abs(Math.sin(ph)) * size * 0.12 : Math.sin(t * 2) * size * 0.01;
  const sway = dancing ? Math.sin(ph / 2) * size * 0.25 : 0;
  const [hx, hy] = [hips[0] + sway, hips[1] + bounce];
  const p: Pose = Array.from({ length: 17 }, () => [0, 0, 0.9] as Pose[number]);
  const set = (i: number, x: number, y: number) => (p[i] = [x, y, 0.9]);
  const sh = size * 0.5; // half shoulder width
  set(KP.leftHip, hx + size * 0.2, hy);
  set(KP.rightHip, hx - size * 0.2, hy);
  set(KP.leftShoulder, hx + sh, hy - size);
  set(KP.rightShoulder, hx - sh, hy - size);
  const tilt = dancing ? Math.sin(ph) * 0.25 : Math.sin(t) * 0.08;
  set(KP.nose, hx + Math.sin(tilt) * size * 0.45, hy - size * 1.45);
  set(KP.leftEar, hx + size * 0.18 + Math.sin(tilt) * size * 0.4, hy - size * 1.4);
  set(KP.rightEar, hx - size * 0.18 + Math.sin(tilt) * size * 0.4, hy - size * 1.4);
  set(KP.leftEye, hx + size * 0.1, hy - size * 1.5);
  set(KP.rightEye, hx - size * 0.1, hy - size * 1.5);
  // Arms: down at rest; dancing, they swing up and wave on the beat.
  const armL = dancing ? -Math.PI / 2 + Math.sin(ph) * 1.2 : Math.PI / 2 - 0.2;
  const armR = dancing ? -Math.PI / 2 - Math.sin(ph + 1) * 1.2 : Math.PI / 2 + 0.2;
  const fore = dancing ? Math.sin(ph * 2) * 0.8 : 0;
  const arm = (s: number, e: number, w: number, a: number, side: 1 | -1) => {
    const [sx, sy] = [p[s][0], p[s][1]];
    const ex = sx + side * Math.cos(a) * size * 0.55 * (side === 1 ? 1 : -1);
    const ey = sy + Math.sin(a) * size * 0.55;
    set(e, ex, ey);
    set(w, ex + side * Math.cos(a + fore) * size * 0.5 * (side === 1 ? 1 : -1), ey + Math.sin(a + fore) * size * 0.5);
  };
  arm(KP.leftShoulder, KP.leftElbow, KP.leftWrist, armL, 1);
  arm(KP.rightShoulder, KP.rightElbow, KP.rightWrist, Math.PI - armR, -1);
  const step = dancing ? Math.sin(ph) * 0.35 : 0;
  set(KP.leftKnee, hx + size * 0.25 + Math.sin(step) * size * 0.5, hy + size * 0.9);
  set(KP.rightKnee, hx - size * 0.25 - Math.sin(step) * size * 0.2, hy + size * 0.9);
  set(KP.leftAnkle, hx + size * 0.28, hy + size * 1.8 - bounce * 0.5);
  set(KP.rightAnkle, hx - size * 0.28, hy + size * 1.8 - bounce * 0.5);
  return p;
}

export function syntheticPoses(seconds = 6, fps = 30, bpm = 120): PoseFile {
  const width = 1080;
  const height = 1920;
  const n = Math.round(seconds * fps);
  const frames = (dancing: boolean, hips: Vec, size: number) => Array.from({ length: n }, (_, f) => person(hips, size, f / fps, dancing, bpm));
  return {
    source: "synthetic",
    model: "synthetic",
    fps,
    width,
    height,
    frameCount: n,
    tracks: [
      { id: 1, frames: frames(false, [760, 1450], 330) },
      { id: 2, frames: frames(true, [360, 1100], 200) },
    ],
  };
}
