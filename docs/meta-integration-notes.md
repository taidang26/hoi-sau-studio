# Facebook / Instagram integration notes

Guide for the 30 Oct work on `packages/channel`. These are lessons from earlier work on Meta's APIs, written down as prose on 26 Oct. No earlier code is included or reused: everything in `packages/channel` is written new during the hackathon.

Scope for the hackathon build: one Facebook Page and one Instagram professional account, both owned by the developer. Publish episodes, read comments, nothing else.

## 1. Permissions: ask only for what the build uses

Meta reviewers reject permissions an app does not visibly use, and every extra permission is another screen in Facebook Login. For this build:

| Need | Permission |
| --- | --- |
| List the Pages the user manages, pick one | `pages_show_list` |
| Publish carousel / video to the Page | `pages_manage_posts` (requires `pages_read_engagement`) |
| Read comments and commenter names on Page posts | `pages_read_engagement`, `pages_read_user_content` |
| Find the Instagram account linked to the Page | `instagram_basic` |
| Publish carousel / Reels to Instagram | `instagram_content_publish` |
| Read Instagram comments | `instagram_manage_comments` |
| Reply to or hide comments as the Page | `pages_manage_engagement` (requires `pages_read_user_content`) |
| Reach and engagement numbers for posts | `read_insights` (Facebook), `instagram_manage_insights` (Instagram) |
| Page owned through a Business Portfolio | `business_management` (only if `/me/accounts` does not return the Page) |
| Real-time comment webhooks | `pages_manage_metadata` (only if webhooks are used, see section 4) |

Not needed: `pages_messaging`, `instagram_manage_messages`, any `ads_*`. Hồi Sau does not send private messages, so the 24-hour messaging window and private-reply limits do not apply.

Dependencies that bit before: the `pages_*` permissions need `pages_show_list`; `pages_manage_posts` needs `pages_read_engagement`; `pages_manage_engagement` needs `pages_read_user_content`; all `instagram_*` need `instagram_basic`.

## 2. App mode: skip App Review for the hackathon

- App Review takes days to weeks and needs one screencast per permission, Business Verification, and live Privacy Policy, Terms and data-deletion URLs. Not realistic inside the window.
- In **Development mode**, every permission works for people who hold a role on the app (Admin, Developer, Tester) on Pages and accounts they manage. Since the Page and Instagram account belong to the developer, the whole demo runs without review.
- Consequence: real audience comments are still readable (they are content on our own Page), but only app-role users can log in to the tool. Say this plainly in the demo instead of implying the app is public.
- If review is needed later: one clip per permission, each clip shows the full flow from login to the result visible on Facebook/Instagram, no cuts; English subtitles if the UI is Vietnamese; record the full screen so the Meta login popup is captured. Meta also requires a successful test call for each permission in the last 30 days before the form can be submitted.

## 3. Tokens

- Facebook Login gives a short-lived user token (about 1 hour). Exchange it right away for a long-lived user token (about 60 days), then read the Page token from `/me/accounts` (or the business endpoints). A Page token derived from a long-lived user token has no fixed expiry, but it dies when the user changes password, removes the app, or loses the Page role.
- The Instagram account is reached through the linked Page and uses the Page token. If the Page token dies, the Instagram side dies with it.
- Store tokens only server side and encrypted, never in a URL, never in logs, never in the repo. `.env` stays out of git; ship `.env.example` only.
- Tell **token errors** apart from **permission errors**. Graph error code 190 (and 102, and the subcodes 458–467) means the token is gone: mark the channel "needs reconnect". Code 10 and 200–299 mean a missing permission or a disallowed action: show the reason, keep the channel connected. Treating permission errors as expired tokens disconnected healthy channels before.
- Network errors and 5xx are neither: retry with backoff, do not change the channel state.
- Keep a visible channel status (connected / needs reconnect / disconnected) and run a cheap health check before the daily publish, so a dead token is found before the episode slot, not after.

## 4. Reading comments: polling first, webhooks optional

Hồi Sau reads comments once per episode cycle, not in real time. Polling is the simpler and safer default:

- Fetch comments of the last N episode posts on a schedule (for example every 15–30 minutes, and once more right before the Listen step runs). Store by the platform comment ID so repeated fetches do not duplicate.
- Facebook: comments are on the post object; replies are nested comments. Instagram: comments and their replies are separate edges. Keep the parent/child link, because a reply to a comment is usually a reaction to that idea, not a new idea.
- Commenter avatar: on Facebook it comes from the comment's `from` field, not from the Messenger profile endpoint (that one only works for message senders). Missing avatar is normal; fall back to initials.
- The Page's own comments come back in the list. Filter them out before Listen, or the character "votes" for its own story.

If webhooks are added for a live demo:

- Needs a public HTTPS callback (a tunnel works locally), a verify token for the GET handshake, and subscribing the Page via `/{page-id}/subscribed_apps`.
- Verify `X-Hub-Signature-256` (HMAC-SHA256 with the App Secret) on the **raw body bytes** before parsing JSON. Parsing and re-serialising changes the bytes and breaks the check.
- Answer 200 fast and queue the work. Meta disables webhooks that are slow or fail often.
- Meta resends events. Deduplicate on the comment ID.
- Echoes: actions the Page itself takes come back as events. Recognise them so the system never reacts to its own output.
- Webhook payloads are thin. Use them as a "go fetch" signal and read the comment through the API.

