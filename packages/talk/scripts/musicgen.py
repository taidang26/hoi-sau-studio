# MusicGen (Meta, facebook/musicgen-small): python musicgen.py out.wav seconds "prompt"
import sys
import numpy as np, scipy.io.wavfile as wav, torch
from transformers import AutoProcessor, MusicgenForConditionalGeneration
out, secs, prompt = sys.argv[1], float(sys.argv[2]), sys.argv[3]
proc = AutoProcessor.from_pretrained("facebook/musicgen-small")
model = MusicgenForConditionalGeneration.from_pretrained("facebook/musicgen-small").to("cuda")
inp = proc(text=[prompt], padding=True, return_tensors="pt").to("cuda")
torch.manual_seed(int(sys.argv[4]) if len(sys.argv) > 4 else 0)
audio = model.generate(**inp, do_sample=True, guidance_scale=3, max_new_tokens=int(secs * 50) + 10)
rate = model.config.audio_encoder.sampling_rate
wav.write(out, rate, (audio[0, 0].cpu().numpy() * 32767).clip(-32768, 32767).astype(np.int16))
print(out, rate)
