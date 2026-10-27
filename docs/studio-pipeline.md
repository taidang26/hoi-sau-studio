# Studio pipeline: from a character idea to a lettered episode

This is how Hồi Sau makes a comic the way a small comic studio does, with Meta's Muse models doing each job. Every step saves its output to a file. Any step can be read, edited by hand, or rerun on its own, and nothing upstream changes when it is.

```mermaid
flowchart LR
  style[Series style<br>style.yaml] -->|Muse Image, a person picks| styleref[Locked style reference]
  idea[Character idea] -->|Muse Spark| bible[Character bible<br>profile.yaml]
  bible -->|Muse Image| sheet[Character sheet + pose sheet]
  styleref --> sheet
  sheet -->|human approves| locked[Locked model sheet]
  series[Series bible<br>world, rules, cast, arc, canon] --> premise
  comments[Picked comments] --> premise
  premise[Premise] --> beats[Beats] --> script[Panel script] --> board[Storyboard]
  board -->|Muse Image + style, model and pose sheets| panels[Panels]
  locked --> panels
  panels -->|Muse Spark vision| review{On model?}
  review -->|no: edit only what is wrong| panels
  review -->|yes| letter[SVG lettering]
  letter --> canon[Canon memory]
  canon --> series
```

## How studios do it, and what we copy

Comic and animation studios keep characters consistent across years with three documents. Hồi Sau keeps the same three, as files:

| Studio practice | Hồi Sau file | Used by |
| --- | --- | --- |
| Series bible: world, tone, rules, cast relationships, season arc | `series/bible.yaml` | every writing step |
| Style guide: one look for the whole series, with an approved reference drawing | `series/style.yaml`, `series/style-ref.png` | every drawing step |
| Character bible: personality, voice, things they never do | `characters/<slug>/profile.yaml` | every writing step |
| Model sheet: the approved drawing of the character, turnaround and expressions | `characters/<slug>/model-sheet.png` | every drawing and review step |
| Pose sheet: six approved full-body poses, reused instead of reinvented | `characters/<slug>/pose-sheet.png` | every drawing step |

The writers' room goes premise → beats → script. The board artist goes from script to storyboard. The illustrator draws to the model sheet, and the editor checks each panel against it before the letterer adds text. We run these roles as separate steps for the same reasons a studio separates them: each one is small enough to check, and fixing one never means redoing all of them.

## Keeping a character on-model

Image models drift: an outfit changes colour, a signature prop disappears, the face changes from panel to panel. Hồi Sau has six defences, from strongest to weakest:

1. **One series style, locked by a reference image.** `series/style.yaml` holds the shared style (chibi proportions, thick even outlines, flat warm colours) and four variants. `studio style` draws the same test scene in each; `studio style approve <variant>` keeps one as `series/style-ref.*`. Its text replaces each profile's `look.style` in every prompt, and the image goes with every model sheet and the first panel of every episode.
1. **Locked model sheet and pose sheet as reference images.** `studio sheet <slug>` renders a sheet, then a pose sheet chained from it (standing, typing, slumped on the desk, explaining, shocked, daydreaming). Once a person approves it (`studio sheet approve <slug>`, or the button on the character page), the sheet and the pose sheet go as `input_image`s with the first panel each character appears in.
2. **Chained turns.** Every later panel of an episode passes `previous_response_id`, so Muse Image already has the sheet and the earlier panels in context.
3. **Signature features, palette and one identifying item in every prompt.** Each prompt lists the profile's `signature` features ("keep exactly: …"), the expression the script asks for, and `look.icon`: the one item readers know the character by at thumbnail size (Lolo's mustard hoodie, Poppy's wide teal necktie, Pango's red pen, Uni's headphones), drawn a little oversized. Self-review fails a panel where it is missing.
4. **Self-review with Muse Spark vision.** Each panel is sent with the model sheets and the signature list. Muse Spark returns `pass`, the issues it found, and a one-line edit instruction.
5. **Targeted redraw.** A failed panel is fixed as an edit turn on its own response ("Change only this: … keep everything else"), not redrawn from scratch. The page records the history, and the dashboard shows the before and after.
6. **A style that resists drift.** The style is flat with thick outlines, a few flat colours and simple shapes. The model never draws text; all lettering is a separate SVG layer.

## Steps

