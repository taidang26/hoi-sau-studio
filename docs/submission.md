# Submission draft

Draft answers for the hackathon submission form, kept in the repo so they stay in sync with the code. Final numbers come from [metrics.md](metrics.md) on 3 Nov. Fields in *italics* are placeholders.

Deadline: **4 Nov, 9 PM ET = 5 Nov, 09:00 Hanoi**. Late entries are not considered; our own target is 4 Nov, 18:00 Hanoi. One person submits for the team through the [submission platform](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit). Judges look at the video, the code **and the live product**.

**Project name:** Hồi Sau

**Track:** Indie Developer · theme *Build for Your World*

**Tagline:** An AI comic studio that runs original characters as a daily office comedy, where the audience's comments write the next episode.

**Contributors:** *full name as on the hackathon application* (GitHub [taidang26](https://github.com/taidang26)), solo. Every contributor must be an approved participant and be named here.

**Repository (public):** https://github.com/taidang26/hoi-sau-studio

**Demo video (3 min, public or unlisted):** *link*

**Live product:**
- The series, live: [Facebook](https://www.facebook.com/profile.php?id=61595845893958) · [Instagram @hoisau.comic](https://www.instagram.com/hoisau.comic/) · [Threads @hoisau.comic](https://www.threads.net/@hoisau.comic)
- Episode site: https://hoisau.dangtrantai.com
- *The studio dashboard, for judges: a public read-only copy running `npm run dashboard -- --demo`, or a link to the recorded walkthrough if it stays local (decide by 2 Nov)*

**X post for Most Viral:** *link to the demo post on X (engagement counts through 8 Nov end of day ET)*

## The form, field by field

In the order the submission form asks (seen 28 Oct). Paste these as they are; *italics* are still open.

| Field | Answer |
| --- | --- |
| Team Name | Hồi Sau |
| Team Members | Tai Dang Tran (solo). *Remove anyone listed who did not build this: the rules require exactly the people who worked on it.* |
| Track | Indie Developer |
| Problem statement | Build for Your World |
| Most Viral X post | *link to the demo post on X* |
| Project Description | The short description below, then "The problem" and "What we built" from the full description |
| Public GitHub Repository | https://github.com/taidang26/hoi-sau-studio |
| 3-Minute Demo Video | *YouTube link, public or unlisted* |
| Use of Meta products | "How we used Meta's tools" below, as text |
| Why Meta's models matter | The paragraph under "Why Meta's models matter" below |
| Feedback on Meta products | The list under "Feedback on Meta products" below |
| Feedback on partner technologies | The line under "Feedback on partner technologies" below |

The form has no checkbox for the bonus awards other than the X link. *Check whether the Track field accepts more than one choice (for example Indie plus a bonus award). If it does not, name the bonus awards at the end of the Project Description.*

## Short description (about 50 words)

Hồi Sau runs original AI characters as a daily office-comedy comic for young Vietnamese workers. Meta's Muse models write, draw and check each episode; it is posted to Facebook, Instagram and Threads; the comments are screened, scored and grouped, and the best idea becomes the next episode, with its author written in as a coworker.

## Full description

**The problem.** Young office workers in Vietnam share relatable workplace jokes every day, and a recurring character is the format that builds a following. But a character that posts daily is a full-time job by hand, and since July 2025 YouTube and Meta demonetize mass-produced, unoriginal AI content. Creators are stuck between burning out and being flagged as AI slop.

**What we built.** Hồi Sau is a small comic studio on Meta's models, running one loop a day:

1. **Writers' room.** Muse Spark writes premise, beats, panel script and storyboard as strict JSON, against a series bible (world, rules, a five-act season plan) and story memory (what happened, open threads, running gags and when they were last used), and against the bibles of the characters in the episode: want, fear, contradiction, voice, the things they never say.
2. **Drawing.** Muse Image draws each panel with no text, using each character's locked model sheet as a reference and chaining every panel from the last, so the characters stay on-model.
3. **Review.** Muse Spark vision checks each panel against the model sheets and signature features. A failed panel is fixed as an edit turn that changes only what is wrong.
4. **Lettering.** Vietnamese dialogue is fitted into the bubbles as an SVG layer with a real font, because image models mangle Vietnamese diacritics.
5. **Publishing.** Each episode goes to the Hồi Sau Page, Instagram and Threads, and to the lead character's own brand, through Meta's official APIs, with a journal that prevents double posting.
6. **Listening.** Comments come back. A rule screen drops spam and abuse; Muse Spark Open scores the rest for idea, fit and fun; ideas wanted by many different people win; an editor can override. The commenter is credited and drawn into the next episode as a coworker, from words only.
7. **Coaching.** The coach compares strong and weak episodes and writes do/avoid/test lessons that go back into the writer brief and the comment scoring.

Six Vietnamese animals share the office: a slow loris, a pufferfish, a pangolin, a saola, the binturong director and a ferret-badger rival. The audience's share and comment rates decide who leads. A safety gate checks every script against one banned-topic list and each character's limits before anything is drawn, comments can never instruct the model, and nothing is posted until the owner approves the exact files.

**Results.** *In [N] days the studio published [N] episodes; [N] were directed by audience comments. Share rate [X]%, comment rate [X]%. The review caught [N] bad panels out of [N]. Average cost per episode: $[X]. [Winner] led the character test. Top coach lesson: [lesson].*

**Why it matters.** The same loop can run any creator's character or a brand's mascot: a consistent look, a consistent personality, a story that keeps going, and an audience with a reason to come back tomorrow.

## How we used Meta's tools

| Tool | Role |
| --- | --- |
| Muse Spark | Character bibles, premise, beats, panel script, storyboard, the script safety gate, canon, recap, coach lessons, character replies (strict JSON) |
| Muse Spark vision | Panel review against the model sheets; reading reference images into reusable recipes |
| Muse Image | Series style, model and pose sheets, brand art, every panel, edit-only redraws via chained turns |
| Muse Spark Open | Scoring and grouping comments at volume (open weights) |
| Muse Voice Transcribe, SAM 3.1 | Talking-character videos: word timing for captions and lip-sync, mouth and eye regions |
| Facebook Pages API, Instagram Graph API, Threads API | Publishing per brand, comments, replies, insights |
| Messenger Platform | Inbox for Page and Instagram messages |

Details: [docs/meta-tools.md](meta-tools.md).

## Why Meta's models matter

The product is consistency: the same characters, the same look and the same voice every day, or the audience stops following. Muse Image's chained turns and reference images keep a character on-model from panel to panel, and an edit turn fixes one detail without redrawing the rest. Muse Spark's strict JSON schemas let every writing step be checked and clamped to the series rules in code, and its vision lets the same model review the drawing against the model sheet. Muse Spark Open lets comment scoring grow with the audience on open weights. Facebook, Instagram and Threads are where young Vietnamese office workers already are, so the loop from post to comment to the next episode runs entirely inside Meta.

## Feedback on Meta products

- Muse Image accepts only three sizes (1024x1024, 1536x1024, 1024x1536) and returns WebP by default. A 4:5 size for feed posts and a documented output format would save a crop and a conversion.
- The `size` parameter only picks the aspect ratio; the image comes back at about 2.5 MP. Saying so in the docs would have saved us a day of soft-looking art.
- The content filter sometimes refuses harmless exaggerated cartoon poses on a pose sheet. A reason code with the refusal would let us rephrase precisely instead of retrying blind.
- Chained turns (`previous_response_id`) are the best tool we found for character consistency. Longer retention of old responses would help long series.
- The Graph API is moving Page reach from impressions to "views" metrics. A clear mapping table would help.
- *Muse Voice Transcribe: add once a real call has been made.*

## Feedback on partner technologies

*Fill in after the first real run on Baseten or Modal (Muse Spark Open for comment scoring). If none ran, write: "Not used: we applied for Baseten and Modal credits; until hosting was set, listening ran on Muse Spark through the Meta Model API."*

## Technical highlights

- A studio-style pipeline (series bible, character bible, locked model sheet; premise → beats → script → storyboard → panels → review → lettering → canon) with strict JSON at every step, clamped to the bible's rules in code, and every step rerunnable on its own.
- Character consistency from a locked model sheet as reference plus chained Muse Image turns, with a vision review and edit-only fixes.
- A Vietnamese text layer with real font metrics, syllable-aware line breaks and ellipse-aware bubbles.
- Listening that works on Vietnamese with and without diacritics, ranks ideas by how many different people want them, and never lets our own accounts vote.
- A coach that closes the loop: measured results become lessons for the writer.
- Every external API has a mock, so the whole loop is tested offline.

## Challenges

- *Keeping characters on-model across panels: what failed first, what fixed it.*
- Vietnamese diacritics in image models, solved by never letting the model draw text.
- A brand-new Page has almost no organic reach, so the character test needed equal small ad budgets to be fair.

## What's next

A hosted version where creators bring their own character and API key, more channels (TikTok, YouTube Shorts), and a B2B mode that runs brand mascots on the same studio.

## Built during the hackathon

Every commit in the repository is from after kickoff (26 Oct 2026, 23:24 Hanoi time). Planning notes made before kickoff are declared in the README under "Pre-existing work"; no earlier product, library or codebase is used. The video opens with the same statement in one line.

## Bonus awards we qualify for

| Award | Why Hồi Sau fits | What the submission must show |
| --- | --- | --- |
| Best Build on Meta Open Weight Models ($10k) | Comment listening runs on Muse Spark Open (`meta-models/muse-spark-open-1026` on Baseten) | A real listen run on Baseten, not the Muse Spark fallback; say so in the video |
| Best Creative Build ($5k) | Muse Image draws an original comic against locked model sheets | Model sheets and finished episodes |
| Best Agentic Use-Case ($5k) | The daily loop runs on its own: listen, write, draw, review, letter, publish, coach | One unattended run, with the review catching a panel |
| Most Viral ($20k) | The series is made to be shared | The demo posted on X, link submitted; engagement counts through 8 Nov |
| Community Vote ($10k) | Voting opens 9 Nov, one vote per verified account | Share the project page with our audience on 9 Nov |

## Before pressing Submit

- [ ] Repository is public and its README links work.
- [ ] Video plays logged out, is under 3:00 and opens with the pre-existing/built-this-week line.
- [ ] Every live link opens logged out: Facebook, Instagram, Threads, episode site, dashboard copy.
- [ ] Team Members lists only the people who built this.
- [ ] Results and numbers from [metrics.md](metrics.md) filled in above.
- [ ] X post is up and its link is in the form.
- [ ] The bonus awards above are chosen in the form, or named in the Project Description if the form has no field for them.
