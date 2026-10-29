# Meta tools in Hồi Sau

Each Meta model has one job it is best at. This page lists what each tool does in the loop, where it is called, and what happens if it is unavailable. Status is updated as work lands; the [build log](build-log.md) has the dates.

## Meta Model API

Base `https://api.meta.ai/v1`, key in `META_API_KEY`. Every client has an offline mock (`--mock`, `MUSE_MOCK=1`). The first real runs were on 27 Oct 2026 on the developer's machine (34 Muse Image calls for the first four sheets, under $0.50).

| Tool | Job in Hồi Sau | Why this model | Status |
| --- | --- | --- | --- |
| **Muse Spark** (`muse-spark-1.3`) | Writes, checks and remembers: every text step below | Strict JSON schemas (`response_format: json_schema, strict: true`) make every output machine-checkable; fast enough for many short calls | Real runs from 27 Oct |
| **Muse Spark vision** | Reviews every panel against the locked sheets; reads reference images for recipes | Compares a picture to a reference picture, not just a description | Real runs from 27 Oct |
| **Muse Image** (`muse-image-1.0`) | Draws: series style, model and pose sheets, brand art, every panel, edit-only redraws | A locked sheet as reference plus chained turns (`previous_response_id`) keep a character on-model; an edit turn changes one detail and keeps the rest | Real runs from 27 Oct |
| **Muse Voice Transcribe** | Time-aligned subtitles for the motion comic | Subtitles follow the real voice track | In progress (video work) |
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

The clients are `packages/studio/src/muse-spark.ts` and `muse-image.ts` (Studio) and `packages/story/src/llm.ts` (story, with roles `writer`, `judge` and `listener`).

## Meta open-weight models

| Tool | Job | Why | Where | Status |
| --- | --- | --- | --- | --- |
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
| Muse Voice Transcribe | Subtitles come from the script with estimated timing. |
| Graph or Threads API | Temporary errors and rate limits are retried with backoff; a token or permission error stops and shows on the dashboard. |

## Outside Meta

Tools that are not AI models; not part of the core and replaceable:

- No voice from outside Meta: the organisers require every model called at run time to be Meta's, so talking videos use Meta's open-weight speech models (MMS-TTS, SeamlessM4T v2) or no voice at all.
- `ffmpeg` to assemble the motion comic.
- Font: Be Vietnam Pro, SIL Open Font License.
- Background music: MusicGen (Meta, open weights) or royalty-free tracks, with the source listed here.
