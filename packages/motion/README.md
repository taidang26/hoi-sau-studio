# @hoi-sau/motion

Turns a finished Studio episode into a vertical motion comic for Reels and Threads.

```bash
npm run motion -- episode cu-li-ep-003            # episodes/cu-li-ep-003/ → motion/reel.mp4, cover.jpg, subs.srt
npm run motion -- episode cu-li-ep-003 --draft    # 540x960, fast, for previews
npm run motion -- episode cu-li-ep-003 --audio music.mp3
npm run motion -- check episodes/cu-li-ep-003/motion/reel.mp4
```

Needs `ffmpeg` and `ffprobe` on PATH, or `FFMPEG_PATH` / `FFPROBE_PATH`.

## What it reads

Only what Studio saved in `episodes/<id>/`:

| File | Used for |
| --- | --- |
| `letter.json` + `final/NN.png` | Page order; the lettered page is the fallback image |
| `panels.json` + `panels/…` | The unlettered art, so the camera can move the art without moving the text |
| `script.json` | Dialogue: how long each panel stays on screen, when each bubble appears, subtitles |
| `storyboard.json` | Shot size and staging → camera move and where it ends |
| `premise.json`, `episode.json` | Title card, hook on the end card, credited commenters |

## How a panel moves

| Storyboard shot | Move |
| --- | --- |
| wide | slow pan across, alternating direction |
| medium | push in towards the first speaker |
| close-up | stronger push in |
| extreme close-up, and always the last panel | punch: fast zoom with a short shake |

The art is upscaled 4x before `zoompan`, so the motion does not jitter. Speech bubbles are rendered as separate transparent layers with the same layout and renderer as Studio's letter step (`bubbleLayout` + `svg-text`); they stay still over the moving art and fade in one after another, timed to reading speed (about 14 Vietnamese characters a second).

The 4:5 panel fills the width of the 9:16 frame and sits between the app's top and bottom bars, over a blurred copy of itself. The series label stays on top. An intro card shows the title, an end card asks for comments ("Tập sau do bạn viết") and thanks the commenters.

## Output

`episodes/<id>/motion/`:

- `reel.mp4`: H.264 High, yuv420p, 30 fps, AAC 48 kHz (silent when there is no music), `+faststart`.
- `cover.jpg`: a frame of the first panel.
- `subs.srt`: dialogue with speaker names.
- `motion.json`: timeline (start and end of each clip) and the spec it was made from.
- `work/`: one clip per panel, reused when its inputs have not changed.

`check` (and the pipeline) verify the video against Reels and Threads rules: 9:16, H.264, yuv420p, 23–60 fps, 3–90 s, AAC.

## From code

```ts
import { renderMotionComic, specFromEpisode } from "@hoi-sau/motion";
const spec = specFromEpisode("episodes/cu-li-ep-003", { names: { "cu-li": "Cu Li" } });
const { video, cover, duration } = await renderMotionComic(spec, "episodes/cu-li-ep-003/motion");
```

`MotionSpec` also works without Studio: any list of images with a duration and a move (`"push-in"`, `"pan-left"`, `"punch"`… or explicit framings).
