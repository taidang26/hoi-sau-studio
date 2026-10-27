# Meta tools in Hồi Sau

Each Meta model has one job it is best at. This page lists what each tool does in the loop, where it is called, and what happens if it is unavailable. Status is updated as work lands; the [build log](build-log.md) has the dates.

## Meta Model API

Base `https://api.meta.ai/v1`, key in `META_API_KEY`. Every client has an offline mock (`--mock`, `MUSE_MOCK=1`).

| Tool | Job in Hồi Sau | Why this model | Where | Status |
| --- | --- | --- | --- | --- |
| **Muse Spark** (`muse-spark-1.3`) | Character bible from a one-line idea; premise, beats, panel script, storyboard, canon; story recap; coach lessons | Strict JSON schemas (`response_format: json_schema, strict: true`) make every step's output machine-checkable; fast enough for many short calls | `packages/studio/src/muse-spark.ts`, `create.ts`, `episode.ts`; `packages/story/src/recap.ts`, `coach.ts` | Done with mock; first real run pending the API key |
| **Muse Spark vision** | Reviews every panel against the locked model sheets and signature features; returns the edit instruction | Can compare a panel image to the reference image, not just read a description | `packages/studio/src/episode.ts` (review step) | Done with mock |
| **Muse Image** (`muse-image-1.0`) | Model sheets; every panel; edit-only redraws after a failed review | Locked model sheet as a reference plus chained turns (`previous_response_id`) keep the character on-model; an edit turn changes one detail and keeps the rest | `packages/studio/src/muse-image.ts`, `consistency.ts`, `episode.ts` | Done with mock; first real run pending the API key |
| **Muse Spark** (talking videos) | Writes a character's 30-second monologue with a gesture per line; for a lip-sync, picks a gesture per line of the sound and writes the title and caption | Same strict-JSON calls as the comic; the gesture list is an enum, so every line maps to a drawn pose | `packages/talk/src/script.ts`, `sync.ts` | Done; first real video 27/10 |
| **Muse Image** (talking videos) | Draws each character once as a talking set: a base shot, six gestures as chained edits of it, and a mouth-open and a blink edit of each gesture | Chained edits (`previous_response_id`) keep framing, background and character identical across the set | `packages/talk/src/art.ts` (`talk art`) | Done; Lolo's set drawn 27/10 |
| **SAM 3.1** (`sam-3.1`) | Finds the mouth and the eyes in each gesture picture so only that part of the mouth/blink edit is pasted in | Text-prompted segmentation ("the mouth", "the eyes") gives the exact region; the rest of the picture stays untouched | `packages/dance/src/sam.ts`, used by `packages/talk/src/art.ts` | Done |
| **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`) | Word times of a sound the character lip-syncs to: captions land on each word, and the mouth only moves inside spoken words | Timing comes from the real audio, not an estimate | `packages/talk/src/transcribe.ts` (`talk sync`) | Wired 27/10; first real call pending |
| **Muse Wonder** | Candidate for season-level planning over the whole canon | Stronger reasoning over long context | Not wired | To be compared with Muse Spark once real runs start |

## Meta open-weight models

| Tool | Job | Why | Where | Status |
| --- | --- | --- | --- | --- |
| **MMS-TTS** (`facebook/mms-tts-vie`) | Tried 27/10 as the talking-video voice | Meta's only Vietnamese speech model | `packages/talk/tts/tts.py` | Kept as a fallback only: one flat voice, not engaging enough. Videos now lip-sync to a recorded sound |
| **Muse Spark Open** (`meta-models/muse-spark-open-1026`) | Scoring comments in batches of 25: idea or not, in character, funny, new; cluster label | Comment volume grows with the audience; open weights on Baseten or Modal keep it off the per-token API budget | `packages/story/src/listen.ts`, `llm.ts` (role `listener`) | Done with mock; falls back to Muse Spark until hosting is set (`MUSE_SPARK_OPEN_URL`, `MUSE_SPARK_OPEN_KEY`) |

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

- The voice in talking videos is a human recording (our own), not generated.
- `ffmpeg` to assemble the motion comic.
- Font: Be Vietnam Pro, SIL Open Font License.
- Background music: royalty-free only, source listed here when chosen.
