# Short videos

Next to the daily comic, Hồi Sau posts short 9:16 clips at the times in a plan file (two to four a day) on Facebook and Instagram Reels, TikTok, and as a still with a question on Threads. This page shows how a clip is made and posted, and which parts already run without a developer.

## Two kinds of clip

| Kind | What it is | Made with |
| --- | --- | --- |
| **Illustrated voice-over** | An original sound, one full-frame picture per line, two poses per shot, optional moving mouth for whoever is speaking, bubbles in Northern Vietnamese | Dashboard **Video** screen (`talk illustrate`) |
| **Text meme** | A silent scene or two with the joke as large text in two beats (set-up, then the punchline), a small movement between two poses, and instrumental music | Dashboard **Video** screen → "Make a text meme" (`talk meme`) |

Every picture keeps the characters on-model (Tũn in the yellow hoodie and staff badge) and in the Hồi Sau office. A reference clip from another page gives only the idea and the words, never its layout, props or costumes.

## Making an illustrated clip on the dashboard

`npm run dashboard`, then open http://localhost:4321 → **Video**.

1. Pick a sample clip (or upload one) and the lead character. The studio splits it into shots and Muse Spark plans each one; Muse Image draws one picture per shot, then a second pose; SAM 3.1 holds the room still between poses and finds the mouth.
   Lines are cut at pauses and at 3.5 s at most, and a stretch of the sample with no cut longer than 6 s is split at a line start, so one picture is never up for 20 s of talk.
2. Check every shot at full size. To fix something, use **Sửa bằng lời** under the video:
   - Pause on the problem and write it as you would to a person, e.g. "câu đầu là Mẹ không phải Mày" or "Rico quay lưng mà có ghim sao". The paused second, shot and subtitle are attached.
   - Muse Spark reads the note against the plan and small copies of every picture (`talk … --step ask`). It proposes edits: subtitle text or times, a missed line, a bubble, a detail fix, a redraw, a new shot, pose 2, one pose, no mouth.
   - Each edit is shown with its picture and the old → new text. Nothing changes until **Làm**.
   - A detail fix (`--step fix --note … --find …`) edits pose A with Muse Image. SAM finds the named thing in the old and new picture, and only that region, grown and feathered, is pasted back, so the rest stays pixel for pixel. Pose 2 and the mouths are then made again from it. The fix is refused, and the picture left as it was, when the thing is not found in the old picture (a lookalike found only in the edit is never pasted), covers more than 30% of the frame, the edit moved the picture around it (the paste would ghost) or did not change it. Muse Spark then compares the picture before and after: the asked change must be visible and nothing else touched (no ghosted or doubled outlines), or the picture is left as it was.
   - A new shot for a line starts with that line, not at the paused second, and the picture before comes back when the line ends. Pictures never show a real person: a singer or band the words name is drawn as tiny faceless silhouettes.
   - If one edit fails, the others still run and the page says what failed, with **Hoàn tác**. A mouth edit the content filter refuses only costs that picture its talking mouth.
   - After **Làm** the clip is rendered again, and the page shows before/after, a zoom on the change and a map of changed pixels, with **Giữ** or **Hoàn tác**. Undo restores the plan, pictures and renders.
   - The shot bar marks speech with no subtitle (voiced sound not covered by any line, from the last render; silent when music fills the clip) and backgrounds that shift between poses. **Sửa giúp** fills the note.
   - The older per-shot buttons sit under **Sửa tay**: redraw, fix a detail, redraw pose 2, keep one pose, no mouth, edit lines with their times, add a missed line, move or remove a shot, add a shot.
3. Render. Approval needs every shot ticked, a render newer than every picture, and a caption of at most 220 characters. It copies the video and a 4:5 Threads still to the site, approves both posts and deploys.
4. Publish now or at a set time. The dashboard checks its schedule every 30 seconds, so it has to stay open; for posts that must go out while it is closed, use the scheduled tasks below.

## Making a text meme on the dashboard

**Video** → **Make a text meme**:

