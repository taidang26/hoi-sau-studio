/**
 * HTTP server for the dashboard. Reads state from disk on every request, so
 * whatever the channel or studio CLIs just wrote shows up on refresh.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BOLD_FONT_PATH, DEFAULT_FONT_PATH } from "@hoi-sau/svg-text";
import type { Conversation, InboxMessage, Platform } from "@hoi-sau/channel";
import { NeedsSetup, type Accounts } from "./accounts.js";
import { editCharacterPage, newCharacterPage, saveCharacter } from "./characters.js";
import { appendMessage, brandArtDir, loadState, toggleDirection, type Paths } from "./data.js";
import { pickLang, t, withLang, type Lang } from "./i18n.js";
import { episodeStudioPage, friendly, Studio, studioPage, stylePage } from "./studio.js";
import { CHARACTERS_DIR, loadProfile, SERIES_DIR, type EpisodeStep } from "@hoi-sau/studio";
import {
  automationPage,
  brandPage,
  channelsPage,
  charactersPage,
  characterPage,
  charSrc,
  commentsPage,
  episodesPage,
  inboxPage,
  notFoundPage,
  overviewPage,
  settingsPage,
  type Abilities,
  type BrandControls,
  type ChannelStatus,
} from "./views.js";

const STATIC_DIR = fileURLToPath(new URL("../static", import.meta.url));
const FONTS: Record<string, string> = { "BeVietnamPro-SemiBold.ttf": DEFAULT_FONT_PATH, "BeVietnamPro-Bold.ttf": BOLD_FONT_PATH };
const TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".srt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface DashboardOptions extends Paths {
  channel: () => ChannelStatus;
  /** Shown on top of every page, e.g. to say the data is a sample. */
  banner?: string;
  inbox?: {
    /** Sends a reply through the platform and returns it; throws InboxError when refused. */
    send(c: Conversation, text: string): Promise<InboxMessage>;
    /** Pulls new conversations into the data dir. Omitted when no Page is connected. */
    pull?(): Promise<number | void>;
  };
  /** Character creation and the episode pipeline. Omitted: those pages say how to enable them. */
  studio?: Studio;
  /** Settings, account connection, pulling comments, channel on/off. */
  accounts?: Accounts;
  /** Sample data: buttons that would change real accounts say so instead. */
  demo?: boolean;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 50_000) throw new Error("Form too large");
  }
  return new URLSearchParams(raw);
}

const redirect = (res: ServerResponse, to: string) => {
  res.writeHead(303, { Location: to });
  res.end();
};

/** `to` with ?ok= or ?err= added, for the one-line result on the next page. */
const withNote = (to: string, key: "ok" | "err", text: string) => `${to}${to.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(text)}`;

function send(res: ServerResponse, status: number, body: string, type = "text/html; charset=utf-8"): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

/** Serves a file; honours a single byte Range, which Safari needs to play video. */
function sendFile(res: ServerResponse, file: string, range?: string): void {
  if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, notFoundPage());
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  const size = statSync(file).size;
  const m = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      return void res.end();
    }
    res.writeHead(206, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    return void createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": size });
  createReadStream(file).pipe(res);
}

/** Resolve `rel` under `root`, refusing anything that escapes it. */
export function inside(root: string, rel: string): string | null {
  const base = resolve(root);
  const full = resolve(base, rel);
  return full.startsWith(base + sep) ? full : null;
}

/** Same-site path to go back to, never another host. */
const safeBack = (v: string | null | undefined, fallback = "/") => (v && /^\/(?!\/)/.test(v) ? v : fallback);

const errText = (e: unknown) => friendly(e instanceof Error ? e.message : String(e));

