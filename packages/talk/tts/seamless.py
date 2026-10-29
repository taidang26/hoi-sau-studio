"""Vietnamese speech with Meta's SeamlessM4T v2 (facebook/seamless-m4t-v2-large), one line at a time.

    python seamless.py lines.json out_dir [--speaker 0] [--seed 7]

Same interface as tts.py: lines.json is [{"id": "01", "text": "..."}]; writes out_dir/<id>.wav (16 kHz mono).
fp16 on the GPU, float32 on the CPU when there is no GPU or it runs out of memory.
The model downloads from Hugging Face on first use (about 9 GB) and needs sentencepiece and protobuf.
"""

import argparse
import json
import os
import sys

import numpy as np
import scipy.io.wavfile
import torch
from transformers import AutoProcessor, SeamlessM4Tv2Model

MODEL = os.environ.get("TALK_SEAMLESS_MODEL", "facebook/seamless-m4t-v2-large")
RATE = 16000


def load():
    if torch.cuda.is_available():
        try:
            return SeamlessM4Tv2Model.from_pretrained(MODEL, torch_dtype=torch.float16).to("cuda").eval(), "cuda"
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            print("seamless: GPU out of memory, using the CPU", file=sys.stderr)
    return SeamlessM4Tv2Model.from_pretrained(MODEL, torch_dtype=torch.float32).eval(), "cpu"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("lines")
    ap.add_argument("out")
    ap.add_argument("--speaker", type=int, default=0)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()

    proc = AutoProcessor.from_pretrained(MODEL)
    model, device = load()
    os.makedirs(a.out, exist_ok=True)
    lines = json.load(open(a.lines, encoding="utf-8"))
    for line in lines:
        torch.manual_seed(a.seed)
        inputs = proc(text=line["text"], src_lang="vie", return_tensors="pt").to(device)
        with torch.no_grad():
            wav = model.generate(**inputs, tgt_lang="vie", speaker_id=a.speaker, generate_speech=True)[0]
        wav = wav.float().cpu().numpy().squeeze()
        wav = np.clip(wav / max(1e-6, float(np.abs(wav).max())) * 0.9, -1, 1)
        scipy.io.wavfile.write(os.path.join(a.out, f"{line['id']}.wav"), RATE, (wav * 32767).astype(np.int16))
        print(f"{line['id']}: {len(wav) / RATE:.2f} s ({device})", file=sys.stderr)


if __name__ == "__main__":
    main()
