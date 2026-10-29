/**
 * Fake TikTok for tests and META_GRAPH_MOCK=1: answers the OAuth, user,
 * creator, video and photo init, chunk upload and status calls, and records what was sent.
 * Media downloads (any other host) return a small fake video.
 */

import type { FetchLike } from "./graph.js";

export const TIKTOK_DEMO = {
  openId: "demo-open-id",
  displayName: "Hồi Sau",
  username: "hoisau.comic",
  accessToken: "demo-tiktok-access",
  refreshToken: "demo-tiktok-refresh",
  publishId: "v_inbox_file~v2.123",
  /** Larger than 2^53, as TikTok's real ids are. */
  postId: "7430000000000000123",
};

export interface TikTokCall {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
  bytes?: number;
}

export function demoTikTok(opts: { privacy?: string[]; statusPolls?: number; fail?: string } = {}) {
  const calls: TikTokCall[] = [];
  let polls = 0;
  let mode: "draft" | "direct" = "draft";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const ok = (data: unknown) => json({ data, error: { code: "ok", message: "", log_id: "log1" } });

  const fetch: FetchLike = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const raw = init.body;
    const body =
      raw instanceof URLSearchParams ? Object.fromEntries(raw) : typeof raw === "string" ? JSON.parse(raw) : undefined;
    const call: TikTokCall = { method, url, path: u.pathname, headers, body, bytes: raw instanceof Uint8Array ? raw.byteLength : undefined };
    calls.push(call);

    if (u.host === "upload.example.tiktok") {
      const [, last, total] = headers["Content-Range"].match(/bytes \d+-(\d+)\/(\d+)/)!;
      return new Response(null, { status: Number(last) + 1 === Number(total) ? 201 : 206 });
    }
    if (u.host !== "open.tiktokapis.com") return new Response(new Uint8Array(2048), { status: 200 });

    switch (`${method} ${u.pathname}`) {
      case "POST /v2/oauth/token/":
        return json({
          access_token: TIKTOK_DEMO.accessToken,
          refresh_token: TIKTOK_DEMO.refreshToken,
          open_id: TIKTOK_DEMO.openId,
          scope: "user.info.basic,video.upload",
          expires_in: 86400,
          refresh_expires_in: 31536000,
          token_type: "Bearer",
        });
      case "GET /v2/user/info/":
        return ok({ user: { open_id: TIKTOK_DEMO.openId, display_name: TIKTOK_DEMO.displayName } });
      case "POST /v2/post/publish/creator_info/query/":
        return ok({ creator_username: TIKTOK_DEMO.username, creator_nickname: TIKTOK_DEMO.displayName, privacy_level_options: opts.privacy ?? ["PUBLIC_TO_EVERYONE", "SELF_ONLY"] });
      case "POST /v2/post/publish/inbox/video/init/":
      case "POST /v2/post/publish/video/init/":
      case "POST /v2/post/publish/content/init/":
        if (opts.fail) return json({ data: {}, error: { code: opts.fail, message: "no", log_id: "log2" } }, 403);
        mode = u.pathname.includes("inbox") || (body as { post_mode?: string })?.post_mode === "MEDIA_UPLOAD" ? "draft" : "direct";
        return ok({ publish_id: TIKTOK_DEMO.publishId, upload_url: "https://upload.example.tiktok/upload?token=x" });
      case "POST /v2/post/publish/status/fetch/": {
        polls++;
        if (polls <= (opts.statusPolls ?? 1)) return ok({ status: "PROCESSING_UPLOAD" });
        if (mode === "draft") return ok({ status: "SEND_TO_USER_INBOX" });
        // Raw text, so the big id is a JSON number exactly as TikTok sends it.
        return new Response(`{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[${TIKTOK_DEMO.postId}]},"error":{"code":"ok"}}`, { status: 200 });
      }
    }
    return json({ data: {}, error: { code: "invalid_param", message: `no route ${u.pathname}` } }, 400);
  };
  return { fetch, calls };
}