1. Type the set-up and the punchline, pick the character, one or two scenes and the length (empty by default: the punchline comes once the first line is read, at about 1 s plus 0.28 s a word, and holds about 2.5 s after it is read; or 6–20 s, which moves only the end). `talk meme <slug> --out <dir> --step retime` applies this timing to a clip already drawn, without drawing again. A note per scene is optional; the setting is the Hồi Sau office unless the note says otherwise.
2. Muse Spark turns the words into shots, Muse Image draws each one and a second pose (a blink, a hand moving), SAM 3.1 keeps the background still between them. Every picture gets the same checks and buttons as an illustrated clip.
3. Render: MusicGen makes the music from the prompt on the form (once per prompt), the set-up shows first and the punchline pops in red at scene 2. 1080x1920, 30 fps CFR.
4. Approve and publish as above.

From the terminal the same thing is `talk meme <slug> --out <dir>`, with the words in `<dir>/meme.json` (`top`, `punch`, `scenes`, `music`, `seconds`).

## Checks the dashboard runs for you

- Every picture is checked by Muse Spark after it is drawn (on-model, drawn once, no lettering, things facing the right way) and drawn again on a fail.
- After the second pose is pasted, the dashboard measures how much of the frame's edge changed between the two poses. Above 20% the shot shows a warning that the background moved, with buttons to redraw pose 2 or keep one pose.
- You still tick every shot at full size before rendering.

## Helper scripts

These live in `packages/talk/scripts/` and need Python with OpenCV; MusicGen also needs PyTorch with a GPU.

| Script | Job |
| --- | --- |
| `musicgen.py out.wav <seconds> "<prompt>" [seed]` | Instrumental background music with Meta's MusicGen (`facebook/musicgen-small`, open weights, local) |
| `blink.py in.png out.png x0,y0,x1,y1` | A closed-eye frame drawn onto pose A itself, so only the eyes change |
| `align_pose.py <shots_dir> s01:x0,y0,x1,y1[@dx,dy\|@sift][;...]` | Pastes small regions (a mouth, a hand counting money) of pose B onto pose A under a feathered edge, so the background never jumps |

## Covers and the download page

Approving a clip on the Video screen does both: it makes the cover from the "TikTok cover text" field (for a text meme it defaults to the two lines, punchline in red) and rebuilds the download page. Each clip gets a TikTok cover in one house style: a straight white badge with a black border, 1–2 key words in red, and a "Hồi Sau" tag, inside the TikTok safe zone (`talk cover`). `studio tai` builds https://hoisau.web.app/tai from the approved posts, so the owner can save each clip and cover to a phone and post on TikTok by hand.

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


## From text or pictures

The **Làm từ chữ hoặc ảnh** box at the top of the Video screen takes what the owner would hand to a person: a line of text, up to four pictures (a screenshot of a quote post, a meme picture), or both.

- `talk idea --out <dir>` reads `input.txt` and the pictures in the folder. Muse Spark (vision) returns `idea.json`:
  - every word read from the pictures, verbatim, with page names, avatars and ticks ignored;
  - a recommendation, either a two-beat text clip or a one-panel comic;
  - both versions filled in: lines, scenes in the Hồi Sau office with our cast, comic direction and cast;
  - a title and a caption with `#danvanphong` first, at most 5 tags and no source credit.
- Only the idea and the words are taken from a picture, never its drawing, layout, clothes or props.
- Typed text with no picture is split without losing a word (`splitBeats`).
- The proposal page shows the pictures beside the text read from them. The fields are editable. **Làm clip chữ** creates the text clip, and **Làm tranh 1 khung** creates and starts a one-panel episode in Studio.
- A video step that dies on the network (`fetch failed`, reset, timeout) runs once more before the run stops.

## Kho ý (a stock of ideas from a scrape)

**Video → Kho ý** (`/video/kho`) takes a JSON file of posts scraped from another page (one object per post: `source_id`, `content`, `reactions_count`, `share_count`, `comment_count`, `attachments_detail`).

