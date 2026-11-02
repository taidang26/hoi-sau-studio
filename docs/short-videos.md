# Short videos

Next to the daily comic, Hồi Sau posts two 9:16 clips a day (12:00 and 20:00 Hanoi) on Facebook and Instagram Reels, TikTok, and as a still with a question on Threads. This page shows how a clip is made and posted, and which parts already run without a developer.

## Two kinds of clip

| Kind | What it is | Made with |
| --- | --- | --- |
| **Illustrated voice-over** | An original sound, one full-frame picture per line, two poses per shot, optional moving mouth for whoever is speaking, bubbles in Northern Vietnamese | Dashboard **Video** screen (`talk illustrate`) |
| **Text meme** | A silent scene or two with the joke as large text in two beats (set-up, then the punchline), a quiet blink or gesture, and instrumental music | `talk` scripts below, run by hand for now |

Every picture keeps the characters on-model (Tũn in the yellow hoodie and staff badge) and in the Hồi Sau office. A reference clip from another page gives only the idea and the words, never its layout, props or costumes.

## Making an illustrated clip on the dashboard

`npm run dashboard`, then open http://localhost:4321 → **Video**.

1. Pick a sample clip (or upload one) and the lead character. The studio splits it into shots and Muse Spark plans each one; Muse Image draws one picture per shot, then a second pose; SAM 3.1 holds the room still between poses and finds the mouth.
2. Check every shot at full size. Each has buttons to redraw it with a note of what is wrong, redraw only pose 2, keep one pose, drop the mouth, or edit the line, bubble and scene.
3. Render. Approval needs every shot ticked, a render newer than every picture, and a caption of at most 220 characters. It copies the video and a 4:5 Threads still to the site, approves both posts and deploys.
4. Publish now or at a set time. The dashboard checks its schedule every 30 seconds, so it has to stay open; for posts that must go out while it is closed, use the scheduled tasks below.

## Text memes (scripts)

These live in `packages/talk/scripts/` and need Python with OpenCV; MusicGen also needs PyTorch with a GPU.

| Script | Job |
| --- | --- |
| `musicgen.py out.wav <seconds> "<prompt>" [seed]` | Instrumental background music with Meta's MusicGen (`facebook/musicgen-small`, open weights, local) |
| `blink.py in.png out.png x0,y0,x1,y1` | A closed-eye frame drawn onto pose A itself, so only the eyes change |
| `align_pose.py <shots_dir> s01:x0,y0,x1,y1[@dx,dy\|@sift][;...]` | Pastes small regions (a mouth, a hand counting money) of pose B onto pose A under a feathered edge, so the background never jumps |

The two-beat text and the final encode are still set per clip by hand. Turning them into a `talk meme` command and a dashboard option is the next step.

## Covers and the download page

Each clip gets a TikTok cover in one house style: a straight white badge with a black border, 1–2 key words in red, and a "Hồi Sau" tag, inside the TikTok safe zone (`talk cover`). `studio tai` builds https://hoisau.web.app/tai from the approved posts, so the owner can save each clip and cover to a phone and post on TikTok by hand.

## Posting on a schedule without anyone at the keyboard

`scripts/post-clip.ps1 <post-id>` posts one approved clip: Facebook and Instagram Reels, the Threads still, then one TikTok draft. Networks already in the publish journal are skipped and the TikTok draft is sent once, so running it twice never double-posts. It logs to `logs/post-<id>.log`.

`scripts/schedule-posts.ps1` registers one Windows scheduled task per line of a plan file (copy `scripts/post-plan.example.txt` to `data/post-plan.txt`):

```text
2026-11-03 12:00 pilot-satank-9
2026-11-03 20:00 pilot-chikhang-10
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\schedule-posts.ps1            # create or update the tasks
powershell -ExecutionPolicy Bypass -File scripts\schedule-posts.ps1 -Remove    # delete them
```

The tasks wake the computer from sleep; it must not be shut down. Only approved posts go out: `channel publish` refuses a post whose files changed after approval.
