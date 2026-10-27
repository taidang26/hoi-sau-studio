/**
 * HTTP server for the dashboard. Reads state from disk on every request, so
 * whatever the channel or studio CLIs just wrote shows up on refresh.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BOLD_FONT_PATH, DEFAULT_FONT_PATH } from "@hoi-sau/svg-text";
import type { Conversation, InboxMessage } from "@hoi-sau/channel";
import { appendMessage, loadState, toggleDirection, type Paths } from "./data.js";
import { episodeStudioPage, newCharacterPage, Studio, studioPage, stylePage } from "./studio.js";
import { CHARACTERS_DIR, SERIES_DIR, type EpisodeStep } from "@hoi-sau/studio";
import { automationPage, brandPage, channelsPage, characterPage, charactersPage, commentsPage, episodesPage, inboxPage, notFoundPage, overviewPage, type ChannelStatus } from "./views.js";

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
    pull?(): Promise<void>;
  };
  /** Character creation and the episode pipeline. Omitted: those pages say how to enable them. */
  studio?: Studio;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20_000) throw new Error("Form too large");
  }
  return new URLSearchParams(raw);
}

const redirect = (res: ServerResponse, to: string) => {
  res.writeHead(303, { Location: to });
  res.end();
};

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

export function handler(opts: DashboardOptions) {
  const page = (res: ServerResponse, status: number, html: string) =>
    send(res, status, opts.banner ? html.replace("<main>", `<main><div class="notice">${opts.banner}</div>`) : html);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = decodeURIComponent(url.pathname);
    try {
      if (req.method === "POST" && path === "/inbox/refresh") {
        await opts.inbox?.pull?.();
        return redirect(res, "/inbox");
      }
      const r = req.method === "POST" ? path.match(/^\/inbox\/(.+)\/reply$/) : null;
      if (r) {
        const id = r[1];
        const back = `/inbox?c=${encodeURIComponent(id)}`;
        const c = loadState(opts).inbox.find((x) => x.id === id);
        if (!c || !opts.inbox) return redirect(res, back + "&err=" + encodeURIComponent("Không tìm thấy hội thoại."));
        try {
          const sent = await opts.inbox.send(c, (await readForm(req)).get("text") ?? "");
          await appendMessage(opts.dataDir, id, sent);
          return redirect(res, back);
        } catch (e) {
          return redirect(res, back + "&err=" + encodeURIComponent(e instanceof Error ? e.message : String(e)));
        }
      }
      const st = opts.studio;
      const fail = (to: string, e: unknown) => redirect(res, `${to}${to.includes("?") ? "&" : "?"}err=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`);
      if (req.method === "POST" && st) {
        if (path === "/characters/new") {
          const idea = (await readForm(req)).get("idea") ?? "";
          try {
            return redirect(res, `/characters/${await st.newCharacter(idea)}`);
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
            return redirect(res, `/characters/${ap[1]}`);
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
        const back = req.headers.referer && new URL(req.headers.referer).host === req.headers.host ? req.headers.referer : "/comments";
        res.writeHead(303, { Location: back });
        return void res.end();
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

      if (st && path.startsWith("/studio-media/")) {
        const file = inside(st.opts.episodesDir, path.slice("/studio-media/".length));
        return file && !file.includes(`${sep}layers${sep}`) ? sendFile(res, file, req.headers.range) : send(res, 404, notFoundPage());
      }
      const pm = path.match(/^\/portrait\/([a-z0-9-]+)\.svg$/);
      if (pm) return sendFile(res, join(opts.charactersDir ?? CHARACTERS_DIR, pm[1], "portrait.svg"));
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
      const err = url.searchParams.get("err") ?? undefined;
      if (path === "/characters/new") return page(res, 200, st ? newCharacterPage(st.opts.mock, err) : notFoundPage());
      if (path === "/studio") return page(res, 200, st ? studioPage(state, st, err) : notFoundPage());
      if (path === "/style") return page(res, 200, st ? stylePage(st, err) : notFoundPage());
      const sp = path.match(/^\/studio\/([a-z0-9-]+)$/);
      if (sp && st) {
        const html = episodeStudioPage(state, st, sp[1], err);
        return html ? page(res, 200, html) : page(res, 404, notFoundPage());
      }
      if (path === "/") return page(res, 200, overviewPage(state, opts.channel()));
      if (path === "/channels") return page(res, 200, channelsPage(state));
      const br = path.match(/^\/channels\/([a-z0-9-]+)$/);
      if (br) {
        const html = brandPage(state, br[1]);
        return html ? page(res, 200, html) : page(res, 404, notFoundPage());
      }
      if (path === "/characters") return page(res, 200, charactersPage(state));
      const ch = path.match(/^\/characters\/([a-z0-9-]+)$/);
      if (ch) {
        const c = state.characters.find((x) => x.profile.slug === ch[1]);
        const job = st?.jobs.get(`sheet:${ch[1]}`);
        return c ? page(res, 200, characterPage(c, st ? { canDraw: true, drawing: job?.running ? (job.step ?? "bắt đầu…") : undefined, error: err ?? job?.error } : undefined)) : page(res, 404, notFoundPage());
      }
      if (path === "/inbox") {
        const q = url.searchParams;
        return page(res, 200, inboxPage(state, { selected: q.get("c") ?? undefined, error: q.get("err") ?? undefined, canPull: Boolean(opts.inbox?.pull) }));
      }
      if (path === "/episodes") return page(res, 200, episodesPage(state));
      if (path === "/automation") return page(res, 200, automationPage(state, Boolean(st)));
      if (path === "/comments") {
        const q = url.searchParams;
        return page(res, 200, commentsPage(state, { q: q.get("q") ?? undefined, platform: q.get("platform") || undefined, episode: q.get("episode") || undefined, brand: q.get("brand") || undefined, picked: q.get("picked") === "1" }));
      }
      if (path === "/api/state") {
        const { byPost: _, comics, ...rest } = state;
        return send(res, 200, JSON.stringify({ ...rest, comics: [...comics.values()] }), TYPES[".json"]);
      }
      return send(res, 404, notFoundPage());
    } catch (e) {
      console.error(e);
      return send(res, 500, `<pre>${String(e instanceof Error ? e.message : e).replace(/</g, "&lt;")}</pre>`);
    }
  };
}

export function startDashboard(opts: DashboardOptions, port: number, host = "127.0.0.1"): Promise<Server> {
  const server = createServer(handler(opts));
  return new Promise((ok) => server.listen(port, host, () => ok(server)));
}

export const defaultPaths = (root: string, env = process.env): Paths => ({
  dataDir: resolve(root, env.CHANNEL_DATA_DIR || "data"),
  runsDir: join(root, "output", "characters"),
});
