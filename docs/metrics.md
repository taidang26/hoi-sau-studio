# Metrics

How Hồi Sau is measured during the hackathon, and the results. The results below are real Page, Instagram and Threads data from the first week.

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

Comments count only after the spam and toxicity screen, and comments from our own accounts never count. Distinct commenters weigh most because they are the people writing the next episode. Shares, saves and reach come from `data/insights.json`, written by `npm run channel -- insights` (below). The same score feeds the coach's do/avoid/test lessons, which go back into the writer brief.

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

`npm run channel -- insights` writes `data/insights.json` for every published post of every brand; run it once a day, after `comments`. The coach and the dashboard read the same file.

| Platform | Fields | From |
| --- | --- | --- |
| Facebook | shares, reactions, comments, reach | post fields `shares`, `reactions.summary`, `comments.summary`; reach from post insights, `post_total_media_view_unique` then `post_impressions_unique` (or `FB_REACH_METRIC`) |
| Instagram | reach, likes → reactions, comments, shares, saved → saves, views (Reels) | media insights |
| Threads | views, likes → reactions, replies → comments, shares + reposts + quotes → shares | thread insights; no reach |

A number Meta does not give is left out and listed under `missing` for that post, so a gap is visible rather than counted as zero. Rates per reach on Threads use views instead of reach, and are reported separately.

## Results

Read from the dashboard's **Hiệu suất** page and overview on 4 Nov 2026, about 11:00 Hanoi, after `channel insights`. All numbers are organic: no ads were run.

### What was published

| | Value |
| --- | --- |
| Episodes made in the studio | 28 |
| Short clips posted on Facebook, Instagram and Threads | 21, all with numbers |
| Views, all clips, all three platforms | 2,098 |
| Engagements (likes, comments, shares, saves) | 21 |
| Best posting hour | 14:00 (310 average views, one clip) |
| Top clips | Clip 10, 199 views (Instagram 196, Threads 3); Clip 9, 84 views |

### Loop health

| | Value |
| --- | --- |
| Comments received | 0 |
| Episodes whose direction came from comments | 0: every direction was set by us |
| Review catch shown in the demo | Episode 3: Muse Spark flagged Lolo's hoodie sleeve as too short, and only that detail was redrawn |

The Pages were a week old, so no audience had formed to comment yet. The comment loop is built and wired end to end (screen, score, cluster, pick, credit), and the demo video shows it running on the real model with a set of sample comments, labelled as such.

### Not measured yet

Share, save and comment rates per reach, the character test and the cost per episode need more reach than one organic week gives. They are reported once there is enough reach; with zero comments, the coach has no lessons yet.
