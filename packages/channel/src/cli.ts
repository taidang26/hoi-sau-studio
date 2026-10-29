#!/usr/bin/env node
/**
 * hoisau-channel: accounts, publishing, comments and inbox from the terminal.
 * TikTok has its own login (tiktok-login) and posts episode videos and photo carousels as drafts.
 * Run `npm run channel -- help` for the command list.
 *
 * Settings come from .env in the working directory; channels.yaml says which
 * .env names belong to which brand. `--brand <id>` picks a brand (default:
 * the main brand). META_GRAPH_MOCK=1 swaps Meta for the fake in demo.ts.
 */

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BRANDS_FILE,
  DEFAULT_GRAPH_VERSION,
  FACEBOOK_REACH_METRICS,
  FileJournal,
  GraphClient,
  GraphError,
  InboxError,
  MAIN_BRAND,
  THREADS_BASE_URL,
  brandTargets,
  channelStates,
  exchangeCodeForUserToken,
  exchangeLongLivedUserToken,
  exchangeThreadsLongLived,
  facebookInsights,
  fetchConversations,
  fetchFacebookComments,
  fetchInstagramComments,
  fetchThreadsReplies,
  findBrand,
  insightsPath,
  inspectToken,
  instagramInsights,
  journalPath,
  listManagedPages,
  loadBrands,
  loadComments,
  loadInbox,
  loadInsights,
  loginDialogUrl,
  mergeComments,
  mergeConversations,
  mergeInsights,
  missingScopes,
  parseJournalKey,
  publishEpisode,
  refreshThreadsToken,
  routeEpisode,
  approvalProblems,
  loadReplies,
  saveReplies,
  sendApproved,
  saveComments,
  saveInbox,
  saveInsights,
  sendReply,
  threadsInsights,
  threadsProfile,
  waitForLoginCode,
  TIKTOK_CALLBACK_PATH,
  TIKTOK_DEFAULT_REDIRECT,
  TikTokClient,
  TikTokError,
  exchangeTikTokCode,
  freshTikTokToken,
  postTikTokVideo,
  tiktokAuthorizeUrl,
  tiktokEnvValues,
  tiktokScopes,
  tiktokState,
  tiktokUser,
  type TikTokEnvNames,
  type Brand,
  type ChannelEnv,
  type Comment,
  type Conversation,
  type EpisodePost,
  type Platform,
  type PostMetrics,
  type Targets,
} from "./index.js";
import { demoGraph } from "./demo.js";
import { demoTikTok } from "./tiktok-demo.js";

// ------------------------------------------------------------------- .env

const ENV_FILE = ".env";

async function readEnvLines(): Promise<string[]> {
  try {
    return (await readFile(ENV_FILE, "utf8")).split(/\r?\n/);
  } catch {
    return [];
  }
}

/** Loads .env without overriding variables already set in the shell. */
async function loadEnv(): Promise<void> {
  for (const line of await readEnvLines()) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, name, raw] = match;
    process.env[name] ??= raw.replace(/^"(.*)"$/, "$1");
  }
}

/** Updates (or appends) these keys in .env and leaves every other line alone. */
async function saveEnv(values: Record<string, string>): Promise<void> {
  const lines = await readEnvLines();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  for (const [name, value] of Object.entries(values)) {
    const at = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (at === -1) lines.push(`${name}=${value}`);
    else lines[at] = `${name}=${value}`;
    process.env[name] = value;
  }
  await writeFile(ENV_FILE, `${lines.join("\n").trimEnd()}\n`, "utf8");
}

function required(name: string | undefined): string {
  const value = name ? process.env[name] : undefined;
  if (!name || !value) throw new Error(`${name ?? "A required setting"} is not set. See .env.example.`);
  return value;
}

// ------------------------------------------------------------------ Graph

const mock = process.env.META_GRAPH_MOCK === "1";
let fake: ReturnType<typeof demoGraph> | undefined;

/** Largest percentage in a usage header such as {"call_count":12,"total_time":80}. */
function peakUsage(header: string): number {
  let peak = 0;
  const visit = (value: unknown, key = ""): void => {
    if (typeof value === "number" && key !== "estimated_time_to_regain_access") peak = Math.max(peak, value);
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) visit(v, k);
  };
  try {
    visit(JSON.parse(header));
  } catch {
    // Not JSON: nothing to report.
  }
  return peak;
}