- Videos are left out (somebody else's footage), and so are politics, the page talking about itself, ads, death, crude words and repeats. Pictures and text posts are kept.
- Ranked by reactions + 5 × shares + 3 × comments, then spread over the days ahead (4 a day by default), with one topic per day where possible. Dated posts (20/10, 8/3, Noel, Trung thu, Tết) wait until a few days before their date.
- Each item is a drop-in of the **Làm từ chữ hoặc ảnh** box (`data/video/_ideas/y-k-0001/`). Pictures download right away, because scraped links stop working after a few days. A text post is the joke itself; a picture's caption is only a teaser, so the picture is read alone.
- **Cho máy đọc** runs `talk idea --kind meme` for the next days: Muse Spark reads the words exactly and proposes a two-beat text clip with our cast in our office. Nothing is made until the owner opens the proposal and presses the button. Captions never name the page.
- **Bỏ** drops an item; adding the same file again adds only new posts.
- **Làm clip cả tuần tới** makes the week in one batch: every proposal of the next 7 days becomes a text clip (plan, draw, second poses, render), 3 at a time. The owner reviews and approves the whole week once on the Video screen; nothing is approved or posted by the batch. Each stock item links to its clip.

## Kho phản ứng (ready-made reactions)

`talk stock <slug|all>` draws 12 reactions per character once (đơ mặt, ôm đầu, gục bàn, cười gượng, trốn sau màn hình, há hốc, ngửa ghế, đếm tiền lẻ, gật gù, khóc ròng, ăn mừng, lau mồ hôi): full-frame office pictures in the meme layout, with a second pose on the same background, through the usual draw, poses and stabilize checks. They land in `characters/<slug>/stock/` with `sheet.jpg` for the owner and start unapproved.

- `talk stock <slug> --approve guc-ban,om-dau` (or `all`), `--unapprove`, `--only <names>` to draw again (which takes the approval back), `--list`.
- When planning a two-scene meme, Muse Spark is offered the approved reactions of the lead and may take one for the punchline scene. That scene is then copied in, not drawn, so the meme costs about half. A reaction rests 5 days after a use.

## Thư viện nhạc (music library)

`talk music-lib [--count 4]` makes 4 tracks per mood once with MusicGen (vui nhộn, chán, hí hửng, deadline, buồn cười ra nước mắt), 22 s each, in `series/music/`. A meme's music step then copies the least used track of its mood instead of running MusicGen for every clip; with no library, or a clip longer than a track, it makes its own as before.

## Bộ mồm (ready-made mouths)

`talk mouthkit <slug|all>` draws each character's mouths once: a big portrait facing front and one turned three-quarters, then six shapes on each (shut, open, wide, o, smile, teeth, laugh, cry, pout, angry, shout; a kit made earlier only draws the new ones), cut out by SAM 3.1 into `characters/<slug>/mouthkit/` with a `sheet.jpg` to look over (about 0.12 USD a character). `--only side` redraws one angle; `--sheet` only rebuilds the sheet.

From then on the `mouths` step of a lip-sync clip keeps the picture as drawn for the shut frame (its own expression) and pastes the kit's open mouth for the open frame, picked by the shot's mood (cry for a sad face, shout or angry for an angry one, laugh for a happy one, else wide, open, teeth) instead of asking Muse Image for two edits. Only on the lead's own face (the mouth on the SAM mask of its species, and the skin round it close to the kit portrait's), never over anything off the lead such as a cup held at the mouth. It erases the drawn mouth with the skin around it, moves the open mouth down while it touches the nose, picks the angle from where the nose sits (mirrored for a face turned the other way), scales to the mouth's width and runs the same checks as before (open clearly bigger, clear of the nose and eyes, the Muse Spark face close-up). A face too small for the kit, or a pair that fails, is drawn the old way. `--no-kit` skips the kit for a run; `mouths.json` marks the pictures that came from it.

## Đồ làm sẵn (dashboard /video/san)

