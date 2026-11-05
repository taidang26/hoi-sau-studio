"""Word times of a Vietnamese voice with Meta's MMS-1B-all (Vietnamese adapter), on the CPU.

    python asr.py voice.wav words.json

Any audio ffmpeg reads (a vocal stem works best). Writes [{"text", "start", "end"}] in seconds.
The model downloads from Hugging Face on first use (about 2.7 GB).
"""

import json
import subprocess
import sys

import numpy as np
import torch
from transformers import AutoProcessor, Wav2Vec2ForCTC

sys.stdout.reconfigure(encoding="utf-8")
audio, out = sys.argv[1], sys.argv[2]
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", audio, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], capture_output=True, check=True).stdout
pcm = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
proc = AutoProcessor.from_pretrained("facebook/mms-1b-all", target_lang="vie")
model = Wav2Vec2ForCTC.from_pretrained("facebook/mms-1b-all", target_lang="vie", ignore_mismatched_sizes=True).eval()
per = model.config.inputs_to_logits_ratio / 16000
step = 20 * 16000
words = []
for at in range(0, len(pcm), step):
    with torch.no_grad():
        ids = model(**proc(pcm[at : at + step], sampling_rate=16000, return_tensors="pt")).logits.argmax(-1)[0]
    for w in proc.tokenizer.decode(ids, output_word_offsets=True).word_offsets:
        words.append({"text": w["word"], "start": round(at / 16000 + w["start_offset"] * per, 2), "end": round(at / 16000 + w["end_offset"] * per, 2)})
json.dump(words, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
print(" ".join(w["text"] for w in words))