function client(token?: string, baseUrl?: string): GraphClient {
  if (mock) fake ??= demoGraph();
  return new GraphClient({
    token,
    baseUrl,
    version: process.env.META_GRAPH_VERSION || undefined,
    fetch: fake?.fetch,
    backoffMs: mock ? 1 : undefined,
    onUsage: (header, value) => {
      const peak = peakUsage(value);
      if (peak >= 75) console.warn(`[graph] ${header} at ${peak}%, slowing down is wise`);
    },
  });
}

const threadsClient = (token?: string) => client(token, THREADS_BASE_URL);

let fakeTikTok: ReturnType<typeof demoTikTok> | undefined;
const tiktokClient = (token?: string) => {
  if (mock) fakeTikTok ??= demoTikTok();
  return new TikTokClient({ token, fetch: fakeTikTok?.fetch, backoffMs: mock ? 1 : undefined });
};
const clientFor = (token: string, platform: Platform) => (platform === "threads" ? threadsClient(token) : client(token));

// ----------------------------------------------------------------- brands

const dataDir = () => process.env.CHANNEL_DATA_DIR || "data";
const journal = () => new FileJournal(journalPath(dataDir()));

let allBrands: Brand[] | undefined;
const brands = () => (allBrands ??= loadBrands(process.env.CHANNELS_FILE || BRANDS_FILE));

/** Set by --brand. */
let chosenBrand: string | undefined;
const currentBrand = () => findBrand(brands(), chosenBrand ?? MAIN_BRAND);

function envNames(platform: Platform, brand = currentBrand()): ChannelEnv {
  const channel = brand.channels.find((c) => c.platform === platform);
  if (!channel) throw new Error(`Brand ${brand.id} has no ${platform} channel in channels.yaml.`);
  return channel.env;
}

const optionalEnvNames = (platform: Platform, brand = currentBrand()) =>
  brand.channels.find((c) => c.platform === platform)?.env;

/** The brand's accounts. Paused channels are included when asked (old posts, a manual publish). */
function accounts(brand: Brand, includePaused: boolean) {
  const found = brandTargets(brand, process.env, clientFor, { includePaused, tiktok: tiktokClient });
  if (!found.targets) {
    const fb = optionalEnvNames("facebook", brand);
    throw new Error(
      `${brand.name}: ${fb?.pageId ?? "the Page id"} and ${fb?.token ?? "the Page token"} are not set. Run: npm run channel -- setup <token> --brand ${brand.id}`,
    );
  }
  return { ...found, targets: found.targets };
}

// --------------------------------------------------------------- commands

async function setup(shortToken: string) {
  const brand = currentBrand();
  const fb = envNames("facebook");
  const ig = optionalEnvNames("instagram");
  const { accessToken } = await exchangeLongLivedUserToken(client(), required("META_APP_ID"), required("META_APP_SECRET"), shortToken);
  const wanted = fb.pageId ? process.env[fb.pageId] : undefined;
  const pages = await listManagedPages(client(accessToken), { pageId: wanted });
  if (pages.length === 0) {
    throw new Error(
      "This account manages no Pages. Check pages_show_list was granted; if the Page belongs to a business portfolio, add business_management to the login.",
    );
  }

  const page = wanted ? pages.find((p) => p.id === wanted) : pages.length === 1 ? pages[0] : undefined;
  if (!page) {
    console.log("Pages this account manages:");
    for (const p of pages) console.log(`  ${p.id}  ${p.name}${p.instagram ? `  (Instagram ${p.instagram.username ?? p.instagram.id})` : ""}`);
    throw new Error(`Put the Page id you want in ${fb.pageId} in .env, then run setup again.`);
  }

  await saveEnv({
    [fb.pageId!]: page.id,
    [fb.token!]: page.accessToken,
    ...(ig?.userId ? { [ig.userId]: page.instagram?.id ?? "" } : {}),
  });
  console.log(`${brand.name}: Page "${page.name}" (${page.id}) connected, Page token saved to .env.`);
  console.log(
    page.instagram
      ? `Instagram: ${page.instagram.username ?? page.instagram.id}`
      : "No Instagram professional account is linked to this Page yet. Link it in Instagram, then run setup again.",
  );
}

/** Opens a URL in the default browser without going through a shell. */
function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // No browser to open: the URL is printed anyway.
  }
}

