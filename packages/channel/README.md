# @hoi-sau/channel

Gets each episode in front of people and brings their comments back.

- **Publish** an episode to Facebook, Instagram, Threads and TikTok, for the main Hồi Sau brand and for the brand of the character who leads it (`channels.yaml`).
- **Comments**: pull comments and Threads replies of every published episode into `data/comments.json` for the listening step in `packages/story`.
- **Insights**: reach, reactions, shares, saves and views of every published post into `data/insights.json`, which the coach in `packages/story` and the dashboard read.
- **Talking back**: send the character comments a person approved.
- **Inbox**: Messenger and Instagram direct messages, answered within Meta's 24-hour window.

The Meta app runs in **Development mode**. The Pages and accounts belong to the developer, who is an Admin of the app, so App Review is not needed. Background and pitfalls: [docs/meta-integration-notes.md](../../docs/meta-integration-notes.md).

## Connect the accounts (once per brand)

Facebook and Instagram:

1. Create the Facebook Page and an Instagram professional account (Creator or Business) linked to it.
2. Create one Meta app at developers.facebook.com with the use cases for Pages, Instagram, Messenger and Threads, and put `META_APP_ID` and `META_APP_SECRET` in `.env` (start from `.env.example`). Add every permission below to its use case before logging in; a permission the use cases do not list makes the login dialog fail with "Invalid Scopes".
3. `npm run channel -- login` opens Facebook Login in the browser. Approve the Page (and its Instagram); a one-shot server on `localhost:8765` catches the redirect, and the same steps as `setup` run, so no token is copied by hand. Localhost redirects work without registering them while the app is in Development mode. If the app uses Facebook Login for Business, put its configuration id in `META_LOGIN_CONFIG_ID`. While the Page has no Instagram account yet, set `META_LOGIN_SCOPES` to just the `pages_*` and `read_insights` scopes so Facebook does not ask you to pick an unrelated Instagram account.

   Or by hand: in [Graph API Explorer](https://developers.facebook.com/tools/explorer/), choose the app, tick the permissions below and generate a user token:
   `pages_show_list pages_read_engagement pages_read_user_content pages_manage_posts instagram_basic instagram_content_publish instagram_manage_comments pages_manage_engagement read_insights instagram_manage_insights pages_messaging instagram_manage_messages` (plus `business_management` if the Page lives in a Business Portfolio and does not appear).
4. `npm run channel -- setup <token>` swaps it for a long-lived token, finds the Page and its Instagram account, and writes their ids and the Page token to `.env`.
5. `npm run channel -- check` confirms the token works and nothing is missing.

Threads (separate login, token lasts about 60 days):

1. Open Threads with the brand's Instagram account to create the profile.
2. In the app dashboard add the **Access the Threads API** use case with `threads_basic`, `threads_content_publish`, `threads_read_replies`, `threads_manage_insights`; copy its app secret into `.env` as `THREADS_APP_SECRET`.
3. Invite the profile as a Threads tester and accept in the Threads app (Settings › Account › Website permissions › Invites).
4. Generate a token in the use case's User Token Generator and click Copy next to it, then run `npm run channel -- threads-setup` (it reads the token from the clipboard, so it is never pasted into a terminal; passing it as an argument also works).
5. `check` shows the days left; `threads-refresh` extends it.

TikTok (its own app at developers.tiktok.com, not Meta):

1. At [developers.tiktok.com](https://developers.tiktok.com/apps) create an app (type Web). Website, Terms and Privacy: `https://hoisau.web.app`, `/terms`, `/privacy`.
2. Add the products **Login Kit** and **Content Posting API**. Scopes: `user.info.basic`, `video.upload` (plus `video.publish` for direct mode). Register the redirect URI `https://hoisau.web.app/tiktok-callback`: TikTok only redirects to HTTPS, and that page forwards the code to the login waiting on localhost (the port rides in the state).
3. Until TikTok reviews the app, use its **Sandbox** and add the brand's TikTok account as a target user.
4. Put `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` in `.env` (or the dashboard's Settings), then `npm run channel -- tiktok-login` (or **Kết nối TikTok** on the Kênh page). The access token lasts 24 hours and renews itself from the 365-day refresh token before each upload.

`mode` in `channels.yaml` picks how videos go out:

- `draft` (default): the video lands in the TikTok inbox and the owner adds caption and trending sound in the app, then posts. Works before TikTok's audit. TikTok holds at most 5 unfinished drafts per 24 hours, so post them as they come.
- `direct`: posted with the episode caption and TikTok's AI-generated label, privacy `TIKTOK_PRIVACY` (default `PUBLIC_TO_EVERYONE`). Before the audit TikTok only allows this on a private account.

TikTok takes vertical videos only; `publish` skips it for image episodes. Videos are downloaded from their public URL and uploaded as files, so the site's domain needs no verification at TikTok. `tiktok-draft <file or link>` sends any video (for example a talking-character clip) to the inbox.

For a character brand add `--brand <id>` (for example `--brand lolo`); its `.env` names are listed in `channels.yaml`.

## Commands

| Command | Does |
| --- | --- |
| `brands` | Brands, their channels and status, and which `.env` names are still empty |
| `login [port]` | Facebook Login in the browser, then the same as `setup` |
| `setup <token>` | Page id, Page token and Instagram id into `.env` |
| `threads-setup [token]` / `threads-refresh` | Threads profile and 60-day token; extend it |
| `check` | Token validity, missing permissions, Threads days left |
| `tiktok-login [port]` / `tiktok-check` | TikTok Login in the browser, tokens to `.env`; check it still works |
| `tiktok-draft <video.mp4 or link>` | Any video into the TikTok inbox as a draft |
| `publish <episode.json> [platform...]` | Post to the episode's brands, or `--brand <id>`. Refuses an episode the owner has not approved, or one changed since (`episodes/<id>/approval.json`, [docs/safety.md](../../docs/safety.md)); `EPISODES_DIR` overrides the folder |
| `comments` | Pull comments of every published episode |
| `insights` | Pull per-post numbers of every published episode into `data/insights.json` |
| `send-replies` | Post the approved first comments and character replies in `data/replies.json` (drafted by `story replies` / `story first-comment`), each once, from the account that published the post |
| `inbox` / `reply <conversation-id> <text>` | Pull conversations; answer one |

Insights are best effort. A number Meta does not give for that kind of post, or a permission the token lacks, is left out and listed under `missing` for that post; the command prints which gaps it saw. Facebook has been renaming its reach metrics, so `insights` tries `post_total_media_view_unique`, then `post_impressions_unique`; set `FB_REACH_METRIC` to force one. Threads gives views, not reach. Facebook and Instagram need `read_insights` and `instagram_manage_insights` (`check` lists what the Page token lacks). Threads needs `threads_manage_insights` on the Threads use case: a Threads token generated without it gives no Threads numbers until a new token is generated and saved with `threads-setup`.

An episode file looks like [examples/episode.json](examples/episode.json). Media must be public HTTPS URLs because Meta downloads them itself. Threads captions stop at 500 characters, so set `captions.threads` for a shorter one.

With `META_GRAPH_MOCK=1` every command talks to the fake Meta in `src/demo.ts` instead, so the whole flow runs without accounts.

## What keeps it safe

- Tokens go in the `Authorization` header. The only exceptions are the two Threads token calls that Meta accepts no other way.
- Failures are sorted into token, permission, rate limit, transient and invalid. Only the transient ones and rate limits are retried, with exponential backoff.
- Posts are checked locally (caption length, hashtags, number of images, HTTPS media) before anything is uploaded.
- Instagram and Threads containers are polled until they are `FINISHED`.
- The publish journal (`data/publish-journal.json`) never posts the same episode twice to the same account. If a publish dies at the last call, the next run stops and asks for a manual check.
- Replies outside the 24-hour window are refused locally (`OUTSIDE_WINDOW`).

`npm test` runs the tests against the fake Meta.
