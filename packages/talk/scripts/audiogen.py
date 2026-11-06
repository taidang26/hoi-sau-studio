# AudioGen (Meta AudioCraft, facebook/audiogen-medium): python audiogen.py out.wav seconds "prompt" [seed]
# Needs `pip install audiocraft` in the same Python as MusicGen (TALK_PYTHON).
import sys
import torch
from audiocraft.models import AudioGen
from audiocraft.data.audio import audio_write
out, secs, prompt = sys.argv[1], float(sys.argv[2]), sys.argv[3]
torch.manual_seed(int(sys.argv[4]) if len(sys.argv) > 4 else 0)
model = AudioGen.get_pretrained("facebook/audiogen-medium", device="cuda" if torch.cuda.is_available() else "cpu")
model.set_generation_params(duration=secs)
wav = model.generate([prompt])
stem = out[:-4] if out.endswith(".wav") else out
audio_write(stem, wav[0].cpu(), model.sample_rate, strategy="loudness", loudness_compressor=True)
print(out, model.sample_rate)