/** Facebook Login in the browser, then the same steps as setup. No token to copy by hand. */
async function login(portArg?: string) {
  const appId = required("META_APP_ID");
  const appSecret = required("META_APP_SECRET");
  const port = Number(portArg ?? process.env.META_LOGIN_PORT ?? 8765);
  const redirectUri = `http://localhost:${port}/callback`;
  const state = randomBytes(16).toString("hex");
  const url = loginDialogUrl({
    appId,
    redirectUri,
    state,
    version: process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION,
    configId: process.env.META_LOGIN_CONFIG_ID || undefined,
    // Comma-separated subset, e.g. only the pages_* scopes while the Page has no Instagram yet,
    // so Facebook does not make you pick an unrelated Instagram account.
    scopes: process.env.META_LOGIN_SCOPES ? process.env.META_LOGIN_SCOPES.split(",").map((s) => s.trim()) : undefined,
  });

  const code = await waitForLoginCode({
    port,
    state,
    onListening: () => {
      console.log("Opening Facebook in your browser. Approve the Page (and its Instagram), then come back here.");
      console.log(`If nothing opens, visit:\n${url}\n`);
      if (!mock) openBrowser(url);
    },
  });
  await setup(await exchangeCodeForUserToken(client(), appId, appSecret, redirectUri, code));
}

const DAY_MS = 86_400_000;

async function storeThreadsToken(token: string, expiresIn: number | undefined, more: Record<string, string> = {}): Promise<string> {
  const names = envNames("threads");
  const until = new Date(Date.now() + (expiresIn ?? 60 * 86_400) * 1000).toISOString();
  await saveEnv({ ...more, [names.token!]: token, [`${names.token}_EXPIRES`]: until });
  return until;
}

/** Reads the clipboard, so a token copied from the dashboard never has to be pasted into a terminal. */
function readClipboard(): string {
  const [cmd, args]: [string, string[]] =
    process.platform === "win32"
      ? ["powershell", ["-NoProfile", "-Command", "Get-Clipboard"]]
      : process.platform === "darwin"
        ? ["pbpaste", []]
        : ["xclip", ["-selection", "clipboard", "-o"]];
  try {
    return execFileSync(cmd, args, { encoding: "utf8" }).trim();
  } catch {
    throw new Error("Could not read the clipboard. Pass the token as an argument instead.");
  }
}

async function threadsSetup(tokenArg?: string) {
  const shortToken = tokenArg ?? readClipboard();
  if (!/^\S{20,}$/.test(shortToken)) {
    throw new Error("That does not look like a Threads token. Click Copy next to the token in the User Token Generator, then run this again.");
  }
  const names = envNames("threads");
  let long: { accessToken: string; expiresIn?: number };
  try {
    long = await exchangeThreadsLongLived(threadsClient(), required("THREADS_APP_SECRET"), shortToken);
  } catch (e) {
    // The dashboard's User Token Generator already hands out a 60-day token,
    // which Meta refuses to exchange again. Use it as it is if it works.
    if (!(e instanceof GraphError) || (e.kind !== "token" && e.kind !== "invalid")) throw e;
    long = { accessToken: shortToken };
  }
  const profile = await threadsProfile(threadsClient(long.accessToken));
  const until = await storeThreadsToken(long.accessToken, long.expiresIn, {
    [names.userId!]: profile.id,
    [names.username!]: profile.username,
  });
  console.log(`Threads @${profile.username} (${profile.id}) connected. Token saved to .env, valid until ${until}.`);
}

async function threadsRefresh() {
  const res = await refreshThreadsToken(threadsClient(), required(envNames("threads").token));
  console.log(`Threads token extended until ${await storeThreadsToken(res.accessToken, res.expiresIn)}.`);
}

