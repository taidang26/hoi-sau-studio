# Demo video script (3:00)

Goal: in three minutes, a judge sees a real comment turn into a real published episode, and understands which Meta model did what. The video is one of the main judging inputs, next to the code and the running product.

Format: 1920×1080 screen recording with an English voice-over. Comic panels stay in Vietnamese with English subtitles burned in. Record at normal speed and cut; do not speed up the UI. Target 2:50 to leave a margin.

## Shot list

| Time | On screen | Voice-over |
| --- | --- | --- |
| **0:00–0:05** What is new | Title card: "Everything here was built 26 Oct – 4 Nov. Before kickoff: planning notes; no earlier code is used." | "Everything you'll see was built during the hackathon. Before kickoff we had planning notes; no earlier code is used." |
| **0:05–0:15** Hook | A real published episode on the Hồi Sau Page, scrolled panel by panel. Last panel ends on a question to the audience | "This office-comedy episode was written, drawn, lettered and posted by an AI studio. And yesterday's comments decided what happens in it." |
| **0:15–0:30** Problem | Two cards: "Daily characters win on Facebook" / "Mass-produced AI content gets demonetized (YouTube and Meta, July 2025)" | "Young office workers in Vietnam share workplace jokes every day. Creators want a character that posts daily, but by hand that's a full-time job, and bulk AI content now gets demonetized. Hồi Sau runs original characters with a story that keeps moving, co-written by the audience." |
| **0:30–0:45** Meet the team | Dashboard cast cards: Lolo, Poppy, Pango, Uni. Then one `profile.yaml`: want, fear, contradiction, signature, never-says | "Four characters in one team. Each has a want, a fear and a body-based comic engine, plus the features that must never drift and the things they never say. The audience's numbers decide who leads." |
| **0:45–1:05** The studio | README diagram, each step lighting up with its model | "Muse Spark works like a writers' room: premise, beats, panel script, storyboard, all from the series bible and story memory. Muse Image draws against each character's locked model sheet. Muse Spark vision checks every panel and sends off-model ones back for a one-detail edit." |
| **1:05–1:30** Comments in | Dashboard › Comments: real comments, some rejected with a reason, idea clusters, one picked; a corner label "Muse Spark Open on Baseten" | "Here are yesterday's real comments. A rule screen drops spam and abuse. Muse Spark Open, Meta's open-weight model running on Baseten, scores the rest: is it an idea, is it in character, is it funny. Ideas many different people want rise to the top. The commenter gets written in as a coworker, drawn from words, never from their photo." |
| **1:30–2:05** Episode made | Dashboard › Studio episode page: steps filling in; a panel failing review with its reason next to the edited panel; empty bubbles, then the Vietnamese text dropping in | "The script knows the story so far, so last week's running gag comes back. Here the reviewer catches a wrong detail, and only that detail is edited. Image models mangle Vietnamese accents, so the model never draws text: we fit the dialogue as an SVG layer with a real font." |
| **2:05–2:25** Published | `channel publish` output, then the episode live on Facebook, Instagram and Threads; Lolo's own Page; the commenter's name in the caption | "One command posts to Hồi Sau and to the lead character's own brand, with a journal so nothing posts twice. And here's the commenter, now in the story." |
| **2:25–2:45** Results | Dashboard overview with real numbers and the coach's lessons | "Over the week: [N] episodes, [N] of them directed by comments, a share rate of [X]%. The coach compares strong and weak episodes and feeds what worked back to the writer: [one lesson]." |
| **2:45–3:00** Close | Repo page, the live links (Facebook, Instagram, Threads, episode site), then the series logo | "Built during the hackathon on Muse Spark, Muse Image, Muse Spark Open and Meta's platform APIs. Want to know what happens next? Hồi sau sẽ rõ: find out in the next chapter." |

Fill the bracketed numbers from [metrics.md](metrics.md) on 3 Nov.

## What to capture before 4 Nov

- [ ] One full episode run on real models, including a panel that fails review and its edit (keep `review.json` as proof).
- [ ] The episode live on Facebook, Instagram and Threads, and on Lolo's channels, recorded in a phone-sized window.
- [ ] Dashboard: comments with rejected and clustered ones, a direction being picked, the Studio episode page, the overview with real numbers.
- [ ] The four locked model sheets as one image.
- [ ] The README diagram exported as a slide with each step's model labelled.

## Rules for the video

- The first line says what existed before and what was built this week, as the organisers ask. Keep it in line with "Pre-existing work" in the README: planning notes, and an early scaffold and publisher prototype in another repository that were rewritten from scratch and are not used.
- Upload as public or unlisted and check it plays logged out. Post the same video on X for Most Viral.

- Judges stop watching at 3:00 sharp, so the cut ends by 2:55.
- Show the product running for real (real Muse calls, real posts on our Pages), not the offline mock, and name the Meta model on screen at each step where it is used.
- English throughout: English voice-over plus English subtitles, including over every Vietnamese panel.
- No Meta mascot images and no "Muse" in our own names, logos or characters; Meta model names appear only as the tools we used.
- Show only work from this repository, built after kickoff. Do not show earlier products.
- No client names, no real people's faces. Show commenter names only if they are public on the Page; blur otherwise.
- Say plainly that the Meta app runs in Development mode on our own Pages.
- Music: royalty-free, credited in the description.
