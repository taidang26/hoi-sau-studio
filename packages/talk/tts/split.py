"""Cut one long voice recording into one clip per script line, for fine-tuning MMS-TTS.

    python split.py recording.m4a script.md out_dir [--passes 2] [--sr 16000]

script.md: the lines to read. When it has a numbered list ("1. ..."), only those lines count;
otherwise every line does, with "- " prefixes, headings, blank lines and lines in brackets dropped. The reader reads the whole list `passes` times.
The recording is split at pauses; the pause length is searched until the clip count matches
lines x passes. Writes out_dir/wavs/<NNN>.wav (mono, --sr), out_dir/metadata.csv
(file_name,transcription, the layout `datasets` audiofolder reads) and out_dir/report.json.
Exit code 2 when no pause length gives the right count: the report lists the closest try.
"""

import argparse
import csv
import json
import os
import re
import subprocess
import sys

import numpy as np
import scipy.io.wavfile

FRAME = 0.02


def script_lines(path: str) -> list[str]:
    raw_lines = open(path, encoding="utf-8").read().splitlines()
    # A numbered list ("1. ...") is the script; bullets around it are instructions for the reader.
    numbered = [re.sub(r"^\d+[.)]\s*", "", s.strip()).strip().strip('"“”') for s in raw_lines if re.match(r"^\s*\d+[.)]\s", s)]
    if numbered:
        return [s for s in numbered if s]
    out = []
    for raw in raw_lines:
        s = raw.strip()
        if not s or s.startswith(("#", ">", "|", "```", "(", "[")) or set(s) <= set("-*_= "):
            continue
        s = re.sub(r"^(\d+[.)]|[-*•])\s*", "", s).strip().strip('"“”')
        if s:
            out.append(s)
    return out


def decode(path: str, sr: int) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768


def loudness(x: np.ndarray, sr: int) -> np.ndarray:
    n = int(FRAME * sr)
    frames = x[: len(x) // n * n].reshape(-1, n)
    return 20 * np.log10(np.sqrt((frames ** 2).mean(1)) + 1e-9)


def segments(db: np.ndarray, gap: float, floor: float, shortest: float = 0.35) -> list[tuple[int, int]]:
    """Voiced runs (frame indices) separated by at least `gap` seconds below `floor` dB."""
    voiced = db > floor
    runs, start, quiet = [], None, 0
    for i, v in enumerate(voiced):
        if v:
            if start is None:
                start = i
            quiet = 0
        elif start is not None:
            quiet += 1
            if quiet * FRAME >= gap:
                runs.append((start, i - quiet + 1))
                start, quiet = None, 0
    if start is not None:
        runs.append((start, len(voiced) - quiet))
    return [r for r in runs if (r[1] - r[0]) * FRAME >= shortest]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("recording")
    ap.add_argument("script")
    ap.add_argument("out")
    ap.add_argument("--passes", type=int, default=2)
    ap.add_argument("--sr", type=int, default=16000)
    ap.add_argument("--pad", type=float, default=0.12, help="seconds of room tone kept on each side")
    a = ap.parse_args()

    lines = script_lines(a.script)
    want = len(lines) * a.passes
    x = decode(a.recording, a.sr)
    db = loudness(x, a.sr)
    # The floor sits between the room tone (10th percentile) and the speech (90th); digital
    # silence (exact zeros from an editor) does not count as room tone.
    heard = db[db > -90]
    lo, hi = np.percentile(heard, 10), np.percentile(heard, 90)
    tries = []
    for frac in (0.3, 0.25, 0.35, 0.2, 0.4):
        floor = lo + (hi - lo) * frac
        for gap in np.arange(0.25, 1.6, 0.05):
            segs = segments(db, float(gap), float(floor))
            tries.append((abs(len(segs) - want), float(gap), float(floor), segs))
            if len(segs) == want:
                break
        if tries[-1][0] == 0:
            break
    miss, gap, floor, segs = min(tries, key=lambda t: (t[0], -t[1]))
    report = {"lines": len(lines), "passes": a.passes, "expected": want, "found": len(segs), "gap_s": round(gap, 2), "floor_db": round(floor, 1), "minutes": round(len(x) / a.sr / 60, 1)}
    if miss:
        report["problem"] = f"{len(segs)} clips for {want} lines: check for a skipped, repeated or split line."
        report["clips_s"] = [round((e - s) * FRAME, 2) for s, e in segs]
        os.makedirs(a.out, exist_ok=True)
        json.dump(report, open(os.path.join(a.out, "report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(report["problem"], file=sys.stderr)
        sys.exit(2)

    os.makedirs(os.path.join(a.out, "wavs"), exist_ok=True)
    pad = int(a.pad / FRAME)
    rows, long = [], []
    for k, (s, e) in enumerate(segs):
        s, e = max(0, s - pad), min(len(db), e + pad)
        clip = x[int(s * FRAME * a.sr): int(e * FRAME * a.sr)]
        name = f"{k + 1:03d}.wav"
        scipy.io.wavfile.write(os.path.join(a.out, "wavs", name), a.sr, (np.clip(clip, -1, 1) * 32767).astype(np.int16))
        text = lines[k % len(lines)]
        rows.append((f"wavs/{name}", text))
        # Syllables per second far from a normal reading pace mean the pairing slipped.
        rate = len(text.split()) / max(0.1, len(clip) / a.sr)
        if len(clip) / a.sr > 10 or not 1.5 <= rate <= 7:
            long.append({"file": name, "seconds": round(len(clip) / a.sr, 2), "syllables_per_s": round(rate, 1), "text": text})
    with open(os.path.join(a.out, "metadata.csv"), "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["file_name", "transcription"])
        w.writerows(rows)
    report["check"] = long
    json.dump(report, open(os.path.join(a.out, "report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{len(rows)} clips, pause {gap:.2f} s; {len(long)} to check by ear (report.json)", file=sys.stderr)


if __name__ == "__main__":
    main()