async function check() {
  const brand = currentBrand();
  console.log(`Brand ${brand.name} (${brand.id})`);

  const th = optionalEnvNames("threads");
  const threadsToken = th?.token ? process.env[th.token] : undefined;
  if (threadsToken) {
    const profile = await threadsProfile(threadsClient(threadsToken));
    const expires = Date.parse(process.env[`${th!.token}_EXPIRES`] ?? "");
    const daysLeft = Number.isFinite(expires) ? Math.floor((expires - Date.now()) / DAY_MS) : undefined;
    console.log(`Threads @${profile.username}: OK${daysLeft === undefined ? "" : `, token expires in ${daysLeft} days`}.`);
    if (daysLeft !== undefined && daysLeft < 10) console.warn("Run `threads-refresh` soon.");
  }

  const appToken = `${required("META_APP_ID")}|${required("META_APP_SECRET")}`;
  const status = await inspectToken(client(appToken), required(envNames("facebook").token));
  if (!status.valid) throw new Error("The Page token is no longer valid. Run setup again with a fresh token.");
  console.log(`Page token valid ${status.expiresAt ? `until ${status.expiresAt.toISOString()}` : "with no fixed expiry"}.`);
  const missing = missingScopes(status.scopes);
  console.log(missing.length ? `Missing permissions: ${missing.join(", ")}` : "Every required permission is granted.");
}

async function publish(file: string, only: Platform[]) {
  const post = JSON.parse(await readFile(file, "utf8")) as EpisodePost;
  // Only what the owner approved goes out, exactly as approved. The fake Meta skips this for demos and tests.
  if (!mock) {
    const problems = approvalProblems(join(process.env.EPISODES_DIR || "episodes", post.episodeId), post);
    if (problems.length) throw new Error(`Not publishing ${post.episodeId}:\n  ${problems.join("\n  ")}`);
  }
  // --brand posts to that brand only. Otherwise channels.yaml routes by the lead character.
  const routes = chosenBrand
    ? [{ brand: currentBrand() }]
    : post.lead
      ? routeEpisode(brands(), { lead: post.lead, characters: post.characters })
      : [{ brand: findBrand(brands(), MAIN_BRAND) }];

  const log = journal();
  for (const { brand } of routes) {
    await tiktokToken(brand);
    const { targets, platforms, skipped } = accounts(brand, only.length > 0);
    for (const s of skipped) {
      if (only.length === 0 || only.includes(s.platform)) console.log(`${brand.id} ${s.platform}: skipped, ${s.reason}`);
    }
    for (const platform of only.length ? only.filter((p) => platforms.includes(p)) : platforms) {
      const res = await publishEpisode(platform, post, targets, log, {
        brand: brand.id,
        tiktokPrivacy: process.env.TIKTOK_PRIVACY || undefined,
        ...(mock ? { pollIntervalMs: 1 } : {}),
      });
      if (res.inbox && post.format !== "reels-9x16") console.log(`${brand.id} ${platform}: photos in the TikTok inbox with the caption filled in. Open TikTok, add a sound, post.`);
      else if (res.inbox) console.log(`${brand.id} ${platform}: in the TikTok inbox. Open TikTok, add the caption and sound, post. Caption:\n${captionOf(post, platform)}`);
      else console.log(`${brand.id} ${platform}: ${res.permalink ?? res.postId}`);
    }
  }
}

const captionOf = (post: EpisodePost, platform: Platform) => post.captions?.[platform] ?? post.caption;

// ----------------------------------------------------------------- TikTok

function tiktokNames(brand = currentBrand()): TikTokEnvNames & { mode: "draft" | "direct" } {
  const channel = brand.channels.find((c) => c.platform === "tiktok");
  if (!channel?.env.token || !channel.env.userId) throw new Error(`Brand ${brand.id} has no tiktok channel with token and userId in channels.yaml.`);
  return { token: channel.env.token, userId: channel.env.userId, username: channel.env.username, mode: channel.mode ?? "draft" };
}

const tiktokApp = () =>
  process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET
    ? { clientKey: process.env.TIKTOK_CLIENT_KEY, clientSecret: process.env.TIKTOK_CLIENT_SECRET }
    : undefined;

/** Refreshes the brand's TikTok token in .env when it is about to expire. No TikTok channel: nothing to do. */
async function tiktokToken(brand: Brand): Promise<string | undefined> {
  const channel = brand.channels.find((c) => c.platform === "tiktok");
  if (!channel?.env.token || !channel.env.userId || channel.status === "planned") return undefined;
  return freshTikTokToken(process.env, tiktokNames(brand), tiktokApp(), tiktokClient(), saveEnv);
}

