# @hoi-sau/talk

A character talks straight to camera for about 30 seconds, like a vlogger: the
format big Vietnamese character channels use for Reels and TikTok. Meta models
only.

| Step | Model |
| --- | --- |
| Monologue, one gesture per line, title and post caption | Muse Spark (`talk_script` schema), then the series safety gate |
| Base shot and six gestures (explain, point, shrug, think, shock, defend) | Muse Image, each gesture a chained edit of the base so framing and background stay put |
| Mouth-open and blink frames | Muse Image edits; SAM 3.1 finds the mouth and eyes and only those are pasted in, lined up and feathered |
| Voice | SeamlessM4T v2 (`facebook/seamless-m4t-v2-large`, Meta, open weights, runs locally, fp16 on the GPU), pitched ×1.12 and sped ×1.05 for the character; `--tts mms` (or a failed Seamless run) uses the lighter MMS-TTS (`facebook/mms-tts-vie`); or your own recordings; or `--tts mms-hn`, MMS-TTS fine-tuned on our own Hà Nội recordings (see below) |

The video: jump cuts between gestures with the camera switching wide/close,
punch-ins on shock lines, a slow drift, blinks every few seconds, the mouth
following the loudness of the voice, CapCut-style word captions and a title
band. 1080x1920, H.264/AAC, checked against the Reels spec.

```bash
pip install -r packages/talk/tts/requirements.txt   # torch first, CUDA build if you have an NVIDIA card
npm run talk -- art cu-li                           # once per character: ~17 Muse Image calls, saved in characters/cu-li/talk/
npm run talk -- make cu-li --topic "sếp nhắn em lên phòng anh một chút"
npm run talk -- make cu-li --script script.json --voice recordings/   # your own voice: 01.wav, 02.wav... one per line
npm run talk -- demo                                # offline, mock pictures and a hummed voice
```

Output goes to `data/talk/<slug>-<time>/`: `script.json`, `safety.json`,
`<slug>.mp4`, `post.txt` (the caption). Nothing is posted; publish through the
channel package after you approve it. `TALK_PYTHON` (or `DANCE_PYTHON`) picks
the Python that has torch.

## Video kinds

Every kind stays available; pick per clip, none replaces another.

| Kind | Command | What you see |
| --- | --- | --- |
| Talking to camera | `talk make <slug>` | One character at a desk or standing on a set, gestures, mouth on the voice |
| Lip-sync to a sound | `talk sync <slug> <sound>` | The same character mouthing a sound you give it |
| Illustrated voice-over | `talk illustrate <slug> <clip>` | The clip's voice, one full-frame picture per shot, two poses, bubble and captions |
| Illustrated, talking | `talk illustrate <slug> <clip> --mouth` | As above, and the lead's mouth opens and shuts with the voice |

## Depth and grounding

Rules for every backdrop (drawn set or photo) a cut-out character stands on, so it stands in the place instead of floating in front of it:

- **Focus on the character's plane.** The character and the ground its feet stand on are fully sharp.
- **Near sharp, far softer.** Blur grows with distance into the scene, towards the vanishing point (up to about sigma 8 at the end of the street and the sky); the ground at the bottom and the walls at the sides stay sharp. Never one uniform blur over the whole backdrop.
- **Feet on the ground plane.** The feet are below the horizon (the vanishing point's height), on the road or floor, at a size that fits the perspective there.
- **Always a contact shadow** under the feet: soft, clearly darker than the ground, a little wider than the feet.
- **The backdrop is warmer, grainier and darker at the corners than the character**, so the clean character is the brightest thing in the frame.
- **Each drawn set records its vanishing point** (`vp` in `src/sets.ts`, shares of the 1080x1920 frame, estimated by eye). Photos and plain backdrops use (0.5, 0.45). A new set needs a camera at standing eye height looking down the street or room (one-point perspective), with a clear stretch of ground in front where the character stands.

## Safe area

TikTok, Reels and Shorts put their own bar at the top, the channel name and caption at the bottom and a button column on the right. Everything that matters stays inside `SAFE` (`src/timeline.ts`: x 60–940, y 250–1480 of 1080x1920): the title at its top, the captions under the title when the character stands on a backdrop (above its head) or at its bottom otherwise, and the whole standing character, centred on `SAFE_CX` with its feet on the safe area's bottom line. Each render writes `<slug>.safe.jpg`, a middle frame with the safe area drawn on it, to check by eye.

## Lip-sync to a sound

```bash
npm run talk -- sync cu-li my-sound.m4a                  # or a video; --start/--duration to cut a clip
npm run talk -- sync cu-li my-sound.m4a --lyrics words.txt   # when transcription is off: one line of words per line
```

Muse Voice Transcribe gives each word's time, Muse Spark picks a gesture per
line and writes the title and caption, the safety gate reads the words, and
the mouth moves only inside spoken words. Besides `<slug>.mp4` it writes
`<slug>.silent.mp4`: post that one and pick the same sound in the app's sound
library, so a sound you don't own is not muted.

## Illustrated, talking (`--mouth`)

```bash
npm run talk -- illustrate cu-li clip.mp4 --out data/talk/x --step mouths   # on a clip already drawn: ~1 Muse Image call per picture
npm run talk -- illustrate cu-li clip.mp4 --out data/talk/x --step render --mouth --vocals stem.wav
```

For each shot picture and its pose B, SAM 3.1 finds the lead's mouth (the
mouth find that sits on the lead, so another character's mouth stays shut),
Muse Image redraws the picture with that mouth open, and only the mouth is
pasted back (`<pic>-m.png`). A picture where SAM finds no mouth of the lead
keeps it shut. At render time the mouth follows the loudness of the voice
(a vocal stem works best) and only inside heard words. The output is
`<slug>-mouth.mp4`, next to the plain `<slug>.mp4`.

## Our own Hà Nội voice (`--tts mms-hn`)

`facebook/mms-tts-vie` fine-tuned on about 7 minutes of the owner reading a
70-line office script twice (see `voice/bai-doc-thu-giong.md` in the project).
`tts/split.py` cuts the recording into one clip per line; the fine-tune itself
runs with [finetune-hf-vits](https://github.com/ylacombe/finetune-hf-vits).
Point `TALK_HN_MODEL` at the trained folder (`config.json`, `model.safetensors`,
tokenizer files); the weights are not committed.

**Licence:** the base model is CC BY-NC 4.0 and the fine-tune inherits it, so
this voice is for the hackathon and other non-commercial use only.