## 5. Publishing

Instagram publishing is two steps: create a media container, wait for it, then publish it.

- Media must be at a public HTTPS URL Meta can fetch (a signed URL with a short expiry works). Meta downloads it; it does not accept an upload.
- Carousel: create one container per item, then a carousel container listing them, then publish. 2–10 items.
- Reels / video: the container processes asynchronously. Poll its `status_code` until `FINISHED` (or `ERROR`) before calling publish. Publishing too early fails.
- Limits that caught posts before: caption up to 2,200 characters, up to 30 hashtags, feed images JPEG up to 8 MB with aspect ratio between 4:5 and 1.91:1. The 4:5 carousel and 9:16 Reels in the plan fit; validate before calling the API and return a clear error per rule. Check the current video limits in Meta's docs before the 1 Nov motion-comic work.
- Instagram has a daily publishing cap per account (check the current number with the `content_publishing_limit` edge). One episode a day is far below it, but retries count, so do not retry blindly.
- **Double posting:** if the publish call times out, the post may already be live. Record the container ID, mark the state as "may be published", check before retrying. Use a claim-then-work lock so two workers never publish the same episode.
- Instagram has no API to edit a caption or delete a post after publishing. Facebook does. Get the caption right before publishing.
- Facebook: photos go through the Page photos endpoint (multi-photo posts attach unpublished photos to one feed post); video and Reels have their own endpoints and also process asynchronously.
- Save the returned post ID and permalink. The comment reader and the demo both need them.

## 5b. Threads

Added on 26 Oct for organic reach.

- Separate API host (`graph.threads.net`), separate login, separate app ID and secret under the app's Threads use case. The Page token does not work there.
- Every Threads profile hangs off an Instagram account, so the Instagram account comes first.
- In Development mode the Threads profile must be added as a Threads tester and accept the invite inside the Threads app.
- Token exchange and refresh are the exception to "token in the header": those two endpoints only accept GET with the secret and token on the query string. Every other call sends the token in the `Authorization` header.
- Long-lived tokens last about 60 days and can be refreshed once they are a day old. Track the expiry and refresh well before it.
- Publishing is the same two-step container flow as Instagram: create, wait for `FINISHED`, publish. Carousel items must finish before the carousel container is created.
- Text is limited to 500 characters, so keep a separate short caption for Threads.
- Replies come from the post's `conversation` edge, nested replies included and flattened, with `replied_to` pointing at the parent. Drop our own replies and hidden ones.

## 6. Rate limits and retries

- Graph API returns usage in the `X-App-Usage` and `X-Business-Use-Case-Usage` headers. Log them; slow down before reaching 100%.
- Retry only transient errors (network, 5xx, rate-limit codes), at most 3 times with exponential backoff. Never retry a 4xx validation error.
- Limit manual "check connection" or "refresh" buttons (for example 3 per minute) so a nervous click during the demo does not burn quota.

## 7. Connect flow

- OAuth `state` must be signed (HMAC), short-lived (about 10 minutes) and bound to the user who started it. Reject on mismatch.
- The user explicitly picks the Page. Do not auto-connect "the first Page found", and do not auto-connect the Instagram account just because it is linked to the Page: connect it as its own step.
- If the Instagram account does not appear: it must be a professional (Business or Creator) account linked to the Page, and `instagram_basic` must be granted. Show that reason in the UI instead of an empty list.
- Pages owned through a Business Portfolio may not appear in `/me/accounts`. That is what `business_management` is for.
- When testing the login flow repeatedly, remove the app from the Facebook account's Business Integrations settings to see the full permission screens again, or use "Edit access" in the dialog.
- A popup login flow is nicer than a redirect, but a strict Content Security Policy blocked the inline script that closes the popup before. Use a static script file with a nonce, or keep the redirect flow for the hackathon.

## 8. Testing

- Add a mock flag for the Graph API so tests and CI run without real tokens or network.
- Test with a real second account playing "audience" (a separate browser profile), not as the Page admin: the admin sees hidden comments that others do not.
- Tests must assert the exact status code and error, not "not 403".
- Before the demo, run the full loop once on the real Page: publish → comment from the second account → comment appears in the store → Listen picks it.

## 9. Things not to put in this public repo

- Tokens, App Secret, verify token, test-account passwords (use `.env` and the reviewer-instructions field only).
- Real customer or client names, Pages or data. Use only the Hồi Sau Page and the developer's own test accounts.

## Official references

- Facebook Login manual flow: https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
- Long-lived tokens: https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
- Permissions reference: https://developers.facebook.com/docs/permissions
- Webhooks, validating payloads: https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validate-payloads
- Page subscribed apps: https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps
- Instagram content publishing: https://developers.facebook.com/docs/instagram-platform/content-publishing
- Graph API rate limits: https://developers.facebook.com/docs/graph-api/overview/rate-limiting