/** TikTok Login in the browser. TikTok only redirects to HTTPS, so a page on the site forwards the code here. */
async function tiktokLogin(portArg?: string) {
  const app = tiktokApp();
  if (!app) throw new Error("TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET are not set. See .env.example.");
  const names = tiktokNames();
  const port = Number(portArg ?? process.env.TIKTOK_LOGIN_PORT ?? 8765);
  const redirectUri = process.env.TIKTOK_REDIRECT_URI || TIKTOK_DEFAULT_REDIRECT;
  const state = tiktokState(port, randomBytes(16).toString("hex"));
  const url = tiktokAuthorizeUrl({ clientKey: app.clientKey, redirectUri, state, scopes: tiktokScopes(names.mode) });

  const code = mock
    ? "demo-code"
    : await waitForLoginCode({
        port,
        state,
        path: TIKTOK_CALLBACK_PATH,
        provider: "TikTok",
        onListening: () => {
          console.log("Opening TikTok in your browser. Log in with the brand's TikTok account and allow every item, then come back here.");
          console.log(`If nothing opens, visit:\n${url}\n`);
          openBrowser(url);
        },
      });
  const tok = await exchangeTikTokCode(tiktokClient(), app, code, redirectUri);
  const user = await tiktokUser(tiktokClient(tok.accessToken));
  await saveEnv(tiktokEnvValues(names, tok, user.displayName));
  console.log(`TikTok "${user.displayName}" connected (${names.mode} mode). Token saved to .env; it renews itself until ${tok.refreshExpiresAt.slice(0, 10)}.`);
  const missing = tiktokScopes(names.mode).filter((s) => !tok.scopes.includes(s));
  if (missing.length) console.warn(`Not granted: ${missing.join(", ")}. Run tiktok-login again and allow every item.`);
}

async function tiktokCheck() {
  const brand = currentBrand();
  const names = tiktokNames(brand);
  const token = await tiktokToken(brand);
  if (!token) throw new Error("TikTok is not connected. Run: npm run channel -- tiktok-login");
  const user = await tiktokUser(tiktokClient(token));
  const until = Date.parse(process.env[`${names.token}_REFRESH_EXPIRES`] ?? "");
  const days = Number.isFinite(until) ? Math.floor((until - Date.now()) / DAY_MS) : undefined;
  console.log(`TikTok "${user.displayName}": OK, ${names.mode} mode${days === undefined ? "" : `, login valid for ${days} more days`}.`);
}

/**
 * Any video file or link straight into the TikTok inbox, e.g. a talking-character clip
 * that is not an episode. A draft is not public: the owner posts it from the app.
 */
async function tiktokDraft(source: string) {
  const brand = currentBrand();
  const token = await tiktokToken(brand);
  if (!token) throw new Error("TikTok is not connected. Run: npm run channel -- tiktok-login");
  const c = tiktokClient(token);
  const video = /^https:\/\//.test(source) ? await c.download(source) : new Uint8Array(await readFile(source));
  const res = await postTikTokVideo(c, video, { mode: "draft", ...(mock ? { pollIntervalMs: 1 } : {}) });
  console.log(`In the TikTok inbox of ${brand.name} (${res.publishId}). Open TikTok to add the caption and sound, then post.`);
}

function listBrands() {
  for (const brand of brands()) {
    const who = brand.character ? `${brand.kind} ${brand.character}` : brand.kind;
    console.log(`${brand.id}  ${brand.name}  (${who}, posts ${brand.posts})`);
    for (const state of channelStates(brand, process.env)) {
      const note = state.status === "planned" ? "" : state.missing.length ? `  missing ${state.missing.join(", ")}` : "  ok";
      console.log(`  ${state.platform.padEnd(10)} ${state.status.padEnd(8)}${note}`);
    }
  }
}

async function pullComments() {
  const cache = new Map<string, Targets>();
  const targetsOf = (brand: Brand) => {
    if (!cache.has(brand.id)) cache.set(brand.id, accounts(brand, true).targets);
    return cache.get(brand.id)!;
  };

  const fetched: Comment[] = [];
  for (const post of await journal().published()) {
    const brand = findBrand(brands(), post.brand ?? MAIN_BRAND);
    const t = targetsOf(brand);
    switch (post.platform) {
      case "facebook":
        fetched.push(...(await fetchFacebookComments(t.page, t.pageId, post.postId)));
        break;
      case "instagram":
        fetched.push(...(await fetchInstagramComments(t.page, required(envNames("instagram", brand).userId), post.postId)));
        break;
      case "threads":
        if (t.threads) fetched.push(...(await fetchThreadsReplies(t.threads.client, required(envNames("threads", brand).username), post.postId)));
        break;
    }
  }
  const { all, added } = mergeComments(await loadComments(dataDir()), fetched);
  await saveComments(dataDir(), all);
  console.log(`${added.length} new comments, ${all.length} in total.`);
}