One screen for everything drawn once and reused: each character's reactions (Duyệt / Vẽ lại per picture, Duyệt hết, and "Làm mắt chớp + mồm nói", which runs `talk stock <slug> --extras` so a reaction comes with its blink and talking mouths), the mouth kit sheet, the seasonal outfits, and the office rooms. Redrawn pictures wait for approval again.

Each folder notes the design it was drawn for (`design.json`: a fingerprint of the profile's look and the model sheet). When the character is redesigned the page says so, and `talk stock` / `talk mouthkit` redraw everything on their next run.

- **Phông** (`talk backgrounds [--approve all]`): ten empty rooms in `series/backgrounds`: six in the office (bàn làm việc, phòng sếp, phòng họp, pantry, thang máy, cửa chấm công) and four outside for jokes that need them (phòng trọ, nhà tắm, quán trà đá, đường phố). A scene whose act happens in an approved room gets it as the last Muse Image reference, so the room looks the same in every clip.
- **Âm thanh hiệu ứng** (`talk sfx`): twelve short sounds made once with AudioGen (Meta AudioCraft, `pip install audiocraft` in the `TALK_PYTHON` environment) in `series/sfx`. Muse Spark may pick one for the punchline of a meme; it is mixed over the music when the punchline appears.
- **Đồ theo dịp** (`talk seasons <slug|all>`): each character once in the outfit of Tết, Noel, Trung thu, 20/10, 8/3 and 14/2 (`characters/<slug>/seasons`). A meme for an occasion (the idea stock tags them) dresses the lead from that picture and takes no everyday reaction.
- **Mắt**: every picture without a second pose already gets a shut-eye copy for blinks, on the machine and free. Side glances and wide eyes are part of the expression and come with the drawing.

Reactions are 22: fifteen alone and seven more everyday ones (lướt điện thoại, chạy deadline, ngủ gật, chạy trễ, nộp đơn nghỉ, ví rỗng, ngồi họp), plus three with a second character (sếp giao việc, sếp mắng with the director; hóng chuyện with a colleague), which keep that character in the meme. `talk stock <slug> --poses` tries the second pose again for reactions that have only one picture.

The Kho ý page takes the Meta credit read off Billing; from then on "Làm clip cả tuần tới" estimates about 0.15 USD a meme and stops before the last 18 USD, which stay for lip-sync clips.

## Âm thanh meme (the house mix)

Every meme gets the mix Tài approved on clips meme-25..34 (7/11). The planner (Muse Spark) picks it with the shots, and `talk meme --step render` mixes it:

- **Music:** the meme's mood from `series/music`. Envato tracks (`<mood>-env<n>.wav`) come before MusicGen ones. Envato-only moods: cang-thang, cam-dong, hanh-dong, lang-man.
- **At the punchline:** one cut sound. Use `dia-xuoc` when the mood flips, `vine-boom` for a reveal, and a whoosh at -0.25 s before a cartoon reaction.
- **After the punchline:** 1–2 reaction sounds, from +0.1 to +2.8 s: sad-violin, bruh/huh, a laugh, ba-dum-tss or applause.
- **Music turn:** for a letdown punchline the music stops at the cut (`turn: stop`) or switches to another mood (`turn: switch`, `musicB`).
- **Where a sound name is looked up, in order:**
  1. `series/sfx/_meme/<name>.*` (internet meme sounds, cut to 3 s)
  2. `series/sfx/_lib/<name>-env.*` (Envato)
  3. `_lib/<name>-fs.*` (Freesound)
  4. `series/sfx/<name>.wav` (AudioGen, the fallback)
- **Levels:**
  - Music A runs at -21 LUFS with a 0.2 s fade-in. It is cut at cut-0.05 s, or faded over the last 1.2 s.
  - Music B starts at cut+0.35 s at -22 LUFS.
  - Each sound runs at -15 LUFS with its own volume.
  - Then amix without normalising, and a 0.7 limiter.

For a meme already drawn, `talk meme <slug> --out <dir> --step sound` plans only the sound (it writes `plan.sound`), and `--step render` mixes it. The rule is also in `series/house-rules.json` (r-sound-1107), so the idea and fix prompts see it too.
