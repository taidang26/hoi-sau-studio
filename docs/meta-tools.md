# Meta tools in Hồi Sau

Each Meta model has one job it is best at. This page lists what each tool does in the loop, where it is called, and what happens if it is unavailable. Status is updated as work lands; the [build log](build-log.md) has the dates.

## Meta Model API

Base `https://api.meta.ai/v1`, key in `META_API_KEY`. Every client has an offline mock (`--mock`, `MUSE_MOCK=1`). The first real runs were on 27 Oct 2026 on the developer's machine (34 Muse Image calls for the first four sheets, under $0.50).

| Tool | Job in Hồi Sau | Why this model | Status |
| --- | --- | --- | --- |
| **Muse Spark** (`muse-spark-1.3`) | Writes, checks and remembers: every text step below | Strict JSON schemas (`response_format: json_schema, strict: true`) make every output machine-checkable; fast enough for many short calls | Real runs from 27 Oct |
| **Muse Spark vision** | Reviews every panel against the locked sheets; reads reference images for recipes | Compares a picture to a reference picture, not just a description | Real runs from 27 Oct |
| **Muse Image** (`muse-image-1.0`) | Draws: series style, model and pose sheets, brand art, every panel, edit-only redraws | A locked sheet as reference plus chained turns (`previous_response_id`) keep a character on-model; an edit turn changes one detail and keeps the rest | Real runs from 27 Oct |
| **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`) | Time-aligned subtitles for the motion comic; word times of a sound a character lip-syncs to | Timing comes from the real audio, not an estimate | Wired 27/10 (`packages/talk/src/transcribe.ts`); the current key gets 404, so lip-sync uses `--lyrics` until it opens |
| **Muse Spark** (talking videos) | Writes a character's 30-second monologue with a gesture per line; for a lip-sync, picks a gesture per line of the sound and writes the title and caption (`packages/talk/src/script.ts`) | Same strict-JSON calls as the comic; the gesture list is an enum, so every line maps to a drawn pose | Done; first real video 27/10 |
| **Muse Image** (talking videos) | Draws each character once as a talking set: a base shot, six gestures as chained edits of it, and a mouth-open and a blink edit of each gesture (`packages/talk/src/art.ts`) | Chained edits (`previous_response_id`) keep framing, background and character identical across the set | Done; Lolo's set drawn 27/10 |
| **SAM 3.1** (`sam-3.1`) | Finds the mouth and the eyes in each gesture picture so only that part of the mouth/blink edit is pasted in (`packages/dance/src/sam.ts`) | Text-prompted segmentation ("the mouth", "the eyes") gives the exact region; the rest of the picture stays untouched | Done |
| **Muse Wonder** | Candidate writer for season-level planning (`MUSE_WRITER_MODEL`) | Stronger reasoning over long context | Not wired; the writer role accepts it |

### Every call, by step

| Step | Model | Command or screen | Code |
| --- | --- | --- | --- |
| New character from a one-line idea (bible, look, voice, `never_says`) | Muse Spark | `studio character new`, dashboard Studio | `packages/studio/src/create.ts` |
| Series art style test, one scene per variant | Muse Image | `studio style` | `packages/studio/src/style.ts` |
| Model sheet, then pose sheet chained from it (12 extreme comic poses) | Muse Image | `studio sheet <slug>` | `packages/studio/src/consistency.ts` |
| Each character's "edge" picture (their secret side) | Muse Image | `studio edge` | `packages/studio/src/edge-art.ts` |
| Page avatars and covers for every brand and network | Muse Image | `studio brand-art` | `packages/studio/src/brand-art.ts` |
| Premise, beats, panel script, storyboard | Muse Spark | `studio episode run`: premise, beats, script, storyboard | `packages/studio/src/episode.ts` |
| Script safety gate: every line against the banned topics and each character's `never_says`, before anything is drawn | Muse Spark (plus rules) | `studio episode run`: safety | `packages/studio/src/episode.ts`, `packages/story/src/safety.ts` |
| Panels, chained turn to turn with the model sheets as references | Muse Image | `studio episode run`: panels | `packages/studio/src/episode.ts` |
| Panel review against the sheets; returns one edit instruction | Muse Spark vision | `studio episode run`: review | `packages/studio/src/episode.ts` |
| Edit-only redraw of a failed panel | Muse Image | `studio episode run`: review | `packages/studio/src/episode.ts` |
| Canon facts for later episodes | Muse Spark | `studio episode run`: canon | `packages/studio/src/episode.ts` |
| Story recap into series memory | Muse Spark | `story remember` | `packages/story/src/recap.ts` |
| Coach: do/avoid/test lessons from each episode's numbers | Muse Spark | `story coach` | `packages/story/src/coach.ts` |
| Scoring and grouping comments | Muse Spark Open, else Muse Spark | `story listen` | `packages/story/src/listen.ts` |
| Character replies to comments, and the first comment under a new post | Muse Spark Open, else Muse Spark | `story replies`, `story first-comment` | `packages/story/src/engage.ts` |
| Tư liệu: reads reference images into reusable recipes (gag, layout, pose, palette); images never go to Muse Image | Muse Spark vision | dashboard Tư liệu | `packages/dashboard/src/research.ts` |
| Talking video: monologue with a gesture per line (or gestures, title and caption for a lip-synced sound) | Muse Spark | `talk make`, `talk sync` | `packages/talk/src/script.ts`, `sync.ts` |
| Talking set: base shot, six gestures, mouth-open and blink edits, chained | Muse Image | `talk art [--pose stand]` | `packages/talk/src/art.ts` |
| Background sets: real Hanoi places as faded watercolour sketches | Muse Image | `talk sets` | `packages/talk/src/sets.ts` |
| Mouth and eyes in each gesture; character cut-out for a new background | SAM 3.1 | `talk art`, `talk cut` | `packages/dance/src/sam.ts`, `packages/talk/src/art.ts` |
| Word times of a lip-synced sound | Muse Voice Transcribe | `talk sync` | `packages/talk/src/transcribe.ts` |
| Illustrated video: what each shot shows, its second pose and bubble, from the clip's lines | Muse Spark | `talk illustrate --step plan` | `packages/talk/src/illustrate.ts` |
| Illustrated video: one full-frame 9:16 picture per shot, then a second pose as an edit | Muse Image | `talk illustrate --step draw`, `poses` | `packages/talk/src/illustrate.ts` |
| Illustrated video: each picture checked (on-model, drawn once, no text, fills the frame, props the right way round); redrawn on a fail | Muse Spark vision | `talk illustrate --step draw`, `poses` | `packages/talk/src/illustrate.ts` |
| Illustrated video: the characters in both poses, so pose B keeps pose A's background | SAM 3.1 | `talk illustrate --step stabilize` | `packages/talk/src/illustrate.ts`, `patch.ts` |
| Moving mouth: a shut and an open mouth per picture, pasted without touching nose or eyes, checked close up | Muse Image, SAM 3.1, Muse Spark vision | `talk illustrate --step mouths`, `render --mouth` | `packages/talk/src/illustrate.ts` |

The clients are `packages/studio/src/muse-spark.ts` and `muse-image.ts` (Studio) and `packages/story/src/llm.ts` (story, with roles `writer`, `judge` and `listener`).

## Meta open-weight models

| Tool | Job | Why | Where | Status |
| --- | --- | --- | --- | --- |
| **MMS-1B** (`facebook/mms-1b-all`) | Word times of a clip's voice for captions, cuts and the moving mouth | Muse Voice Transcribe returns 404 on our key; MMS-1B is Meta's open speech recogniser and runs on our GPU | `packages/talk/tts/asr.py` | In use for illustrated videos |
| **MMS-TTS** (`facebook/mms-tts-vie`) | Talking-video voice; `--tts mms-hn` is our fine-tune on the owner's Hà Nội recordings | Meta's Vietnamese speech model | `packages/talk/tts/tts.py` | Base voice kept as a fallback; the fine-tune for non-commercial use (CC BY-NC base) |
| **SeamlessM4T v2** (`facebook/seamless-m4t-v2-large`) | Alternative talking-video voice (`--tts seamless`) | More natural than base MMS-TTS | `packages/talk/tts/seamless.py` | Available; not used in published videos |
| **Muse Spark Open** (`meta-models/muse-spark-open-1026`) | Scoring comments in batches of 25: idea or not, in character, funny, new; cluster label. Drafting character replies | Comment volume grows with the audience; open weights on Baseten or Modal keep it off the per-token API budget | `packages/story/src/listen.ts`, `engage.ts`, `llm.ts` (role `listener`) | Done with mock; falls back to Muse Spark until hosting is set (`MUSE_SPARK_OPEN_URL`, `MUSE_SPARK_OPEN_KEY`) |

## Meta platform APIs

The Meta app runs in Development mode, so all of this works on our own Pages and accounts without App Review ([why](meta-integration-notes.md)). Every brand in [channels.yaml](../channels.yaml) uses the same calls with its own ids and tokens.

| API | Job | Permissions | Where |
| --- | --- | --- | --- |
| Facebook Pages API (Graph API) | Publish carousels, single images and videos to each brand's Page; read comments | `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_posts` | `packages/channel/src/publish.ts`, `comments.ts` |
| Instagram Graph API (content publishing) | Publish carousels and Reels; read comments | `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments` | `packages/channel/src/publish.ts`, `comments.ts` |
| Threads API (`graph.threads.net`) | Publish episodes; read replies | `threads_basic`, `threads_content_publish`, `threads_read_replies` | `packages/channel/src/threads.ts` |
| Messenger Platform, Instagram messaging | Inbox: read and answer DMs inside the 24-hour window | `pages_messaging`, `instagram_manage_messages` | `packages/channel/src/inbox.ts` |
| Page, media and thread insights | Reach, shares, saves per post for the coach and [metrics](metrics.md) | `read_insights`, `instagram_manage_insights`, `threads_manage_insights` | `packages/channel/src/insights.ts` (`channel insights`) writes `data/insights.json`; `packages/story/src/coach.ts` reads it |

## Fallbacks

| If this is down | Then |
| --- | --- |
| Muse Image | The episode is not drawn and nothing is posted that day. No other image model, on purpose: consistency is the product. |
| Muse Spark Open hosting | Listening runs on Muse Spark through the Meta Model API, same prompt and batches. |
| Muse Voice Transcribe | Lip-sync takes the words from `--lyrics` and times them against the loud parts of the sound. |
| Graph or Threads API | Temporary errors and rate limits are retried with backoff; a token or permission error stops and shows on the dashboard. |

## Outside Meta

Not part of the core and replaceable:

- No voice from outside Meta: talking videos use MMS-TTS (`--tts mms-hn`, fine-tuned on our own Hà Nội recordings; CC BY-NC base) or SeamlessM4T v2, and illustrated videos keep the clip's own sound.
- `ffmpeg` to assemble the motion comic.
- Fonts: Be Vietnam Pro and Mali (speech bubbles), SIL Open Font License.
- Background music: royalty-free only, source listed here when chosen.