/** Accounts per brand, looked up once; paused channels included, since their posts still get comments. */
function accountsCache() {
  const cache = new Map<string, Targets>();
  return (id = MAIN_BRAND) => {
    const brand = findBrand(brands(), id);
    if (!cache.has(brand.id)) cache.set(brand.id, accounts(brand, true).targets);
    return cache.get(brand.id)!;
  };
}

async function sendReplies() {
  const targetsOf = accountsCache();
  // Each comment goes out from the account that published its post.
  const brandOf = new Map((await journal().published()).map((p) => [p.postId, p.brand]));
  const { list, sent, failed } = await sendApproved((c) => targetsOf(c.brand ?? brandOf.get(c.postId)), await loadReplies(dataDir()));
  await saveReplies(dataDir(), list);
  console.log(`${sent} sent, ${failed} failed.`);
}

async function pullInbox() {
  const fetched: Conversation[] = [];
  // Every brand with a Page, paused ones too: people keep writing to a paused Page.
  for (const brand of brands()) {
    const t = brandTargets(brand, process.env, clientFor, { includePaused: true }).targets;
    if (!t) continue;
    const own = t.igUserId ? [t.pageId, t.igUserId] : [t.pageId];
    const found = await fetchConversations(t.page, t.pageId, "facebook", own);
    if (t.igUserId) found.push(...(await fetchConversations(t.page, t.pageId, "instagram", own)));
    fetched.push(...(brand.id === MAIN_BRAND ? found : found.map((c) => ({ ...c, brand: brand.id }))));
  }
  const { all, newMessages } = mergeConversations(await loadInbox(dataDir()), fetched);
  await saveInbox(dataDir(), all);
  console.log(`${newMessages} new messages, ${all.length} conversations.`);
}

async function reply(conversationId: string, text: string) {
  const inbox = await loadInbox(dataDir());
  const conversation = inbox.find((c) => c.id === conversationId);
  if (!conversation) throw new InboxError(`No conversation ${conversationId}. Run inbox first.`, "NOT_FOUND");
  const { page, pageId } = accounts(findBrand(brands(), conversation.brand ?? MAIN_BRAND), true).targets;
  conversation.messages.push(await sendReply(page, pageId, conversation, text));
  conversation.updatedAt = new Date().toISOString();
  await saveInbox(dataDir(), inbox);
  console.log(`Sent to ${conversation.customer.name}.`);
}

async function pullInsights() {
  const cache = new Map<string, Targets>();
  const targetsOf = (brand: Brand) => {
    if (!cache.has(brand.id)) cache.set(brand.id, accounts(brand, true).targets);
    return cache.get(brand.id)!;
  };
  const reachMetrics = process.env.FB_REACH_METRIC ? [process.env.FB_REACH_METRIC] : FACEBOOK_REACH_METRICS;

  const fresh: PostMetrics[] = [];
  const gaps = new Map<string, number>();
  for (const [key, post] of await journal().publishedByKey()) {
    const { format } = parseJournalKey(key);
    const t = targetsOf(findBrand(brands(), post.brand ?? MAIN_BRAND));
    const numbers =
      post.platform === "facebook"
        ? await facebookInsights(t.page, post.postId, reachMetrics)
        : post.platform === "instagram"
          ? await instagramInsights(t.page, post.postId, format === "reels-9x16")
          : post.platform === "threads" && t.threads
            ? await threadsInsights(t.threads.client, post.postId)
            : undefined;
    if (!numbers) continue;
    const { missing, ...values } = numbers;
    for (const m of missing) gaps.set(`${post.platform} ${m}`, (gaps.get(`${post.platform} ${m}`) ?? 0) + 1);
    fresh.push({
      postId: post.postId,
      platform: post.platform,
      ...(post.brand ? { brand: post.brand } : {}),
      ...values,
      fetchedAt: new Date().toISOString(),
      ...(missing.length ? { missing } : {}),
    });
  }
  const all = mergeInsights(await loadInsights(dataDir()), fresh);
  await saveInsights(dataDir(), all);
  console.log(`Numbers for ${fresh.length} posts, ${all.length} in ${insightsPath(dataDir())}.`);
  for (const [gap, n] of gaps) console.log(`  not available on ${n} post(s): ${gap}`);
}

