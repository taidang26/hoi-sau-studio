# @hoi-sau/pipeline

One episode a day, end to end, without anyone at the keyboard.

```bash
npm run pipeline -- run --mock            # rehearsal: fake models, fake Graph API, everything in data-demo/
npm run pipeline -- run                   # today's real episode (skipped if today already has one)
npm run pipeline -- run --no-publish      # make it, don't post it
npm run pipeline -- run --force           # another episode today
npm run pipeline -- run --direction "Sao La xin tăng lương" --lead sao-la
npm run pipeline -- schedule --at 19:00   # stay running, one episode a day at 19:00 Hanoi time
npm run pipeline -- status                # last runs, stage by stage
```

## Stages

| Stage | What happens | Output |
| --- | --- | --- |
| listen | Pull comments and replies on the last 20 published posts (Facebook, Instagram, Threads) | `data/comments.json` |
| direction | Pick the story: comments picked on the dashboard first, else the best unused comment, else a quiet-day fallback. Choose the lead and a partner. Create the Studio episode | `episodes/<id>/episode.json` |
| studio | Studio's `runEpisode`: premise → beats → script → storyboard → panels → self-review → lettering → canon | `episodes/<id>/…` |
| motion | 9:16 motion comic, checked against Reels rules | `episodes/<id>/motion/` |
| package | Captions per platform, carousel as 1080x1350 JPEG (Instagram takes only JPEG) | `episodes/<id>/post.json` |
| upload | Copy media to a public HTTPS folder | URLs in `post.json` |
| publish | Reels to Facebook, Instagram, Threads; carousel to Facebook, Instagram (`PIPELINE_POSTS` changes this) | `data/publish-journal.json` |

Episode ids are `<lead>-ep-NNN`, numbered across the series.

**Choosing a comment.** Replies and comments with links, abuse, or almost no words are dropped. The rest score one point, plus two per distinct person who replied, plus one for naming a character, plus one for sounding like a suggestion ("cho…", "tập sau…"). The winner and up to two people who backed it are credited and appear in the episode. A comment is used once.

**One episode, three shapes.** Facebook gets the long caption: logline, the question, how the next episode is chosen, credits. Instagram gets the title and question in the first two lines (the feed cuts there), credits, and a full block of hashtags. Threads gets a one-line hook with one topic tag, and the question is posted as our own first reply under it, where the conversation starts (needs the `threads_manage_replies` scope; without it the post still goes out and the stage notes the missing reply). All of it is in `post.json`.

**Safety hold.** If Studio's self-review still fails a panel after redrawing, the episode is made but not posted, and the run ends as `partial` with the reason, for a person to check on the dashboard. `PIPELINE_PUBLISH_FAILED_REVIEW=1` turns this off.

## Running it again is safe

- A day that finished (`done` or `partial`) is skipped; `--force` makes another.
- A day that failed resumes the same episode: Studio continues from its first unsaved step, motion reuses unchanged clips, and the channel journal never posts the same episode to the same place twice.
- A lock file stops two runs at once (expires after 3 hours if a run crashed).

## Run record

`data/pipeline/runs.json`, newest first, rewritten after every stage:

```json
{
  "id": "2026-11-01", "date": "2026-11-01", "mode": "live", "status": "done",
  "episodeId": "cu-li-ep-007",
  "direction": { "text": "…", "source": "comments", "commentIds": ["…"], "credits": [{ "name": "Lan", "comment": "…" }], "lead": "cu-li", "characters": ["cu-li", "ca-noc"] },
  "stages": [{ "name": "listen", "status": "done", "startedAt": "…", "finishedAt": "…", "note": "6 bình luận mới từ 5 bài, tổng 6" }],
  "posts": [{ "platform": "instagram", "format": "reels-9x16", "status": "published", "postId": "…", "permalink": "…" }],
  "video": "cu-li-ep-007/motion/reel.mp4", "cover": "cu-li-ep-007/motion/cover.jpg"
}
```

Stage status is `running`, `done`, `warn`, `skipped` or `failed`; run status is `running`, `done`, `partial` or `failed`. `video` and `cover` are relative to the episodes folder.

## Scheduling

- **Windows (Tài's PC):** `powershell -ExecutionPolicy Bypass -File scripts\schedule-windows.ps1 -At 19:00` registers a daily task that runs a missed slot when the PC comes back on. Log: `logs\pipeline.log`.
- **Any always-on machine:** `npm run pipeline -- schedule --at 19:00`, or cron `0 12 * * * cd /path/to/hoi-sau && npm run pipeline -- run` (12:00 UTC = 19:00 Hanoi).

## What a real run needs in `.env`

- `META_API_KEY` for Muse Spark and Muse Image.
- `FB_PAGE_ID`, `FB_PAGE_TOKEN` (and `IG_USER_ID`, `THREADS_*`) from `npm run channel -- setup` / `threads-setup`. Platforms without credentials are skipped, not failed.
- `MEDIA_DIR` and `MEDIA_BASE_URL`: a folder that is served on public HTTPS (a static host, a bucket synced from that folder, or a tunnel). Instagram and Threads fetch media by URL.
- `ffmpeg` on PATH (`winget install Gyan.FFmpeg` on Windows).
