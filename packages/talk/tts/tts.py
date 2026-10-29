"""Vietnamese speech with Meta's MMS-TTS (facebook/mms-tts-vie), one line at a time.

    python tts.py lines.json out_dir [--rate 1.0] [--seed 7]

lines.json is [{"id": "01", "text": "..."}]; writes out_dir/<id>.wav (16 kHz mono).
The model downloads from Hugging Face on first use (about 150 MB).
"""

import argparse
import json
import os
import re
import sys

import numpy as np
import scipy.io.wavfile
import torch
from transformers import AutoTokenizer, VitsModel

MODEL = os.environ.get("TALK_TTS_MODEL", "facebook/mms-tts-vie")


def clean(text: str) -> str:
    # The MMS Vietnamese vocabulary is lower-case letters and spaces; punctuation becomes a pause.
    text = text.lower()
    text = re.sub(r"[.!?…]+", " , ", text)
    text = re.sub(r"[^\w\s,]", " ", text)
    return re.sub(r"\s+", " ", text).strip(" ,")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("lines")
    ap.add_argument("out")
    ap.add_argument("--rate", type=float, default=1.0, help="speaking rate, above 1 is faster")
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    tok = AutoTokenizer.from_pretrained(MODEL)
    model = VitsModel.from_pretrained(MODEL).to(device).eval()
    model.speaking_rate = a.rate
    os.makedirs(a.out, exist_ok=True)
    lines = json.load(open(a.lines, encoding="utf-8"))
    for line in lines:
        torch.manual_seed(a.seed)
        inputs = tok(clean(line["text"]), return_tensors="pt").to(device)
        with torch.no_grad():
            wav = model(**inputs).waveform[0].float().cpu().numpy()
        wav = np.clip(wav / max(1e-6, float(np.abs(wav).max())) * 0.9, -1, 1)
        scipy.io.wavfile.write(os.path.join(a.out, f"{line['id']}.wav"), model.config.sampling_rate, (wav * 32767).astype(np.int16))
        print(f"{line['id']}: {len(wav) / model.config.sampling_rate:.2f} s", file=sys.stderr)


if __name__ == "__main__":
    main()