export function handler(opts: DashboardOptions) {
  const page = (res: ServerResponse, status: number, html: string) =>
    send(res, status, opts.banner ? html.replace("<main>", `<main><div class="notice demo-note">${t(opts.banner)}</div>`) : html);
  const charactersDir = () => opts.studio?.opts.charactersDir ?? opts.charactersDir ?? CHARACTERS_DIR;
  const acc = opts.accounts;
  // Sample data shows every button; pressing one explains that nothing real changes.
  const abilities = (): Abilities => ({ canPull: Boolean(acc) && (Boolean(opts.demo) || acc!.anyPage()), canConnect: Boolean(acc), studio: Boolean(opts.studio) });

  const route = async (req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<void> => {
    const q = url.searchParams;
    const ok = q.get("ok") ?? undefined;
    const err = q.get("err") ?? undefined;
    const fail = (to: string, e: unknown) =>
      e instanceof NeedsSetup ? redirect(res, withNote(e.where, "err", e.message)) : redirect(res, withNote(to, "err", errText(e)));
    const back = (fallback: string) => {
      const ref = req.headers.referer;
      if (!ref) return fallback;
      const r = new URL(ref);
      if (r.host !== req.headers.host) return fallback;
      r.searchParams.delete("ok");
      r.searchParams.delete("err");
      return r.pathname + r.search;
    };

    // Language switch: a cookie, then back where the click came from.
    const lm = path.match(/^\/lang\/(vi|en)$/);
    if (lm) {
      res.writeHead(303, { Location: safeBack(q.get("back")), "Set-Cookie": `lang=${lm[1]}; Path=/; Max-Age=31536000; SameSite=Lax` });
      return void res.end();
    }

    if (req.method === "POST" && path === "/inbox/refresh") {
      if (opts.demo) return redirect(res, withNote("/inbox", "err", t("Đang xem dữ liệu mẫu nên không lấy tin nhắn thật.")));
      try {
        const n = await opts.inbox?.pull?.();
        return redirect(res, typeof n === "number" ? withNote("/inbox", "ok", t("{n} tin nhắn mới.", { n })) : "/inbox");
      } catch (e) {
        return fail("/inbox", e);
      }
    }
    if (req.method === "POST" && path === "/comments/refresh") {
      const to = back("/comments");
      if (!acc || opts.demo) return redirect(res, withNote(to, "err", t("Đang xem dữ liệu mẫu nên không lấy bình luận thật.")));
      try {
        return redirect(res, withNote(to, "ok", t("{n} bình luận mới.", { n: await acc.pullComments() })));
      } catch (e) {
        return fail(to, e);
      }
    }
    const r = req.method === "POST" ? path.match(/^\/inbox\/(.+)\/reply$/) : null;
    if (r) {
      const id = r[1];
      const to = `/inbox?c=${encodeURIComponent(id)}`;
      const c = loadState(opts).inbox.find((x) => x.id === id);
      if (!c || !opts.inbox) return redirect(res, withNote(to, "err", t("Không tìm thấy hội thoại.")));
      try {
        const sent = await opts.inbox.send(c, (await readForm(req)).get("text") ?? "");
        await appendMessage(opts.dataDir, id, sent);
        return redirect(res, to);
      } catch (e) {
        return fail(to, e);
      }
    }

    // Settings and accounts.
    if (path === "/settings") {
      if (req.method === "POST") {
        if (!acc || opts.demo) return redirect(res, "/settings");
        try {
          const n = acc.saveSettings(await readForm(req));
          return redirect(res, withNote("/settings", "ok", n ? t("Đã lưu {n} mục.", { n }) : t("Không có gì thay đổi.")));
        } catch (e) {
          return fail("/settings", e);
        }
      }
      const settings = acc?.settings() ?? [];
      return page(res, 200, settingsPage(settings, { demo: Boolean(opts.demo || !acc), mock: Boolean(opts.studio?.opts.mock), ok, error: err }));
    }
    if (path === "/connect/facebook") {
      const brand = q.get("brand") ?? "hoi-sau";
      if (!acc || opts.demo) return redirect(res, withNote(`/channels/${brand}`, "err", t("Đang xem dữ liệu mẫu nên không kết nối tài khoản thật.")));
      const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? "http";
      try {
        return redirect(res, acc.startLogin(brand, `${proto}://${req.headers.host}/connect/facebook/callback`));
      } catch (e) {
        return fail(`/channels/${brand}`, e);
      }
    }
    if (path === "/connect/facebook/callback" && acc) {
      const state = q.get("state") ?? "";
      const brand = acc.loginBrand(state) ?? "hoi-sau";
      const denied = q.get("error_description") ?? q.get("error");
      if (denied) return redirect(res, withNote(`/channels/${brand}`, "err", t("Facebook chưa cho phép: {m}", { m: denied })));
      try {
        const done = await acc.finishLogin(state, q.get("code") ?? "");
        if (done.choose) return page(res, 200, brandPage(loadState(opts), done.brand, { ...brandControls(done.brand), choose: done.choose })!);
        return redirect(res, withNote(`/channels/${done.brand}`, "ok", connectedNote(done)));
      } catch (e) {
        return fail(`/channels/${brand}`, e);
      }
    }
    if (req.method === "POST" && path === "/connect/facebook/choose" && acc) {
      const form = await readForm(req);
      try {
        const done = acc.choosePage(form.get("choice") ?? "", form.get("page") ?? "");
        return redirect(res, withNote(`/channels/${done.brand}`, "ok", connectedNote(done)));
      } catch (e) {
        return fail("/channels", e);
      }
    }
    const thr = req.method === "POST" ? path.match(/^\/channels\/([a-z0-9-]+)\/threads$/) : null;
    if (thr && acc && !opts.demo) {
      try {
        const name = await acc.connectThreads(thr[1], (await readForm(req)).get("token") ?? "");
        return redirect(res, withNote(`/channels/${thr[1]}`, "ok", t("Đã kết nối Threads @{name}.", { name })));
      } catch (e) {
        return fail(`/channels/${thr[1]}`, e);
      }
    }
    const cs = req.method === "POST" ? path.match(/^\/channels\/([a-z0-9-]+)\/(facebook|instagram|threads)\/status$/) : null;
    if (cs && acc && !opts.demo) {
      try {
        const status = (await readForm(req)).get("status") as "live" | "paused" | "planned";
        acc.setStatus(cs[1], cs[2] as Platform, status);
        return redirect(res, withNote(`/channels/${cs[1]}`, "ok", t(status === "live" ? "Đã bật kênh." : "Đã tạm dừng kênh.")));
      } catch (e) {
        return fail(`/channels/${cs[1]}`, e);
      }
    }
    if (req.method === "POST" && (thr || cs)) return redirect(res, withNote(`/channels/${(thr ?? cs)![1]}`, "err", t("Đang xem dữ liệu mẫu nên không đổi tài khoản thật.")));

    // Characters: the form works without Muse; drawing and the AI writer need Studio.
    if (path === "/characters/new/manual" && req.method === "POST") {
      try {
        return redirect(res, withNote(`/characters/${saveCharacter(await readForm(req), charactersDir())}`, "ok", t("Đã tạo nhân vật. Bước tiếp: vẽ model sheet.")));
      } catch (e) {
        return fail("/characters/new?manual=1", e);
      }
    }
    const ed = path.match(/^\/characters\/([a-z0-9-]+)\/edit$/);
    if (ed) {
      if (req.method === "POST") {
        try {
          saveCharacter(await readForm(req), charactersDir(), ed[1]);
          return redirect(res, withNote(`/characters/${ed[1]}`, "ok", t("Đã lưu hồ sơ.")));
        } catch (e) {
          return fail(`/characters/${ed[1]}/edit`, e);
        }
      }
      const c = loadState(opts).characters.find((x) => x.profile.slug === ed[1]);
      return c ? page(res, 200, editCharacterPage(loadProfile(ed[1], charactersDir()), charSrc(c), err)) : page(res, 404, notFoundPage());
    }

    const st = opts.studio;
    if (req.method === "POST" && st) {
      if (path === "/characters/new") {
        const idea = (await readForm(req)).get("idea") ?? "";
        try {
          return redirect(res, withNote(`/characters/${await st.newCharacter(idea)}`, "ok", t("Đã tạo nhân vật. Bước tiếp: vẽ model sheet.")));
        } catch (e) {
          return fail("/characters/new", e);
        }
      }
      const sh = path.match(/^\/characters\/([a-z0-9-]+)\/sheet$/);
      if (sh) {
        try {
          st.drawSheet(sh[1]);
          return redirect(res, `/characters/${sh[1]}`);
        } catch (e) {
          return fail(`/characters/${sh[1]}`, e);
        }
      }
      const art = path.match(/^\/channels\/([a-z0-9-]+)\/art$/);
      if (art) {
        try {
          st.drawBrandArt(art[1]);
          return redirect(res, `/channels/${art[1]}`);
        } catch (e) {
          return fail(`/channels/${art[1]}`, e);
        }
      }
      if (path === "/style/draw") {
        try {
          st.drawStyle();
          return redirect(res, "/style");
        } catch (e) {
          return fail("/style", e);
        }
      }
      const sa = path.match(/^\/style\/([a-z0-9-]+)\/approve$/);
      if (sa) {
        try {
          st.chooseStyle(sa[1]);
          return redirect(res, "/style");
        } catch (e) {
          return fail("/style", e);
        }
      }
      const ap = path.match(/^\/characters\/([a-z0-9-]+)\/approve$/);
      if (ap) {
        try {
          st.approve(ap[1]);
          return redirect(res, withNote(`/characters/${ap[1]}`, "ok", t("Đã khoá model sheet.")));
        } catch (e) {
          return fail(`/characters/${ap[1]}`, e);
        }
      }
      if (path === "/studio/new") {
        const form = await readForm(req);
        try {
          return redirect(res, `/studio/${st.newEpisode(form)}`);
        } catch (e) {
          return fail("/studio", e);
        }
      }
      const run = path.match(/^\/studio\/([a-z0-9-]+)\/run$/);
      if (run) {
        const form = await readForm(req);
        try {
          st.run(run[1], { from: (form.get("from") || undefined) as EpisodeStep | undefined, to: (form.get("to") || undefined) as EpisodeStep | undefined });
          return redirect(res, `/studio/${run[1]}`);
        } catch (e) {
          return fail(`/studio/${run[1]}`, e);
        }
      }
    }
    if (req.method === "POST") {
      const m = path.match(/^\/comments\/(.+)\/pick$/);
      if (!m) return send(res, 404, notFoundPage());
      await toggleDirection(opts.dataDir, m[1]);
      // Back to where the click came from, keeping its filters.
      return redirect(res, back("/comments"));
    }

    if (path.startsWith("/static/")) {
      const name = path.slice("/static/".length);
      if (FONTS[name]) return sendFile(res, FONTS[name]);
      const file = inside(STATIC_DIR, name);
      return file ? sendFile(res, file) : send(res, 404, notFoundPage());
    }
    if (path.startsWith("/media/")) {
      const file = inside(opts.runsDir, path.slice("/media/".length));
      return file ? sendFile(res, file) : send(res, 404, notFoundPage());
    }
    if (path.startsWith("/brand-art/")) {
      const file = inside(st?.brandArtDir ?? brandArtDir(opts), path.slice("/brand-art/".length));
      return file && /[\\/](avatar|cover|cover-title)\.png$/.test(file) ? sendFile(res, file) : send(res, 404, notFoundPage());
    }

    if (st && path.startsWith("/studio-media/")) {
      const file = inside(st.opts.episodesDir, path.slice("/studio-media/".length));
      return file && !file.includes(`${sep}layers${sep}`) ? sendFile(res, file, req.headers.range) : send(res, 404, notFoundPage());
    }
    const pm = path.match(/^\/portrait\/([a-z0-9-]+)\.svg$/);
    if (pm) return sendFile(res, join(charactersDir(), pm[1], "portrait.svg"));
    if (st && path.startsWith("/sheet/")) {
      const file = inside(st.opts.charactersDir, path.slice("/sheet/".length));
      return file && /[\\/](model|pose)-sheet\.(png|jpe?g|webp)$/.test(file) ? sendFile(res, file) : send(res, 404, notFoundPage());
    }
    if (st && path.startsWith("/style-media/")) {
      const file = inside(st.styleDir, path.slice("/style-media/".length));
      return file && /\.(png|jpe?g|webp)$/.test(file) ? sendFile(res, file) : send(res, 404, notFoundPage());
    }
    if (st && path.startsWith("/series-media/")) {
      const file = inside(st.opts.seriesDir ?? SERIES_DIR, path.slice("/series-media/".length));
      return file && /[\\/]style-ref\.(png|jpe?g|webp)$/.test(file) ? sendFile(res, file) : send(res, 404, notFoundPage());
    }

    const state = loadState(opts);
    if (path === "/characters/new") return page(res, 200, newCharacterPage(Boolean(st?.opts.mock), Boolean(st?.ready), err, q.get("manual") === "1" || !st));
    if (path === "/studio") return page(res, 200, st ? studioPage(state, st, err) : notFoundPage());
    if (path === "/style") return page(res, 200, st ? stylePage(st, err) : notFoundPage());
    const sp = path.match(/^\/studio\/([a-z0-9-]+)$/);
    if (sp && st) {
      const html = episodeStudioPage(state, st, sp[1], err);
      return html ? page(res, 200, html) : page(res, 404, notFoundPage());
    }
    if (path === "/") return page(res, 200, overviewPage(state, opts.channel(), abilities(), ok, err));
    if (path === "/channels") return page(res, 200, channelsPage(state));
    const br = path.match(/^\/channels\/([a-z0-9-]+)$/);
    if (br) {
      const html = brandPage(state, br[1], { ...brandControls(br[1]), ok, error: err });
      return html ? page(res, 200, html) : page(res, 404, notFoundPage());
    }
    if (path === "/characters") return page(res, 200, charactersPage(state, ok));
    const ch = path.match(/^\/characters\/([a-z0-9-]+)$/);
    if (ch) {
      const c = state.characters.find((x) => x.profile.slug === ch[1]);
      const job = st?.jobs.get(`sheet:${ch[1]}`);
      return c ? page(res, 200, characterPage(c, st ? { canDraw: true, drawing: job?.running ? (job.step ?? t("bắt đầu…")) : undefined, error: err ?? job?.error, ok } : { canDraw: false, ok, error: err })) : page(res, 404, notFoundPage());
    }
    if (path === "/inbox") {
      return page(res, 200, inboxPage(state, { selected: q.get("c") ?? undefined, error: err, ok, canPull: Boolean(opts.inbox?.pull) ? !acc || acc.anyPage() : Boolean(opts.demo && acc), canConnect: abilities().canConnect }));
    }
    if (path === "/episodes") return page(res, 200, episodesPage(state));
    if (path === "/automation") return page(res, 200, automationPage(state, Boolean(st)));
    if (path === "/comments") {
      return page(res, 200, commentsPage(state, { q: q.get("q") ?? undefined, platform: q.get("platform") || undefined, episode: q.get("episode") || undefined, brand: q.get("brand") || undefined, picked: q.get("picked") === "1" }, abilities(), ok, err));
    }
    if (path === "/api/state") {
      const { byPost: _, comics, ...rest } = state;
      return send(res, 200, JSON.stringify({ ...rest, comics: [...comics.values()] }), TYPES[".json"]);
    }
    return send(res, 404, notFoundPage());
  };

  const brandControls = (id: string): BrandControls => {
    const job = opts.studio?.jobs.get(`art:${id}`);
    return {
      canConnect: Boolean(acc),
      needsAppKeys: !opts.demo && Boolean(acc) && !acc!.settings().filter((s) => s.name === "META_APP_ID" || s.name === "META_APP_SECRET").every((s) => s.set),
      canDrawArt: Boolean(opts.studio),
      drawingArt: job?.running ? (job.step ?? t("bắt đầu…")) : undefined,
      error: job?.error,
    };
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = decodeURIComponent(url.pathname);
    const lang: Lang = pickLang(req.headers.cookie);
    return withLang(lang, async () => {
      try {
        await route(req, res, url, path);
      } catch (e) {
        console.error(e);
        if (!res.headersSent) send(res, 500, `<pre>${String(e instanceof Error ? e.message : e).replace(/</g, "&lt;")}</pre>`);
      }
    });
  };
}

function connectedNote(done: { page?: string; instagram?: string }): string {
  return done.instagram ? t("Đã kết nối Trang {page} và Instagram @{ig}.", { page: done.page ?? "", ig: done.instagram }) : t("Đã kết nối Trang {page}. Trang này chưa liên kết Instagram.", { page: done.page ?? "" });
}

export function startDashboard(opts: DashboardOptions, port: number, host = "127.0.0.1"): Promise<Server> {
  const server = createServer(handler(opts));
  return new Promise((ok) => server.listen(port, host, () => ok(server)));
}

export const defaultPaths = (root: string, env = process.env): Paths => ({
  dataDir: resolve(root, env.CHANNEL_DATA_DIR || "data"),
  runsDir: join(root, "output", "characters"),
});
