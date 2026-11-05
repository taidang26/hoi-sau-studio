/**
 * Body poses read from a dance video, one track per person.
 *
 * `pose/extract_pose.py` writes this file with Meta's open Keypoint R-CNN
 * (torchvision) on the machine that has the weights. Keypoints follow COCO:
 * 17 points per person, each [x, y, score] in source pixels.
 */

export const KP = {
  nose: 0,
  leftEye: 1,
  rightEye: 2,
  leftEar: 3,
  rightEar: 4,
  leftShoulder: 5,
  rightShoulder: 6,
  leftElbow: 7,
  rightElbow: 8,
  leftWrist: 9,
  rightWrist: 10,
  leftHip: 11,
  rightHip: 12,
  leftKnee: 13,
  rightKnee: 14,
  leftAnkle: 15,
  rightAnkle: 16,
} as const;

export type Keypoint = [x: number, y: number, score: number];
export type Pose = Keypoint[];

export interface PoseTrack {
  id: number;
  /** One entry per video frame; null where the person was not found. */
  frames: (Pose | null)[];
}

export interface PoseFile {
  source?: string;
  model?: string;
  fps: number;
  width: number;
  height: number;
  frameCount: number;
  tracks: PoseTrack[];
}

export type Vec = [number, number];

const mid = (a: Keypoint, b: Keypoint): Vec => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dist = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Frames of a track where the body was seen well enough to use. */
export function coverage(track: PoseTrack, minScore = 0.3): number {
  const torso = [KP.leftShoulder, KP.rightShoulder, KP.leftHip, KP.rightHip];
  const seen = track.frames.filter((p) => p && torso.every((i) => p[i][2] >= minScore)).length;
  return track.frames.length ? seen / track.frames.length : 0;
}

/** Median torso length in pixels: the track's size on screen. */
export function torsoLength(track: PoseTrack): number {
  const lens = track.frames
    .filter((p): p is Pose => !!p)
    .map((p) => dist(mid(p[KP.leftShoulder], p[KP.rightShoulder]), mid(p[KP.leftHip], p[KP.rightHip])))
    .filter((l) => l > 0)
    .sort((a, b) => a - b);
  return lens.length ? lens[Math.floor(lens.length / 2)] : 0;
}

/** How much the limbs move, relative to body size. The dancer is the track that moves most. */
export function motionEnergy(track: PoseTrack): number {
  const size = torsoLength(track) || 1;
  const limbs = [KP.leftWrist, KP.rightWrist, KP.leftElbow, KP.rightElbow, KP.leftKnee, KP.rightKnee, KP.leftAnkle, KP.rightAnkle];
  let sum = 0;
  for (let f = 1; f < track.frames.length; f++) {
    const a = track.frames[f - 1];
    const b = track.frames[f];
    if (!a || !b) continue;
    for (const i of limbs) if (a[i][2] > 0.3 && b[i][2] > 0.3) sum += dist([a[i][0], a[i][1]], [b[i][0], b[i][1]]);
  }
  return sum / size / Math.max(1, track.frames.length);
}

/** Tracks seen in at least `minCoverage` of the frames, the most active dancer first. */
export function rankTracks(file: PoseFile, minCoverage = 0.3): PoseTrack[] {
  return file.tracks.filter((t) => coverage(t) >= minCoverage).sort((a, b) => motionEnergy(b) - motionEnergy(a));
}

/**
 * Fills gaps and low-confidence points by linear interpolation per keypoint,
 * then smooths forward and backward (no lag) so the puppet does not jitter.
 * Returns a pose for every frame, or null when the track never had the point.
 */
export function cleanTrack(track: PoseTrack, opts: { minScore?: number; smoothing?: number } = {}): Pose[] {
  const minScore = opts.minScore ?? 0.3;
  const a = opts.smoothing ?? 0.5; // 0 = raw, closer to 1 = smoother
  const n = track.frames.length;
  const out: Pose[] = Array.from({ length: n }, () => Array.from({ length: 17 }, () => [0, 0, 0] as Keypoint));
  for (let k = 0; k < 17; k++) {
    const good: number[] = [];
    for (let f = 0; f < n; f++) if ((track.frames[f]?.[k]?.[2] ?? 0) >= minScore) good.push(f);
    if (!good.length) continue;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    let g = 0;
    for (let f = 0; f < n; f++) {
      while (g < good.length - 1 && good[g + 1] <= f) g++;
      const f0 = good[g];
      const f1 = good[Math.min(g + 1, good.length - 1)];
      const p0 = track.frames[f0]![k];
      const p1 = track.frames[f1]![k];
      const t = f <= f0 ? 0 : f >= f1 ? 1 : (f - f0) / (f1 - f0);
      xs[f] = p0[0] + (p1[0] - p0[0]) * t;
      ys[f] = p0[1] + (p1[1] - p0[1]) * t;
    }
    for (const arr of [xs, ys]) {
      for (let f = 1; f < n; f++) arr[f] = a * arr[f - 1] + (1 - a) * arr[f];
      for (let f = n - 2; f >= 0; f--) arr[f] = a * arr[f + 1] + (1 - a) * arr[f];
    }
    for (let f = 0; f < n; f++) out[f][k] = [xs[f], ys[f], (track.frames[f]?.[k]?.[2] ?? 0) >= minScore ? 1 : 0.5];
  }
  return out;
}

/** Bones the puppet has, each a direction between two body points. */
export const BONES = ["torso", "head", "upperArmL", "foreArmL", "upperArmR", "foreArmR", "thighL", "shinL", "thighR", "shinR"] as const;
export type Bone = (typeof BONES)[number];

export interface BodyFrame {
  /** Mid-hip in source pixels. */
  hips: Vec;
  /** Absolute direction of each bone, radians, screen space (y down). */
  angles: Record<Bone, number>;
}

const angle = (from: Vec, to: Vec) => Math.atan2(to[1] - from[1], to[0] - from[0]);
const pt = (p: Pose, i: number): Vec => [p[i][0], p[i][1]];

/** Bone directions of one pose. "Left" is the dancer's own left, as the puppet's. */
export function bodyFrame(p: Pose): BodyFrame {
  const hips = mid(p[KP.leftHip], p[KP.rightHip]);
  const shoulders = mid(p[KP.leftShoulder], p[KP.rightShoulder]);
  const ears = p[KP.leftEar][2] && p[KP.rightEar][2] ? mid(p[KP.leftEar], p[KP.rightEar]) : pt(p, KP.nose);
  return {
    hips,
    angles: {
      torso: angle(hips, shoulders),
      head: angle(shoulders, ears),
      upperArmL: angle(pt(p, KP.leftShoulder), pt(p, KP.leftElbow)),
      foreArmL: angle(pt(p, KP.leftElbow), pt(p, KP.leftWrist)),
      upperArmR: angle(pt(p, KP.rightShoulder), pt(p, KP.rightElbow)),
      foreArmR: angle(pt(p, KP.rightElbow), pt(p, KP.rightWrist)),
      thighL: angle(pt(p, KP.leftHip), pt(p, KP.leftKnee)),
      shinL: angle(pt(p, KP.leftKnee), pt(p, KP.leftAnkle)),
      thighR: angle(pt(p, KP.rightHip), pt(p, KP.rightKnee)),
      shinR: angle(pt(p, KP.rightKnee), pt(p, KP.rightAnkle)),
    },
  };
}
