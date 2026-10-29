/**
 * TikTok: sending episode videos and photo carousels through the Content Posting API.
 *
 * Two ways in:
 * - draft (scope video.upload): the video lands in the creator's TikTok inbox
 *   and the owner finishes the post in the app (caption, trending sound). This
 *   works before TikTok audits the app, but TikTok keeps at most 5 pending
 *   drafts per 24 hours.
 * - direct (scope video.publish): posted straight to the profile. Until the app
 *   passes TikTok's audit, this only works on a private account.
 *
 * Videos go up with FILE_UPLOAD, so their host needs no verification. Photo
 * carousels can only be pulled by TikTok from a verified URL prefix
 * (https://hoisau.dangtrantai.com/), with the same draft and direct modes.
 * Access tokens last 24 hours and are refreshed with the 365-day refresh token.
 * TikTok is not Meta: none of this goes through GraphClient.
 */

import { sleep, type FetchLike } from "./graph.js";

export const TIKTOK_API = "https://open.tiktokapis.com";
export const TIKTOK_AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
/** Static page on the site that hands the code to the login running on localhost (TikTok only accepts HTTPS redirects). */
export const TIKTOK_DEFAULT_REDIRECT = "https://hoisau.dangtrantai.com/tiktok-callback";
/** Path the CLI and the dashboard both listen on. */
export const TIKTOK_CALLBACK_PATH = "/connect/tiktok/callback";

export type TikTokMode = "draft" | "direct";
export const TIKTOK_MODES: TikTokMode[] = ["draft", "direct"];

export const tiktokScopes = (mode: TikTokMode) => ["user.info.basic", "video.upload", ...(mode === "direct" ? ["video.publish"] : [])];

export type TikTokErrorKind = "token" | "permission" | "rate_limit" | "transient" | "invalid";

export class TikTokError extends Error {
  override name = "TikTokError";

  constructor(
    message: string,
    readonly kind: TikTokErrorKind,
    readonly code: string,
    readonly status: number,
    readonly logId?: string,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.kind === "transient" || this.kind === "rate_limit";
  }
}

const PERMISSION = /^(scope_not_authorized|spam_risk_|unaudited_client|url_ownership|reached_active_user_cap|privacy_level_option_mismatch)/;

export function classifyTikTok(status: number, code: string): TikTokErrorKind {
  if (code === "access_token_invalid" || code === "invalid_grant" || status === 401) return "token";
  if (code === "rate_limit_exceeded" || status === 429) return "rate_limit";
  if (PERMISSION.test(code)) return "permission";
  if (status === 0 || status >= 500) return "transient";
  return "invalid";
}

/** Readable text for the errors the owner can do something about. */
const HINTS: Record<string, string> = {
  spam_risk_too_many_pending_share: "TikTok already holds 5 unfinished drafts from the last 24 hours. Post or delete some in the TikTok inbox first.",
  unaudited_client_can_only_post_to_private_accounts: "Until TikTok audits the app, direct posts only work on a private account. Use draft mode, or apply for the audit.",
  scope_not_authorized: "The TikTok login lacks a permission. Connect TikTok again and allow every item.",
  access_token_invalid: "The TikTok login has expired. Connect TikTok again.",
};

interface Envelope<T> {
  data?: T;
  error?: { code?: string; message?: string; log_id?: string };
}

/** int64 post ids lose digits as JSON numbers; read them as strings. */
const quoteBigIds = (text: string) =>
  text.replace(/("publicaly_available_post_id"\s*:\s*\[)([^\]]*)\]/g, (_m, head: string, list: string) =>
    `${head}${list.split(",").map((x) => x.trim()).filter(Boolean).map((x) => (x.startsWith('"') ? x : `"${x}"`)).join(",")}]`,
  );

export interface TikTokClientOptions {
  token?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number;
  /** First backoff delay in ms; doubles on each retry. Default 2000. */
  backoffMs?: number;
}

