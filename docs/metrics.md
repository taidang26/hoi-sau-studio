# Metrics

How Hồi Sau is measured during the hackathon, and the results. The results tables are filled from real Page, Instagram and Threads data on 3 Nov; until then they show the plan.

## What we want to learn

1. **Does the loop work?** Does a comment really become the next episode, every day, without a person rewriting it?
2. **Does the audience care?** Do people share, save and comment, not just scroll past?
3. **Which character wins?** Of Lolo, Poppy, Pango and Uni, which one earns the most engagement per person reached?
4. **Is it cheap and safe enough to run daily?** Cost and time per episode, and how often the self-review catches a bad panel.

Likes are recorded but never decide anything: they are the cheapest signal and the most inflated by ads.

## The episode score (already in the code)

The coach (`npm run story -- coach`, [packages/story](../packages/story/README.md)) scores every episode published at least 24 hours ago, across all its posts:

```
score = 2·comments + 4·distinct commenters + 1·replies + 1·reactions + 6·shares + 5·saves
```

Comments count only after the spam and toxicity screen, and comments from our own accounts never count. Distinct commenters weigh most because they are the people writing the next episode. Shares, saves and reach come from `data/insights.json` (`[{ postId, reactions, shares, saves, reach }]`). The same score feeds the coach's do/avoid/test lessons, which go back into the writer brief.

## Rates for the write-up

The score compares our own episodes. For the submission we also report rates per reach, which compare across characters and platforms:

| Metric | Formula | Why |
| --- | --- | --- |
| Share rate | shares / reach | People share what they relate to; the strongest signal for office comedy |
| Save rate | saves / reach (Instagram) | Intent to come back |
| Comment rate | screened comments / reach | Input for the loop |
| Idea rate | comments scored `idea` / screened comments | Whether the audience is actually co-writing |
| Return rate | commenters on episode N who also commented earlier / commenters on N | Whether a series audience is forming |

Reach is the platform's unique-account reach. Boosted and organic reach are reported separately when a boost is used.

## Loop health (per episode)

| Metric | Source |
| --- | --- |
| Direction came from comments, editor pick, or season plan | `data/listen/<episode>.json` (`pick`) |
| Comments in, rejected by reason, clusters formed | `data/listen/<episode>.json` |
| Hours from publish to the next episode's direction | publish journal + listen report timestamps |
| Panels drawn, panels failed review, edits per panel, most common reason | `episodes/<id>/review.json` |
| Episodes published without a person editing the script or panels | episode files vs. hand edits |

## Cost and time (per episode)

| Metric | Source |
| --- | --- |
| Muse Image calls and cost (about $0.01 per image) | `episodes/<id>/panels.json` usage |
| Muse Spark and Muse Spark Open tokens | step outputs |
| Wall-clock time of a full run, per step | run log |

## Character test

Run on the same day with the same direction for all four characters:

- Same beats, same panel count, same posting hour, same caption structure.
- The same small ad budget per character if organic reach is too low to compare (a new Page has almost none), with the same audience and hours.
- Winner: highest share rate + comment rate per reach after 48 hours. A gap smaller than the spread between two posts of the same character is a tie.

During the contest only Hồi Sau and Lolo's own channels are live, so the test runs on the Hồi Sau channel, where all four appear.

## Collecting insights

To add: a `channel insights` command that writes `data/insights.json` once a day.

- Facebook: post fields `shares`, `comments.summary(true)`, `reactions.summary(true)`, plus post insights for reach (check the metric names against the Graph API version in use: Meta has been renaming Page reach metrics).
- Instagram: media insights `reach`, `saved`, `shares`, `comments`, `likes`, `total_interactions`, and `views` for Reels.
- Threads: thread insights `views`, `likes`, `replies`, `reposts`, `quotes`, `shares`.

Until it exists, the numbers can be typed into `data/insights.json` by hand from Meta Business Suite; the coach and the dashboard read the same file.

## Results

*To be filled on 3 Nov 2026.*

### Episodes

| # | Date | Lead | Direction from | Reach (FB / IG / Threads) | Score | Share rate | Save rate | Comment rate | Idea rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | | | Season plan | | | | | | |
| 2 | | | Comments on #1 | | | | | | |

### Character test

| Character | Reach | Share rate | Comment rate | Save rate | Verdict |
| --- | --- | --- | --- | --- | --- |
| Lolo (slow loris) | | | | | |
| Poppy (pufferfish) | | | | | |
| Pango (pangolin) | | | | | |
| Uni (saola) | | | | | |

### Loop and cost

| | Value |
| --- | --- |
| Episodes published | |
| Episodes whose direction came from comments | |
| Panels drawn / failed review / edited | |
| Most common review failure | |
| Average cost per episode (USD) | |
| Average run time | |

### What we learned

*Three or four sentences, written on 3 Nov, including the coach's top lessons.*
