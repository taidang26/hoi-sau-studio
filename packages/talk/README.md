# @hoi-sau/talk

A character talks straight to camera for about 30 seconds, like a vlogger: the
format big Vietnamese character channels use for Reels and TikTok. Meta models
only.

| Step | Model |
| --- | --- |
| Monologue, one gesture per line, title and post caption | Muse Spark (`talk_script` schema), then the series safety gate |
| Base shot and six gestures (explain, point, shrug, think, shock, defend) | Muse Image, each gesture a chained edit of the base so framing and background stay put |
| Mouth-open and blink frames | Muse Image edits; SAM 3.1 finds the mouth and eyes and only those are pasted in, lined up and feathered |
| Voice | MMS-TTS (`facebook/mms-tts-vie`, Meta, open weights, runs locally), pitched up for the character; or your own recordings |

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