// -------------------------------------------------------------------- main

interface Command {
  usage: string;
  help: string;
  /** Minimum number of arguments. */
  args?: number;
  run: (args: string[]) => unknown;
}

const commands: Record<string, Command> = {
  brands: { usage: "brands", help: "brands and channels from channels.yaml, and empty .env names", run: listBrands },
  login: {
    usage: "login [port]",
    help: "log in with Facebook in the browser, then save the Page and its Instagram to .env",
    run: ([port]) => login(port),
  },
  setup: {
    usage: "setup <short-lived user token>",
    help: "swap the token, find the Page and its Instagram, save them to .env",
    args: 1,
    run: ([token]) => setup(token),
  },
  "threads-setup": {
    usage: "threads-setup [short-lived Threads token]",
    help: "swap it (or the one on the clipboard) for a 60-day token and save the Threads profile",
    run: ([token]) => threadsSetup(token),
  },
  "threads-refresh": { usage: "threads-refresh", help: "extend the Threads token by another 60 days", run: threadsRefresh },
  "tiktok-login": {
    usage: "tiktok-login [port]",
    help: "log in with TikTok in the browser and save the account and its tokens to .env",
    run: ([port]) => tiktokLogin(port),
  },
  "tiktok-check": { usage: "tiktok-check", help: "TikTok login works, renewing the 24-hour token if needed", run: tiktokCheck },
  "tiktok-draft": {
    usage: "tiktok-draft <video.mp4 | https link>",
    help: "send any video to the TikTok inbox as a draft, to post from the app",
    args: 1,
    run: ([source]) => tiktokDraft(source),
  },
  check: { usage: "check", help: "Page token validity and permissions, Threads token days left", run: check },
  publish: {
    usage: "publish <episode.json> [facebook|instagram|threads|tiktok]...",
    help: "post the episode to its brands (or --brand), on every live platform or the ones named",
    args: 1,
    run: ([file, ...platforms]) => publish(file, platforms as Platform[]),
  },
  comments: { usage: "comments", help: "pull comments of every published episode into data/comments.json", run: pullComments },
  insights: {
    usage: "insights",
    help: "pull reach, reactions, shares, saves and views of every published post into data/insights.json",
    run: pullInsights,
  },
  "send-replies": {
    usage: "send-replies",
    help: "post the approved character comments in data/replies.json, each once",
    run: sendReplies,
  },
  inbox: { usage: "inbox", help: "pull Messenger and Instagram conversations into data/inbox.json", run: pullInbox },
  reply: {
    usage: "reply <conversation-id> <text>",
    help: "answer a conversation, only within 24 hours of the customer's last message",
    args: 2,
    run: ([id, ...words]) => reply(id, words.join(" ")),
  },
};

function printHelp() {
  console.log("Usage: npm run channel -- <command> [--brand <id>]\n");
  for (const c of Object.values(commands)) console.log(`  ${c.usage.padEnd(56)} ${c.help}`);
}

async function main() {
  await loadEnv();
  const argv = process.argv.slice(2);
  const flag = argv.indexOf("--brand");
  if (flag !== -1) {
    chosenBrand = argv[flag + 1];
    if (!chosenBrand) throw new Error("Usage: --brand <id from channels.yaml>");
    argv.splice(flag, 2);
  }

  const [name, ...args] = argv;
  const command = name ? commands[name] : undefined;
  if (!command) return printHelp();
  if (args.length < (command.args ?? 0)) throw new Error(`Usage: ${command.usage}`);
  await command.run(args);
}

function explain(error: unknown): string {
  if (error instanceof GraphError && error.kind === "token") {
    return "A token has expired or was revoked. Get a fresh one and run setup (or threads-setup) again.";
  }
  if (error instanceof GraphError && error.kind === "permission") return `Not allowed: ${error.message}`;
  if (error instanceof TikTokError && error.kind === "token") return "The TikTok login has expired or was revoked. Run tiktok-login again.";
  if (error instanceof TikTokError) return `TikTok: ${error.message}${error.logId ? ` (log ${error.logId})` : ""}`;
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(explain(error));
  process.exit(1);
});
