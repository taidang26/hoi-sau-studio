/**
 * Where the beats fall in a song, so cuts and pose changes land on them. A spectral-flux onset envelope,
 * the tempo from its autocorrelation (weighted toward ~120 bpm), then Ellis' dynamic-programming beat
 * tracker. No model, no Python: plain arithmetic over the clip's mono PCM.
 */

const N = 2048;

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const p = i + k, q = p + len / 2;
        const tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
        re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

/** Onset strength per hop: how much louder each frequency got since the last frame, summed. */
export function onsetEnvelope(pcm: Int16Array, rate: number): { env: Float64Array; hop: number } {
  const hop = Math.round(rate / 46.875); // ~21 ms, whatever the rate
  const frames = Math.max(0, Math.floor((pcm.length - N) / hop) + 1);
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const env = new Float64Array(frames);
  let prev = new Float64Array(N / 2);
  for (let f = 0; f < frames; f++) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = (pcm[f * hop + i] / 32768) * win[i];
    fft(re, im);
    const mag = new Float64Array(N / 2);
    let flux = 0;
    for (let k = 1; k < N / 2; k++) {
      mag[k] = Math.log1p(1000 * Math.hypot(re[k], im[k]));
      if (f) flux += Math.max(0, mag[k] - prev[k]);
    }
    env[f] = flux;
    prev = mag;
  }
  // Take away the slow loudness swell, keep the peaks.
  const r = 8, out = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, f - r); j <= Math.min(frames - 1, f + r); j++) (s += env[j]), c++;
    out[f] = Math.max(0, env[f] - s / c);
  }
  const sd = Math.sqrt(out.reduce((n, x) => n + x * x, 0) / Math.max(1, frames)) || 1;
  return { env: out.map((x) => x / sd), hop };
}

/** Beats per minute from the envelope's autocorrelation, favouring tempos near 120. */
export function estimateTempo(env: Float64Array, fps: number, lo = 60, hi = 190): number {
  let best = 120, score = -Infinity;
  for (let lag = Math.floor((60 * fps) / hi); lag <= Math.ceil((60 * fps) / lo); lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    const bpm = (60 * fps) / lag;
    s *= Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
    if (s > score) (score = s), (best = bpm);
  }
  return best;
}

/** Beat times in seconds: strong onsets about one period apart (Ellis 2007, tightness 100). */
export function detectBeats(pcm: Int16Array, rate: number): { bpm: number; beats: number[] } {
  const { env, hop } = onsetEnvelope(pcm, rate);
  const fps = rate / hop;
  if (env.length < 4) return { bpm: 0, beats: [] };
  const bpm = estimateTempo(env, fps);
  const period = (60 * fps) / bpm;
  const score = new Float64Array(env.length), back = new Int32Array(env.length).fill(-1);
  for (let i = 0; i < env.length; i++) {
    let best = 0;
    for (let j = Math.max(0, Math.round(i - 2 * period)); j <= i - Math.round(period / 2); j++) {
      const v = score[j] - 100 * Math.log((i - j) / period) ** 2;
      if (back[i] < 0 || v > best) (best = v), (back[i] = j);
    }
    score[i] = env[i] + (back[i] >= 0 ? best : 0);
  }
  // Start from the best score in the last period and walk back.
  let i = env.length - 1;
  for (let j = Math.max(0, Math.round(env.length - period)); j < env.length; j++) if (score[j] > score[i]) i = j;
  const out: number[] = [];
  for (; i >= 0; i = back[i]) out.push(+((i * hop + N / 2) / rate).toFixed(3));
  return { bpm: +bpm.toFixed(1), beats: out.reverse() };
}

/**
 * The beat a cut at `t` should move to: the nearest one from `early` seconds before to `late` after
 * (a cut may land a hair before the singing, not well after it). Undefined when no beat is close.
 */
export function snapTo(t: number, beats: number[], early = 0.3, late = 0.15): number | undefined {
  let best: number | undefined;
  for (const b of beats) if (b >= t - early && b <= t + late && (best === undefined || Math.abs(b - t) < Math.abs(best - t))) best = b;
  return best;
}

/** Shot starts moved onto beats; the first shot stays at 0 and no shot gets shorter than `min` seconds. */
export function snapShots<T extends { t: number }>(shots: T[], beats: number[], min = 0.6): T[] {
  const out = shots.map((s) => ({ ...s }));
  for (let i = 1; i < out.length; i++) {
    const b = snapTo(out[i].t, beats);
    if (b === undefined || b - out[i - 1].t < min || (out[i + 1] && out[i + 1].t - b < min)) continue;
    out[i].t = b;
  }
  return out;
}

/**
 * When a shot with several poses changes pose: at each later caption line's start inside the shot, moved onto
 * a beat, and for a shot with one line, on the beat nearest its middle. At least `min` s between changes.
 */
export function poseSwitches(start: number, end: number, lineStarts: number[], beats: number[], min = 0.8): number[] {
  let at = lineStarts.filter((t) => t > start + min && t < end - min).map((t) => snapTo(t, beats) ?? t);
  if (!at.length && end - start >= 2 * min) {
    const mid = (start + end) / 2;
    const near = beats.filter((b) => b > start + min && b < end - min).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0];
    at = [near ?? mid];
  }
  return at.filter((t, i) => !i || t - at[i - 1] >= min);
}