export class TikTokClient {
  readonly root: string;
  private readonly send: FetchLike;

  constructor(private readonly options: TikTokClientOptions = {}) {
    this.root = (options.baseUrl ?? TIKTOK_API).replace(/\/$/, "");
    this.send = options.fetch ?? ((url, init) => fetch(url, init));
  }

  withToken(token: string): TikTokClient {
    return new TikTokClient({ ...this.options, token });
  }

  /** JSON API call; returns `data`. */
  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.api<T>("POST", path, body);
  }

  get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const q = new URLSearchParams(params).toString();
    return this.api<T>("GET", `${path}${q ? `?${q}` : ""}`);
  }

  /** OAuth endpoints: form body, flat error fields, no Authorization header. */
  oauth<T>(path: string, params: Record<string, string>): Promise<T> {
    return this.retry(async () => {
      const res = await this.fetch(`${this.root}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
        body: new URLSearchParams(params),
      });
      const body = (await res.json().catch(() => ({}))) as T & { error?: string; error_description?: string; log_id?: string };
      if (!res.ok || (typeof body.error === "string" && body.error)) {
        const code = (typeof body.error === "string" && body.error) || `http_${res.status}`;
        throw new TikTokError(body.error_description || code, classifyTikTok(res.status, code), code, res.status, body.log_id);
      }
      return body;
    });
  }

  /** One chunk to an upload_url. Returns the HTTP status (206 more expected, 201 done). */
  putChunk(url: string, chunk: Uint8Array, first: number, total: number): Promise<number> {
    return this.retry(async () => {
      const res = await this.fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(chunk.byteLength),
          "Content-Range": `bytes ${first}-${first + chunk.byteLength - 1}/${total}`,
        },
        body: chunk,
      });
      if (res.status === 201 || res.status === 206 || res.ok) return res.status;
      const code = res.status === 403 ? "upload_url_expired" : `upload_http_${res.status}`;
      throw new TikTokError(`TikTok refused the video chunk (HTTP ${res.status}).`, classifyTikTok(res.status, code), code, res.status);
    });
  }

  /** Downloads a public media file (the episode video) to upload it. */
  async download(url: string): Promise<Uint8Array> {
    const res = await this.retry(() => this.fetch(url, { method: "GET" }));
    if (!res.ok) throw new TikTokError(`Could not download ${url} (HTTP ${res.status}).`, res.status >= 500 ? "transient" : "invalid", "download_failed", res.status);
    return new Uint8Array(await res.arrayBuffer());
  }

  private api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    return this.retry(async () => {
      const res = await this.fetch(`${this.root}${path}`, {
        method,
        headers: {
          ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
          ...(method === "POST" ? { "Content-Type": "application/json; charset=UTF-8" } : {}),
        },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      });
      const text = await res.text();
      let parsed: Envelope<T> = {};
      try {
        parsed = JSON.parse(quoteBigIds(text)) as Envelope<T>;
      } catch {
        // Not JSON: judged by the status below.
      }
      const code = parsed.error?.code ?? (res.ok ? "ok" : `http_${res.status}`);
      if (!res.ok || code !== "ok") {
        const message = HINTS[code] ?? (parsed.error?.message || `TikTok ${code}`);
        throw new TikTokError(message, classifyTikTok(res.status, code), code, res.status, parsed.error?.log_id);
      }
      return (parsed.data ?? {}) as T;
    });
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.send(url, init);
    } catch (e) {
      throw new TikTokError(`Network error: ${(e as Error).message}`, "transient", "network", 0);
    }
  }

  private async retry<T>(attempt: () => Promise<T>): Promise<T> {
    const retries = this.options.maxRetries ?? 3;
    const base = this.options.backoffMs ?? 2000;
    for (let i = 0; ; i++) {
      try {
        return await attempt();
      } catch (e) {
        if (!(e instanceof TikTokError) || !e.retryable || i >= retries) throw e;
        await sleep(base * 2 ** i);
      }
    }
  }
}

// ------------------------------------------------------------------ login

export function tiktokAuthorizeUrl(o: { clientKey: string; redirectUri: string; state: string; scopes: string[] }): string {
  const url = new URL(TIKTOK_AUTHORIZE_URL);
  url.searchParams.set("client_key", o.clientKey);
  url.searchParams.set("scope", o.scopes.join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", o.redirectUri);
  url.searchParams.set("state", o.state);
  // Always show the consent screen, so reconnecting can pick another account.
  url.searchParams.set("disable_auto_auth", "1");
  return url.href;
}

/**
 * The state names the local port, so the static callback page on the site
 * knows where to send the code: "p8765.<random>".
 */
export const tiktokState = (port: number, random: string) => `p${port}.${random}`;

export interface TikTokToken {
  accessToken: string;
  refreshToken: string;
  openId: string;
  scopes: string[];
  /** ISO times. */
  expiresAt: string;
  refreshExpiresAt: string;
}

interface RawToken {
  access_token: string;
  refresh_token: string;
  open_id: string;
  scope?: string;
  expires_in?: number;
  refresh_expires_in?: number;
}

const toToken = (r: RawToken, now = Date.now()): TikTokToken => ({
  accessToken: r.access_token,
  refreshToken: r.refresh_token,
  openId: r.open_id,
  scopes: (r.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  expiresAt: new Date(now + (r.expires_in ?? 86_400) * 1000).toISOString(),
  refreshExpiresAt: new Date(now + (r.refresh_expires_in ?? 365 * 86_400) * 1000).toISOString(),
});

export interface TikTokApp {
  clientKey: string;
  clientSecret: string;
}

export async function exchangeTikTokCode(c: TikTokClient, app: TikTokApp, code: string, redirectUri: string): Promise<TikTokToken> {
  return toToken(
    await c.oauth<RawToken>("/v2/oauth/token/", {
      client_key: app.clientKey,
      client_secret: app.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  );
}

/** TikTok may hand back a new refresh token; always keep the one returned. */
export async function refreshTikTokToken(c: TikTokClient, app: TikTokApp, refreshToken: string): Promise<TikTokToken> {
  return toToken(
    await c.oauth<RawToken>("/v2/oauth/token/", {
      client_key: app.clientKey,
      client_secret: app.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  );
}

export async function tiktokUser(c: TikTokClient): Promise<{ openId: string; displayName: string }> {
  const { user } = await c.get<{ user: { open_id: string; display_name?: string } }>("/v2/user/info/", { fields: "open_id,display_name" });
  return { openId: user.open_id, displayName: user.display_name ?? user.open_id };
}

// ------------------------------------------------------------ .env tokens

/** .env names of one TikTok account, from channels.yaml. */
export interface TikTokEnvNames {
  token: string;
  userId: string;
  username?: string;
}

/** Everything a login or refresh writes to .env. Only names derived from `token`, never printed. */
export function tiktokEnvValues(names: TikTokEnvNames, tok: TikTokToken, displayName?: string): Record<string, string> {
  return {
    [names.token]: tok.accessToken,
    [`${names.token}_EXPIRES`]: tok.expiresAt,
    [`${names.token}_REFRESH`]: tok.refreshToken,
    [`${names.token}_REFRESH_EXPIRES`]: tok.refreshExpiresAt,
    [names.userId]: tok.openId,
    ...(names.username && displayName ? { [names.username]: displayName } : {}),
  };
}

/**
 * The access token from .env, refreshed first when it has less than ten
 * minutes left. `save` receives the new values for .env.
 */
export async function freshTikTokToken(
  env: Record<string, string | undefined>,
  names: TikTokEnvNames,
  app: TikTokApp | undefined,
  c: TikTokClient,
  save: (values: Record<string, string>) => void | Promise<void>,
  now = Date.now(),
): Promise<string | undefined> {
  const token = env[names.token];
  const expires = Date.parse(env[`${names.token}_EXPIRES`] ?? "");
  if (token && (!Number.isFinite(expires) || expires - now > 10 * 60_000)) return token;
  const refresh = env[`${names.token}_REFRESH`];
  if (!refresh || !app) return token;
  const tok = await refreshTikTokToken(c, app, refresh);
  await save(tiktokEnvValues(names, tok));
  return tok.accessToken;
}

// --------------------------------------------------------------- posting

export interface CreatorInfo {
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options: string[];
  max_video_post_duration_sec?: number;
}

export const tiktokCreatorInfo = (c: TikTokClient) => c.post<CreatorInfo>("/v2/post/publish/creator_info/query/");

const MB = 1024 * 1024;

/** One request up to 64 MB; above that 10 MB chunks, the last one taking the remainder. */
export function chunkPlan(size: number): { chunkSize: number; count: number } {
  if (size <= 64 * MB) return { chunkSize: size, count: 1 };
  const chunkSize = 10 * MB;
  return { chunkSize, count: Math.floor(size / chunkSize) };
}

export interface TikTokPostOptions {
  mode: TikTokMode;
  /** Caption. Videos: direct mode only (drafts get their caption in the app). Photos: the title. */
  title?: string;
  /** Direct mode. Must be one TikTok offers this creator. Default PUBLIC_TO_EVERYONE. */
  privacy?: string;
  /** Adds TikTok's "AI-generated" label (direct mode). Default true: every frame here is drawn by a model. */
  isAigc?: boolean;
  /** Called with the publish id right after init, before any byte is sent. */
  beforePublish?: (publishId: string) => Promise<void>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export interface TikTokPostResult {
  publishId: string;
  /** SEND_TO_USER_INBOX for a draft, PUBLISH_COMPLETE for a direct post. */
  status: string;
  /** Public post id, once TikTok has reviewed a direct post. */
  postId?: string;
  permalink?: string;
}

/** Direct mode: the privacy level, checked against what TikTok offers this creator, and the creator's handle. */
async function directPrivacy(c: TikTokClient, o: TikTokPostOptions): Promise<{ privacy: string; username?: string }> {
  const info = await tiktokCreatorInfo(c);
  const privacy = o.privacy ?? "PUBLIC_TO_EVERYONE";
  if (!info.privacy_level_options.includes(privacy)) {
    throw new TikTokError(
      `TikTok does not offer ${privacy} for this account (offers ${info.privacy_level_options.join(", ") || "nothing"}).`,
      "permission",
      "privacy_level_option_mismatch",
      0,
    );
  }
  return { privacy, username: info.creator_username };
}

export async function postTikTokVideo(c: TikTokClient, video: Uint8Array, o: TikTokPostOptions): Promise<TikTokPostResult> {
  const size = video.byteLength;
  if (size === 0) throw new TikTokError("The video file is empty.", "invalid", "empty_video", 0);
  const { chunkSize, count } = chunkPlan(size);
  const source_info = { source: "FILE_UPLOAD", video_size: size, chunk_size: chunkSize, total_chunk_count: count };

  let username: string | undefined;
  let init: { publish_id: string; upload_url: string };
  if (o.mode === "direct") {
    const d = await directPrivacy(c, o);
    username = d.username;
    init = await c.post("/v2/post/publish/video/init/", {
      post_info: { title: o.title ?? "", privacy_level: d.privacy, is_aigc: o.isAigc ?? true },
      source_info,
    });
  } else {
    init = await c.post("/v2/post/publish/inbox/video/init/", { source_info });
  }

  await o.beforePublish?.(init.publish_id);
  for (let i = 0; i < count; i++) {
    const first = i * chunkSize;
    const last = i === count - 1 ? size : first + chunkSize;
    await c.putChunk(init.upload_url, video.subarray(first, last), first, size);
  }
  return waitForPost(c, init.publish_id, o, (id) => (username ? `https://www.tiktok.com/@${username}/video/${id}` : undefined));
}

/** TikTok's limits for photo posts. Photos must be JPEG or WebP. */
export const TIKTOK_PHOTO = { max: 35, title: 90, description: 4000, formats: /\.(jpe?g|webp)$/i };

/**
 * TikTok pulls photos itself (FILE_UPLOAD is not offered for photos), and
 * only from a URL prefix verified in the developer portal. The site answers
 * on two hosts; only hoisau.dangtrantai.com is verified.
 */
export const TIKTOK_VERIFIED_HOST = "hoisau.dangtrantai.com";
const SAME_SITE = ["hoisau.web.app", "hoisau.firebaseapp.com"];

export function tiktokPhotoUrl(url: string): string {
  const u = new URL(url);
  if (SAME_SITE.includes(u.host)) u.host = TIKTOK_VERIFIED_HOST;
  return u.href;
}

/**
 * A photo carousel (1 to 35 images). Draft mode sends it to the TikTok inbox
 * with title and description filled in; the owner adds a sound and posts.
 */
export async function postTikTokPhotos(c: TikTokClient, urls: string[], o: TikTokPostOptions & { description?: string; coverIndex?: number }): Promise<TikTokPostResult> {
  if (urls.length === 0 || urls.length > TIKTOK_PHOTO.max) {
    throw new TikTokError(`A TikTok photo post takes 1 to ${TIKTOK_PHOTO.max} images, got ${urls.length}.`, "invalid", "photo_count", 0);
  }
  const photo_images = urls.map(tiktokPhotoUrl);
  const cut = (text: string, max: number) => Array.from(text).slice(0, max).join("");
  const post_info: Record<string, unknown> = {
    title: cut(o.title ?? "", TIKTOK_PHOTO.title),
    description: cut(o.description ?? "", TIKTOK_PHOTO.description),
  };
  let username: string | undefined;
  if (o.mode === "direct") {
    const d = await directPrivacy(c, o);
    username = d.username;
    post_info.privacy_level = d.privacy;
  }
  const init = await c.post<{ publish_id: string }>("/v2/post/publish/content/init/", {
    media_type: "PHOTO",
    post_mode: o.mode === "direct" ? "DIRECT_POST" : "MEDIA_UPLOAD",
    is_aigc: o.isAigc ?? true,
    post_info,
    source_info: { source: "PULL_FROM_URL", photo_images, photo_cover_index: o.coverIndex ?? 0 },
  });
  await o.beforePublish?.(init.publish_id);
  return waitForPost(c, init.publish_id, o, (id) => (username ? `https://www.tiktok.com/@${username}/photo/${id}` : undefined));
}

/** Polls the post status until it reaches the inbox (draft) or goes live (direct). */
async function waitForPost(c: TikTokClient, publishId: string, o: TikTokPostOptions, link: (postId: string) => string | undefined): Promise<TikTokPostResult> {
  const goal = o.mode === "direct" ? "PUBLISH_COMPLETE" : "SEND_TO_USER_INBOX";
  const every = o.pollIntervalMs ?? 5000;
  const giveUpAt = Date.now() + (o.pollTimeoutMs ?? 10 * 60_000);
  for (;;) {
    const s = await c.post<{ status: string; fail_reason?: string; publicaly_available_post_id?: string[] }>("/v2/post/publish/status/fetch/", {
      publish_id: publishId,
    });
    if (s.status === "FAILED") throw new TikTokError(`TikTok could not take the post: ${s.fail_reason ?? "no reason given"}.`, "invalid", s.fail_reason ?? "failed", 0);
    // A draft the owner already posted from the inbox also counts as done.
    if (s.status === goal || s.status === "PUBLISH_COMPLETE") {
      const postId = s.publicaly_available_post_id?.[0];
      return { publishId, status: s.status, postId, permalink: postId ? link(postId) : undefined };
    }
    if (Date.now() >= giveUpAt) throw new TikTokError("Timed out waiting for TikTok to process the post.", "transient", "processing_timeout", 0);
    await sleep(every);
  }
}
