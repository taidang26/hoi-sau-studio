# Submission draft

Draft answers for the hackathon submission form, kept in the repo so they stay in sync with the code. Final numbers come from [metrics.md](metrics.md) on 3 Nov. Fields in *italics* are placeholders.

**Project name:** Hồi Sau

**Track:** Indie Developer · theme *Build for Your World*

**Tagline:** An AI comic studio that runs original characters as a daily office comedy, where the audience's comments write the next episode.

**Repository:** https://github.com/taidang26/hoi-sau-studio

**Demo video:** *link*

**Live series:** https://www.facebook.com/profile.php?id=61595845893958 · *Instagram* · *Threads* · *Lolo's Page*

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

Four characters, a slow loris, a pufferfish, a pangolin and a saola, run the same story on the same day, and the audience's share and comment rates decide who leads.

**Results.** *In [N] days the studio published [N] episodes; [N] were directed by audience comments. Share rate [X]%, comment rate [X]%. The review caught [N] bad panels out of [N]. Average cost per episode: $[X]. [Winner] led the character test. Top coach lesson: [lesson].*

**Why it matters.** The same loop can run any creator's character or a brand's mascot: a consistent look, a consistent personality, a story that keeps going, and an audience with a reason to come back tomorrow.

## How we used Meta's tools

| Tool | Role |
| --- | --- |
| Muse Spark | Character bibles, premise, beats, panel script, storyboard, canon, recap, coach lessons (strict JSON) |
| Muse Spark vision | Panel review against the model sheets |
| Muse Image | Model sheets, panels, edit-only redraws via chained turns |
| Muse Spark Open | Scoring and grouping comments at volume (open weights) |
| Facebook Pages API, Instagram Graph API, Threads API | Publishing per brand, comments, insights |
| Messenger Platform | Inbox for Page and Instagram messages |

Details: [docs/meta-tools.md](meta-tools.md).

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

Every commit in the repository is from after kickoff (26 Oct 2026, 23:24 Hanoi time). Planning notes made before kickoff are declared in the README under "Pre-existing work"; no earlier product, library or codebase is used.