| # | Step | Model | Input | Output (`episodes/<id>/`) |
| --- | --- | --- | --- | --- |
| 0 | Character | Muse Spark | one-line idea, series bible, existing cast | `characters/<slug>/profile.yaml` |
| 0b | Model sheet | Muse Image, then a person | profile | `characters/<slug>/model-sheet.png` |
| 1 | Premise | Muse Spark | bible brief, cast brief, direction, credits | `premise.json`: title, logline, setup, twist, hook, cameo |
| 2 | Beats | Muse Spark | premise | `beats.json`: 4–6 beats, each with a purpose (`strip3`: exactly 3, setup, worse, twist) |
| 3 | Panel script | Muse Spark | premise, beats | `script.json`: setting, action, expressions, at most 2 lines of dialogue per panel |
| 4 | Storyboard | Muse Spark | script | `storyboard.json`: shot, angle, composition, staging (left/center/right) |
| 5 | Panels | Muse Image | script, storyboard, model sheets | `panels/panel-N.png`, `panels.json` (prompt, response id) |
| 6 | Review + redraw | Muse Spark vision, Muse Image edit | panels, model sheets | `review.json`, `panels/panel-N-fixK.png` |
| 7 | Lettering | `@hoi-sau/svg-text` | script, storyboard, panels | `final/NN.png`, `final/NN.svg`, `letter.json`; `strip3` also `final/page.png` |
| 8 | Canon | Muse Spark | script | `canon.json`, plus new facts in `series/bible.yaml` and in each profile's `memory.episodes` |

### Formats

An episode is `carousel` (default: 4–6 panels at 4:5, posted as a carousel) or `strip3` (`--format strip3`). A strip3 is the classic three-panel gag: two 4:5 panels on top, the twist drawn wide (3:2) across the bottom, all on one 1080x1350 page that posts as a single image. The writers get the rule of three: set up the trigger, repeat it one step worse, then a twist that reads from the drawing alone.

Every writing step asks Muse Spark for JSON under a strict schema (`response_format: json_schema, strict: true`). After that, the code puts the output back inside the rules: only cast slugs, at most the bible's panel count, two bubbles per panel, and a stage position for every character in the panel. A bad answer cannot break a later step.

Writers see only what they need. That is the story brief from `@hoi-sau/story` (premise, tone, rules, format, the relationships among this episode's cast, the current act of the season plan, how the last episode ended, the story so far, open threads, rested running gags, and 20 canon facts about this cast ranked by relation to the direction) plus the cast brief (personality, voice, never-says, expression names, the last 5 memories), after a short guide to writing a four-beat strip. Characters not in the episode are left out. The `canon` step also recaps the episode into `series/story-memory.json`. See [packages/story](../packages/story/README.md).

## Commands

```bash
# Series style (once)
npm run studio -- style                 # the test scene in each style variant → output/style/review.html
npm run studio -- style approve warm-pastel

# Characters
npm run studio -- character new "một con vượn đen làm thiết kế, luôn đến muộn đúng 5 phút"
npm run studio -- sheet <slug>          # Muse Image character sheet + pose sheet + 3 test panels
npm run studio -- sheet approve <slug>  # lock them as the model sheet and pose sheet

# Episodes
npm run studio -- episode new ep-001 --lead cu-li --with ca-noc \
  --direction "Cu Li nhận việc gấp lúc 4h50 chiều" --credit "Minh Anh: cho Cu Li bị gọi họp lúc 6h sáng"
npm run studio -- episode new ep-002 --lead cu-li --with te-te --format strip3 \
  --direction "Ở nhà thì chán, đi làm thì mệt"
npm run studio -- episode run ep-001                       # every step not yet done
npm run studio -- episode run ep-001 --from storyboard     # redo from the storyboard on
npm run studio -- episode run ep-001 --to script           # stop after the script, to edit it by hand
npm run studio -- episode list

# Add --mock to any of these to run offline with placeholder answers and images.
```

The same actions are in the dashboard (`npm run dashboard`). **Phong cách** draws the four style variants and locks the one you pick. **Nhân vật → Tạo nhân vật** makes a character, **Vẽ sheet** draws its model sheet, pose sheet and test panels in the series style, **Khoá model sheet** locks both sheets, and **Studio** creates an episode from the picked comments (the three-panel strip is the default format; its episode page shows the one-image post). The Studio episode page runs it and shows every step's output, with a "Chạy lại từ đây" (rerun from here) button on each step. `npm run dashboard -- --demo` does all of this on copies in `data-demo/`, with a finished sample episode.

## Cost and limits

A four-panel episode makes 5 Muse Spark writing calls (premise, beats, script, storyboard, canon), 4 Muse Image panels, 4 Muse Spark vision reviews, plus one edit and one extra review per failed panel. At about $0.01 per image, the drawing part of an episode costs under $0.10.

Real runs need `META_API_KEY` in `.env` and network access to `api.meta.ai`. With `MUSE_MOCK=1` or `--mock`, nothing is sent.
