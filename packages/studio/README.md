# @hoi-sau/studio

Characters, series bible and the episode pipeline on Muse Spark and Muse Image: premise → beats → script → storyboard → panels → review/redraw → lettering → canon. The full plan and the reasoning behind it are in [docs/studio-pipeline.md](../../docs/studio-pipeline.md).

## Character profiles

Each character lives in `characters/<slug>/profile.yaml`: look (English, fed to Muse Image), signature features that must never drift, palette, expressions, personality, voice, lines the character never says, and episode memory. `validateProfile` reports every problem in one pass.

```bash
npm run studio -- characters
```

## Muse Image

`MuseImage` calls the Meta Model API Responses endpoint (`POST https://api.meta.ai/v1/responses`, model `muse-image-1.0`), following Meta's [Muse Image cookbook](https://github.com/meta-models/meta-model-cookbook/tree/main/05_muse_image):

- Each call is a turn. Later turns pass `previous_response_id`, so the server already holds the character sheet and earlier panels. This is how the character stays on-model without re-uploading anything.
- `size` on the `image_generation` tool sets the aspect ratio (`1024x1280` for the 4:5 feed carousel).
- Reference images go inside a `{ role: "user", content: [...] }` message.
- The image is the base64 `result` of the `image_generation_call` output item.
- 429 and 5xx are retried with backoff; 4xx fails at once.

### Consistency test

```bash
# .env: META_API_KEY=LLM|...
npm run studio -- sheet cu-li     # one character
npm run studio -- sheet all       # all four
npm run studio -- sheet all --mock   # offline placeholder images, no key needed
```

For each character this renders a character sheet, then three 4:5 panels chained from it (at the desk, in a meeting, the character's own gag), all without text. Output in `output/characters/<slug>/`: the images, `run.json` (prompts, response ids, token usage) and `review.html`, a contact sheet with a checkbox per signature feature.

## Muse Spark

`MuseSpark.json(name, schema, messages)` calls `POST /chat/completions` (model `muse-spark-1.3`) with `response_format: { type: "json_schema", strict: true }` and returns the parsed object. Messages may carry images (`image_url` with a data URL), which is how self-review sees a panel next to the model sheets. `S.obj/arr/str/...` build strict schemas: every property required, no extras.

## Creating a character

```bash
npm run studio -- character new "một con vượn đen làm thiết kế, luôn đến muộn đúng 5 phút"
npm run studio -- sheet <slug>
npm run studio -- sheet approve <slug>   # copies the sheet to characters/<slug>/model-sheet.png
```

`createCharacter` gives Muse Spark the series bible and the existing cast (names and palettes), so the new character looks clearly different. The draft is completed with the flat style, the four safety never-says rules (unless the draft already covers them) and `status: candidate`, then validated like a hand-written profile. `writeProfile` refuses to overwrite.

## Episodes

```bash
npm run studio -- episode new ep-001 --lead cu-li --with ca-noc --direction "…" --credit "Tên: bình luận"
npm run studio -- episode new ep-001 --lead cu-li --from-listen data/listen/ep-001.json   # direction + credit from `story listen`
npm run studio -- episode run ep-001 [--from step] [--to step] [--mock]
npm run studio -- episode approve ep-001 [--post episodes/ep-001/post.json] [--despite-warnings]   # owner's sign-off; publish checks it
npm run studio -- episode list
```

Steps and files are described in [docs/studio-pipeline.md](../../docs/studio-pipeline.md). The `safety` step after the script stops anything on the banned list before it is drawn, and only an approved episode can be published ([docs/safety.md](../../docs/safety.md)). From code:

```ts
import { createEpisode, openStudio, runEpisode } from "@hoi-sau/studio";
const ctx = openStudio({ mock: true });          // or real clients from META_API_KEY
createEpisode({ id: "ep-001", lead: "cu-li", characters: ["ca-noc"], direction: "…", credits: [] });
await runEpisode(ctx, "ep-001");
```

`mockSparkTransport()` and `mockTransport()` answer offline, so the pipeline and its tests run without a key.
