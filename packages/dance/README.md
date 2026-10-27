# @hoi-sau/dance

Trend dance videos: a person dancing in a clip becomes one of our characters dancing the same moves, on the clip's own beat. Only Meta models:

| Step | Model | Where |
| --- | --- | --- |
| Draw the character front-on in an A-pose, on-model from its locked sheets | Muse Image 1.0 | Meta Model API |
| Cut the drawing into head, torso, upper arms, forearms, thighs, shins; find the joints | SAM 3.1 (`sam-3.1`), parsed with Meta's `@meta-sam/parser` | Meta Model API |
| Read every person's pose, frame by frame | Keypoint R-CNN (Meta AI Research), open weights via torchvision | locally, `pose/extract_pose.py` |
| Move the puppet, render 9:16 | our code (resvg + ffmpeg) | locally |

```bash
pip install -r packages/dance/pose/requirements.txt     # once
npm run dance -- pose clips/trend.mp4                    # data/dance/trend.poses.json
npm run dance -- rest cu-li                              # characters/cu-li/rig/rest.png (Muse Image)
npm run dance -- cut cu-li                               # rig.yaml + parts + check.png (SAM 3.1)
npm run dance -- render data/dance/trend.poses.json --cast cu-li,sao-la --compare clips/trend.mp4
npm run dance -- demo                                    # no Python, no API: made-up dance, placeholder puppets
```

- **Cast.** The first character follows the person who moves most, the next one the next most, and so on. Each one takes that person's place and size in the frame, so "one dances at the back, one stands still in front" survives the swap. `--mirror` flips the moves.
- **Beat.** Moves are taken frame for frame from the clip, which is already on the music, so nothing is re-timed. The output is silent: add the trending sound in the Instagram or Facebook app when posting (a licensed track cannot be attached through the API, and a song baked into the file can get the video muted).
- **`--compare`** puts the source clip beside the puppet for checking. Never post that version.
- **Rig.** `characters/<slug>/rig/rig.yaml` lists bones (pivot and tip, in the rest drawing's pixels) and parts (image, top-left, size, paint order). After `cut`, look at `check.png`: red dots are joints, and any of them can be nudged in rig.yaml by hand. A character without a rig dances as a placeholder drawn from its palette (`dance rig <slug>` writes one).
- **Rest drawing.** Gaps between the arms and the body, and between the legs, matter: SAM cuts each limb as its own region. If `cut` says it found too few arms or legs, draw the rest pose again.
