/**
 * HTTP server for the dashboard. Reads state from disk on every request, so
 * whatever the channel or studio CLIs just wrote shows up on refresh.
 */

import { siteUrl } from "./phone.js";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { BOLD_FONT_PATH, DEFAULT_FONT_PATH } from "@hoi-sau/svg-text";
import { addCharacterBrand, type Conversation, type InboxMessage, type Platform } from "@hoi-sau/channel";
import { NeedsSetup, type Accounts } from "./accounts.js";
import type { Backup } from "./backup.js";
import { editCharacterPage, newCharacterPage, saveCharacter } from "./characters.js";
import { appendMessage, brandArtDir, loadState, toggleDirection, type Paths } from "./data.js";
import { isSignedIn, passwordMatches, sessionCookie } from "./auth.js";
import { pickLang, t, withLang, type Lang } from "./i18n.js";
import { characterNotes, compareSection, inspirationField, researchPage, type IdeaKind, IDEA_KINDS, type Research } from "./research.js";
import { episodeStudioPage, friendly, Studio, studioPage, stylePage } from "./studio.js";
import { ideaPage, leadFromText, videoPage, videosPage, type Videos } from "./video.js";
import { CHARACTERS_DIR, loadProfile, readStep, SERIES_DIR, type EpisodeStep } from "@hoi-sau/studio";
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
  loginPage,
  notFoundPage,
  overviewPage,
  settingsPage,
  type Abilities,
  type BrandControls,
  type ChannelStatus,
} from "./views.js";
import { Insights, performancePage } from "./performance.js";
import { fromLocalField, planFromForm, postedClips, schedulePage, type Schedule } from "./schedule.js";
import { addHouseRule, isArea, removeHouseRule, rulesPage } from "./rules.js";
import { statfsSync } from "node:fs";

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
  /** Copies of what lives only on this machine, shown and run from Settings. */
  backup?: Backup;
  channel: () => ChannelStatus;
  /** When set, every page but /login and /static asks for it. Set it whenever the dashboard is online. */
  password?: string;
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
  /** Video: clips made from a sample clip, checked shot by shot, approved and posted. */
  videos?: Videos;
  /** Settings, account connection, pulling comments, channel on/off. */
  accounts?: Accounts;
  /** Tư liệu: the moodboard and what each episode learned from it. */
  research?: Research;
  /** Sample data: buttons that would change real accounts say so instead. */
  demo?: boolean;
  /** Pulls fresh numbers for the Hiệu suất page. Omitted: the page shows what was pulled before. */
  insights?: Insights;
  /** Lịch đăng: the clips' posting times (Windows tasks, or the plan file). */
  schedule?: Schedule;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 50_000) throw new Error("Form too large");
  }
  return new URLSearchParams(raw);
}

/** Multipart upload, parsed by the platform's own Request; files over the limit are refused. */
async function readUpload(req: IncomingMessage, limit = 40 * 1024 * 1024): Promise<FormData> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error(t("Ảnh lớn quá (tối đa 15 MB)."));
    chunks.push(chunk as Buffer);
  }
  return new Request("http://local/upload", { method: "POST", headers: { "content-type": String(req.headers["content-type"] ?? "") }, body: Buffer.concat(chunks) }).formData();
}

const redirect = (res: ServerResponse, to: string) => {
  res.writeHead(303, { Location: to });
  res.end();
};

/** `to` with ?ok= or ?err= added, for the one-line result on the next page. */
/** Adds ?ok= or ?err= to a link, before its #part: after the hash the page never sees it. */
export const withNote = (to: string, key: "ok" | "err", text: string) => {
  const h = to.indexOf("#");
  const [path, hash] = h < 0 ? [to, ""] : [to.slice(0, h), to.slice(h)];
  return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(text)}${hash}`;
};

function send(res: ServerResponse, status: number, body: string, type = "text/html; charset=utf-8"): void {
  // no-cache, not no-store: the page is still fetched fresh, but Back can restore it instantly.
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-cache" });
  res.end(body);
}

/** Every picture on a page asks for a WebP sized to how it is shown; the full file stays one click away. */
const sizedImages = (html: string) =>
  html.replace(
    /<img([^>]*?) src="(\/(?:studio-media|sheet|media|brand-art|style-media|series-media|research-media|video-media)\/[^"?]+\.(?:png|jpe?g|webp))"/g,
    (_, pre: string, src: string) => `<img${pre} decoding="async" src="${src}?w=${/^\/(sheet|brand-art)\//.test(src) ? 1400 : /^\/video-media\//.test(src) ? 640 : 960}"`,
  );

/** Widths an image may be asked for with ?w=, so a page never pulls a 3 MB sheet for a thumbnail. */
const WIDTHS = [320, 640, 960, 1400];
const resized = new Map<string, Promise<Buffer>>();

/**
 * The head and shoulders of the first figure on a model sheet (the front view, top left).
 * Sheets differ in how many views they have, so the figure is found by its columns of ink.
 */
async function faceCrop(file: string): Promise<Buffer> {
  const { data, info } = await sharp(file).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const half = Math.round(H / 2);
  const ink = (x: number, y: number) => data[y * W + x] < 200;
  const colInk = (x: number) => {
    for (let y = 0; y < half; y += 2) if (ink(x, y)) return true;
    return false;
  };
  let x0 = 0;
  while (x0 < W && !colInk(x0)) x0++;
  // The figure ends at the first gap of blank columns wide enough to separate two views.
  let x1 = x0, gap = 0;
  for (let x = x0; x < W && gap < Math.round(W / 80); x++) colInk(x) ? ((x1 = x), (gap = 0)) : gap++;
  // Views that touch (a tail over the next view) leave no gap: fall back to the first quarter.
  if (x1 - x0 > W / 3) x1 = x0 + Math.round(W / 4.5);
  let y0 = 0;
  const rowInk = (y: number) => {
    for (let x = x0; x <= x1; x += 2) if (ink(x, y)) return true;
    return false;
  };
  while (y0 < half && !rowInk(y0)) y0++;
  const w = Math.max(1, x1 - x0 + 1);
  const pad = Math.round(w * 0.06);
  const left = Math.max(0, x0 - pad), top = Math.max(0, y0 - pad);
  const size = Math.min(w + 2 * pad, W - left, H - top);
  return sharp(file).extract({ left, top, width: size, height: size }).png().toBuffer();
}

/** A smaller WebP copy of an image, kept in memory and keyed by the file's mtime so a redraw shows up. */
function resizedImage(file: string, mtime: number, width: number, crop?: "face"): Promise<Buffer> {
  const key = `${file}|${mtime}|${width}|${crop ?? ""}`;
  let hit = resized.get(key);
  if (!hit) {
    hit = (async () => {
      const img = crop === "face" ? sharp(await faceCrop(file)).resize(width, width) : sharp(file).resize({ width, withoutEnlargement: true });
      return img.webp({ quality: 82 }).toBuffer();
    })();
    if (resized.size > 300) resized.delete(resized.keys().next().value!);
    resized.set(key, hit);
    hit.catch(() => resized.delete(key));
  }
  return hit;
}

/**
 * Serves a file with an ETag, so a page change only revalidates what it already has.
 * ?w= on an image returns a WebP no wider than that; ?v= marks a versioned asset that never changes.
 * Honours a single byte Range, which Safari needs to play video.
 */
async function sendFile(req: IncomingMessage, res: ServerResponse, file: string, crop?: "face"): Promise<void> {
  if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, notFoundPage());
  const q = new URL(req.url ?? "/", "http://localhost").searchParams;
  const st = statSync(file);
  const ext = extname(file).toLowerCase();
  const asked = Number(q.get("w")) || (crop ? 320 : 0);
  const width = asked && /^\.(png|jpe?g|webp)$/.test(ext) ? (WIDTHS.find((w) => w >= asked) ?? WIDTHS[WIDTHS.length - 1]) : 0;
  const etag = `W/"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}${width ? `-${width}${crop ?? ""}` : ""}"`;
  const cache = q.has("v") ? "public, max-age=31536000, immutable" : "no-cache";
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag, "Cache-Control": cache });
    return void res.end();
  }
  if (width) {
    const body = await resizedImage(file, st.mtimeMs, width, crop);
    res.writeHead(200, { "Content-Type": "image/webp", "Content-Length": body.length, ETag: etag, "Cache-Control": cache });
    return void res.end(body);
  }
  const type = TYPES[ext] ?? "application/octet-stream";
  const size = st.size;
  // ?dl=1: save the file instead of playing it (phones and browsers otherwise only play an mp4).
  if (q.get("dl") === "1") res.setHeader("Content-Disposition", `attachment; filename="${basename(file).replace(/[^\w.-]/g, "_")}"`);
  const m = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
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
  res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": size, ETag: etag, "Cache-Control": cache });
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
    send(res, status, sizedImages(opts.banner ? html.replace("<main>", `<main><div class="notice demo-note">${t(opts.banner)}</div>`) : html));
  /** A new character gets its own channel on the Kênh page right away (every account still to connect). */
  const withBrand = (slug: string) => {
    if (opts.brandsFile) {
      const p = loadProfile(slug, charactersDir());
      addCharacterBrand({ slug, name: p.name, tagline: p.office_type }, opts.brandsFile);
    }
    return slug;
  };
  const loadProfileSafe = (slug: string) => {
    try {
      return loadProfile(slug, charactersDir());
    } catch {
      return undefined;
    }
  };
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

    if (path === "/performance/refresh" && req.method === "POST") {
      opts.insights?.refresh();
      return redirect(res, "/performance");
    }

    // Lịch đăng and Luật nhà.
    if (path === "/schedule" && req.method === "POST" && opts.schedule) {
      const form = await readForm(req);
      const listing = opts.schedule.list();
      // Clips made in the Video screen keep their own time, posted by the dashboard.
      let moved = 0;
      const videos = opts.videos;
      for (const m of videos?.scheduled() ?? []) {
        if (form.getAll("vdrop").includes(m.id)) (videos!.setWhen(m.id), moved++);
        else {
          const at = fromLocalField(form.get(`vat:${m.id}`) ?? "");
          if (at && at !== m.when) (videos!.setWhen(m.id, at), moved++);
        }
      }
      if (listing.unknown.length && moved) return redirect(res, withNote("/schedule", "ok", t("Đã đổi giờ {n} clip làm trong dashboard.", { n: moved })));
      if (listing.unknown.length) return redirect(res, withNote("/schedule", "err", t("Có lịch không đọc được trên máy, nên chưa sửa được từ đây.")));
      const posted = postedClips(loadState(opts));
      const plan = planFromForm(form, listing.slots.filter((x) => !posted.has(x.id)));
      const r = opts.schedule.save(plan);
      if (r.message) return redirect(res, withNote("/schedule", "err", t("Đã lưu lịch nhưng chưa cài được vào máy: {m}. Mở dashboard bằng quyền quản trị (Run as administrator) rồi bấm Lưu lịch lần nữa.", { m: r.message })));
      return redirect(res, withNote("/schedule", "ok", r.installed ? t("Đã lưu và cài {n} bài vào lịch của máy.", { n: plan.length }) : t("Đã lưu lịch {n} bài.", { n: plan.length })));
    }
    if (path === "/rules" && req.method === "POST") {
      const form = await readForm(req);
      const area = form.get("area");
      try {
        if (!isArea(area)) throw new Error(t("Chọn loại luật."));
        addHouseRule(area, form.get("text") ?? "", "dashboard");
        return redirect(res, withNote("/rules", "ok", t("Đã thêm luật. Từ giờ máy sẽ làm theo.")));
      } catch (e) {
        return fail("/rules", e);
      }
    }
    const rd = req.method === "POST" ? path.match(/^\/rules\/([A-Za-z0-9]+)\/delete$/) : null;
    if (rd) {
      removeHouseRule(rd[1]);
      return redirect(res, withNote("/rules", "ok", t("Đã bỏ luật.")));
    }

    // Settings and accounts.
    if (path === "/settings/backup" && req.method === "POST") {
      if (!opts.backup) return redirect(res, "/settings");
      try {
        return redirect(res, withNote("/settings", "ok", t("Đã sao lưu: {name}", { name: opts.backup.run() })));
      } catch (e) {
        return redirect(res, withNote("/settings", "err", (e as Error).message));
      }
    }
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
      return page(res, 200, settingsPage(settings, { demo: Boolean(opts.demo || !acc), mock: Boolean(opts.studio?.opts.mock), ok, error: err, backup: opts.backup?.info() }));
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
    if (path === "/connect/tiktok") {
      const brand = q.get("brand") ?? "hoi-sau";
      if (!acc || opts.demo) return redirect(res, withNote(`/channels/${brand}`, "err", t("Đang xem dữ liệu mẫu nên không kết nối tài khoản thật.")));
      try {
        const port = Number(String(req.headers.host ?? "").split(":")[1]) || 80;
        return redirect(res, acc.startTikTok(brand, port));
      } catch (e) {
        return fail(`/channels/${brand}`, e);
      }
    }
    if (path === "/connect/tiktok/callback" && acc) {
      const state = q.get("state") ?? "";
      const brand = acc.tiktokLoginBrand(state) ?? "hoi-sau";
      const denied = q.get("error_description") ?? q.get("error");
      if (denied) return redirect(res, withNote(`/channels/${brand}`, "err", t("TikTok chưa cho phép: {m}", { m: denied })));
      try {
        const done = await acc.finishTikTok(state, q.get("code") ?? "");
        const note = done.missing.length
          ? t("Đã kết nối TikTok {name}, nhưng thiếu quyền {m}. Bấm Kết nối lại và cho phép hết.", { name: done.name, m: done.missing.join(", ") })
          : t("Đã kết nối TikTok {name}.", { name: done.name });
        return redirect(res, withNote(`/channels/${done.brand}`, done.missing.length ? "err" : "ok", note));
      } catch (e) {
        return fail(`/channels/${brand}`, e);
      }
    }
    const ttd = req.method === "POST" ? path.match(/^\/channels\/([a-z0-9-]+)\/tiktok\/draft$/) : null;
    if (ttd && acc && !opts.demo) {
      try {
        const link = ((await readForm(req)).get("url") ?? "").trim();
        if (!isOwnMedia(link)) throw new Error(t("Chỉ gửi được video trên trang Hồi Sau (link {site}/media/…).", { site: siteUrl() }));
        await acc.sendTikTokDraft(ttd[1], { url: link });
        return redirect(res, withNote(`/channels/${ttd[1]}`, "ok", t("Đã gửi vào hộp nháp TikTok. Mở app TikTok, thêm chú thích và nhạc rồi đăng.")));
      } catch (e) {
        return fail(`/channels/${ttd[1]}`, e);
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
    const cs = req.method === "POST" ? path.match(/^\/channels\/([a-z0-9-]+)\/(facebook|instagram|threads|tiktok)\/status$/) : null;
    if (cs && acc && !opts.demo) {
      try {
        const status = (await readForm(req)).get("status") as "live" | "paused" | "planned";
        acc.setStatus(cs[1], cs[2] as Platform, status);
        return redirect(res, withNote(`/channels/${cs[1]}`, "ok", t(status === "live" ? "Đã bật kênh." : "Đã tạm dừng kênh.")));
      } catch (e) {
        return fail(`/channels/${cs[1]}`, e);
      }
    }
    if (req.method === "POST" && (thr || cs || ttd)) return redirect(res, withNote(`/channels/${(thr ?? cs ?? ttd)![1]}`, "err", t("Đang xem dữ liệu mẫu nên không đổi tài khoản thật.")));

    // Tư liệu.
    const rs = opts.research;
    if (rs && req.method === "POST" && path.startsWith("/research/")) {
      const brand = q.get("brand") || "hoi-sau";
      const to = `/research?brand=${encodeURIComponent(brand)}`;
      try {
        if (path === "/research/upload") {
          const form = await readUpload(req);
          const link = String(form.get("link") ?? "").trim();
          if (link && !/^https?:\/\//i.test(link)) throw new Error(t("Link bài gốc phải bắt đầu bằng http."));
          const files = form.getAll("files").filter((f): f is File => typeof f !== "string" && f.size > 0);
          if (!files.length) throw new Error(t("Chưa chọn ảnh."));
          let added = 0;
          for (const f of files) if (rs.add(brand, Buffer.from(await f.arrayBuffer()), { from: "upload", link: link || undefined }).added) added++;
          if (!added) return redirect(res, withNote(to, "ok", t("Ảnh này đã có trong tư liệu.")));
          // With the AI ready, reading starts at once: one drop, and the recipes follow.
          if (!opts.studio || opts.studio.ready) {
            rs.readNew(brand);
            return redirect(res, withNote(to, "ok", t("Đã thêm {n} ảnh. AI đang đọc để rút công thức.", { n: added })));
          }
          return redirect(res, withNote(to, "ok", t("Đã thêm {n} ảnh. Thêm khoá AI Muse ở Cài đặt để AI đọc.", { n: added })));
        }
        const form = await readForm(req);
        if (path === "/research/text") {
          const link = String(form.get("link") ?? "").trim();
          if (link && !/^https?:\/\//i.test(link)) throw new Error(t("Link bài gốc phải bắt đầu bằng http."));
          const { added } = rs.addText(brand, form.get("text") ?? "", { from: "text", link: link || undefined });
          if (!added) return redirect(res, withNote(to, "ok", t("Câu này đã có trong tư liệu.")));
          if (!opts.studio || opts.studio.ready) {
            rs.readNew(brand);
            return redirect(res, withNote(to, "ok", t("Đã thêm. AI đang rút mẫu câu.")));
          }
          return redirect(res, withNote(to, "ok", t("Đã thêm. Thêm khoá AI Muse ở Cài đặt để AI đọc.")));
        }
        if (path === "/research/threads") {
          const n = await rs.learnThreads(brand);
          if (!n) return redirect(res, withNote(to, "ok", t("Chưa có reply Threads mới.")));
          if (!opts.studio || opts.studio.ready) rs.readNew(brand);
          return redirect(res, withNote(to, "ok", t("Đã lấy {n} reply Threads mới.", { n })));
        }
        if (path === "/research/instagram") {
          const n = await rs.importInstagram(brand, form.get("account") ?? "");
          return redirect(res, withNote(to, "ok", n ? t("Đã lấy {n} bài mới.", { n }) : t("Các bài này đã có trong tư liệu.")));
        }
        if (path === "/research/read") {
          if (opts.studio && !opts.studio.ready) throw new NeedsSetup(t("Chưa có khoá AI Muse. Vào Cài đặt để thêm."));
          rs.readNew(brand);
          return redirect(res, to);
        }
        if (path === "/research/pin") {
          const pin = form.get("to");
          rs.pin(brand, form.get("idea") ?? "", pin === "next" ? { to: "next" } : pin === "character" ? { to: "character", slug: form.get("slug") ?? "" } : undefined);
          return redirect(res, back(to));
        }
        if (path === "/research/remove") {
          rs.remove(brand, form.get("clip") ?? "");
          return redirect(res, back(to));
        }
      } catch (e) {
        return fail(to, e);
      }
    }
    if (rs && path === "/research") {
      const state = loadState(opts);
      const brands = state.brands.map((b) => ({ id: b.brand.id, name: b.brand.name }));
      const brand = brands.some((b) => b.id === q.get("brand")) ? q.get("brand")! : (brands[0]?.id ?? "hoi-sau");
      const kind = IDEA_KINDS.find((k) => k === q.get("kind")) as IdeaKind | undefined;
      const cast = state.characters.map((c) => ({ slug: c.profile.slug, name: c.profile.name, src: charSrc(c) }));
      const canDiscover = Boolean(opts.demo || acc?.anyPage());
      return page(res, 200, researchPage(rs, { brands, cast, brand, kind, canDiscover, canThreads: Boolean(rs.opts.threadsReplies), ready: opts.studio ? opts.studio.ready : true, demo: Boolean(opts.demo), ok, error: err }));
    }
    if (rs && path.startsWith("/research-media/")) {
      const file = inside(rs.opts.dir, path.slice("/research-media/".length));
      return file && /[\\/]files[\\/][a-f0-9]+\.(png|jpe?g|webp)$/.test(file) ? sendFile(req, res, file) : send(res, 404, notFoundPage());
    }

    // Characters: the form works without Muse; drawing and the AI writer need Studio.
    if (path === "/characters/new/manual" && req.method === "POST") {
      try {
        return redirect(res, withNote(`/characters/${withBrand(saveCharacter(await readForm(req), charactersDir()))}`, "ok", t("Đã tạo nhân vật. Bước tiếp: vẽ bản chuẩn.")));
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
    const vd = opts.videos;
    if (vd && req.method === "POST" && path === "/video/idea") {
      try {
        const form = await readUpload(req, 300 * 1024 * 1024);
        const text = String(form.get("text") ?? "");
        const all = [...form.getAll("files"), ...form.getAll("images")].filter((f): f is File => f instanceof File && f.size > 0);
        const isVideo = (f: File) => f.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name);
        const clip = all.find(isVideo);
        const sample = String(form.get("sample") ?? "");
        // A clip (uploaded or a sample) becomes a talking video at once: lead from the note, Tũn otherwise.
        if (clip || sample) {
          const upload = clip ? { name: clip.name, bytes: new Uint8Array(await clip.arrayBuffer()) } : undefined;
          const title = text.trim().split(/\r?\n/)[0].slice(0, 40) || (clip?.name ?? sample.split(/[\\/]/).pop() ?? "").replace(/\.[a-z0-9]+$/i, "") || t("Clip mới");
          const id = vd.create({ kind: "illustrate", slug: leadFromText(text, vd.opts.cast()), mouth: true, title, sample: clip ? undefined : sample, upload });
          return redirect(res, `/video/${id}`);
        }
        const images = await Promise.all(all.filter((f) => !isVideo(f)).slice(0, 4).map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
        const want = String(form.get("want") ?? "");
        const id = vd.newIdea(text, images, want === "meme" || want === "comic" ? want : "");
        return redirect(res, `/video/idea/${id}`);
      } catch (e) {
        return fail("/video", e);
      }
    }
    const vi = vd ? path.match(/^\/video\/idea\/(y-[a-z0-9-]+)(\/again)?$/) : null;
    if (vi && vd) {
      if (req.method === "POST" && vi[2]) {
        try {
          vd.rereadIdea(vi[1]);
        } catch (e) {
          return fail(`/video/idea/${vi[1]}`, e);
        }
        return redirect(res, `/video/idea/${vi[1]}`);
      }
      if (req.method === "GET") {
        const html = ideaPage(vd, vi[1], Boolean(opts.studio), err);
        return html ? page(res, 200, html) : page(res, 404, notFoundPage());
      }
    }
    if (vd && req.method === "POST" && path === "/video/new") {
      try {
        const form = await readUpload(req, 300 * 1024 * 1024);
        const file = form.get("clip");
        const upload = file instanceof File && file.size ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : undefined;
        const field = (k: string) => String(form.get(k) ?? "");
        const meme = field("kind") === "meme"
          ? { top: field("top"), punch: field("punch"), scenes: field("scenes") === "1" ? [field("scene1")] : [field("scene1"), field("scene2")], music: field("music"), seconds: Number(field("seconds")) || 0 }
          : undefined;
        const id = vd.create({ kind: meme ? "meme" : "illustrate", slug: field("slug"), mouth: form.get("mouth") === "1", title: field("title"), sample: field("sample") || undefined, upload, meme, caption: field("caption") });
        return redirect(res, `/video/${id}`);
      } catch (e) {
        return fail("/video", e);
      }
    }
    const va = vd && req.method === "POST" ? path.match(/^\/video\/([a-z0-9-]+)\/(continue|render|okall|approve|publish|addshot|ask|askdrop|apply|keep|undo)$/) : null;
    if (va && vd) {
      const [, id, act] = va;
      try {
        if (act === "ask") {
          const form = await readForm(req);
          vd.ask(id, form.get("note") ?? "", form.get("at") ?? "");
          if (form.get("rule") === "1" && (form.get("note") ?? "").trim()) addHouseRule("video", form.get("note")!, `video ${id}`);
          return redirect(res, `/video/${id}#fix`);
        }
        if (act === "apply") {
          const form = await readForm(req);
          vd.apply(id, form.getAll("pick").map(Number));
          return redirect(res, `/video/${id}#fix`);
        }
        if (act === "askdrop" || act === "keep" || act === "undo") {
          if (act === "askdrop") vd.dropAsk(id);
          if (act === "keep") vd.keep(id);
          if (act === "undo") vd.undo(id);
          return redirect(res, `/video/${id}#fix`);
        }
        if (act === "addshot") {
          const form = await readForm(req);
          const shot = vd.addShot(id, { t: form.get("t") ?? "", act: form.get("act") ?? "", pose: form.get("pose") ?? "", bubble: form.get("bubble") ?? "" });
          return redirect(res, `/video/${id}#${shot}`);
        }
        if (act === "continue") vd.continue(id);
        if (act === "render") vd.render(id);
        if (act === "okall") {
          for (const shot of vd.unchecked(id)) vd.tick(id, shot);
          vd.render(id);
        }
        if (act === "publish") {
          if (opts.demo) throw new Error(t("Đang xem dữ liệu mẫu nên không đăng thật."));
          vd.publish(id);
        }
        if (act === "approve") {
          const form = await readForm(req);
          await vd.approve(id, { caption: form.get("caption") ?? "", threadsCaption: form.get("threadsCaption") ?? "", version: form.get("version") === "mouth" ? "mouth" : "plain", still: form.getAll("still"), when: form.get("when") ?? "", cover: form.get("cover") ?? undefined });
          return redirect(res, withNote(`/video/${id}#approve`, "ok", t("Đã duyệt. Bấm Đăng ngay, hoặc để máy tự đăng đúng giờ hẹn.")));
        }
        return redirect(res, `/video/${id}`);
      } catch (e) {
        return fail(`/video/${id}${act === "approve" ? "#approve" : act === "addshot" ? "#add-shot" : ["ask", "apply", "askdrop", "keep", "undo"].includes(act) ? "#fix" : ""}`, e);
      }
    }
    const vs = vd && req.method === "POST" ? path.match(/^\/video\/([a-z0-9-]+)\/shot\/([a-z0-9-]+)\/(ok|redraw|fix|undo|remove|repose|onepose|nomouth|edit)$/) : null;
    if (vs && vd) {
      const [, id, shot, act] = vs;
      try {
        const form = await readForm(req);
        if (act === "ok") vd.tick(id, shot);
        if (act === "redraw") vd.redraw(id, shot, form.get("note") ?? "");
        if (act === "fix") vd.fixDetail(id, shot, form.get("note") ?? "");
        if (act === "undo") vd.undoFix(id, shot);
        if (act === "remove") {
          vd.removeShot(id, shot);
          return redirect(res, `/video/${id}`);
        }
        if (act === "repose") vd.redrawPose(id, shot);
        if (act === "onepose") vd.onePose(id, shot);
        if (act === "nomouth") vd.noMouth(id, shot);
        if (act === "edit") {
          const lines: Record<number, string> = {}, starts: Record<number, string> = {}, ends: Record<number, string> = {};
          for (const [k, v] of form) {
            if (k.startsWith("line-")) lines[Number(k.slice(5))] = v;
            if (k.startsWith("start-")) starts[Number(k.slice(6))] = v;
            if (k.startsWith("end-")) ends[Number(k.slice(4))] = v;
          }
          vd.editShot(id, shot, {
            act: form.get("act") ?? undefined,
            pose: form.get("pose") ?? undefined,
            bubble: form.get("bubble") ?? undefined,
            lines,
            starts,
            ends,
            drop: form.getAll("drop").map(Number),
            add: { text: form.get("add-text") ?? "", start: form.get("add-start") ?? "", end: form.get("add-end") ?? "" },
            t: form.get("t") ?? undefined,
          });
        }
        return redirect(res, `/video/${id}#${shot}`);
      } catch (e) {
        return fail(`/video/${id}#${shot}`, e);
      }
    }
    if (req.method === "POST" && st) {
      if (path === "/characters/new") {
        const idea = (await readForm(req)).get("idea") ?? "";
        try {
          return redirect(res, withNote(`/characters/${withBrand(await st.newCharacter(idea))}`, "ok", t("Đã tạo nhân vật. Bước tiếp: vẽ bản chuẩn.")));
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
          return redirect(res, withNote(`/characters/${ap[1]}`, "ok", t("Đã chốt bản vẽ chuẩn.")));
        } catch (e) {
          return fail(`/characters/${ap[1]}`, e);
        }
      }
      if (path === "/studio/new") {
        const form = await readForm(req);
        const ideas = form.getAll("idea");
        try {
          if (rs && ideas.length && form.get("direction")?.trim()) form.set("direction", `${form.get("direction")!.trim()}${rs.recipes(ideas)}`);
          const id = st.newEpisode(form);
          rs?.attach(ideas, id);
          // From "Làm từ chữ hoặc ảnh": the owner already checked the idea, so the episode starts at once.
          if (form.get("run") === "1") st.run(id, {});
          return redirect(res, `/studio/${id}`);
        } catch (e) {
          return fail("/studio", e);
        }
      }
      const fx = path.match(/^\/studio\/([a-z0-9-]+)\/fix\/(ask|apply|drop|keep|undo)$/);
      if (fx) {
        const [, id, act] = fx;
        try {
          const form = await readForm(req);
          if (act === "ask") st.askFix(id, form.get("note") ?? "", form.get("rule") === "1");
          if (act === "apply") st.applyFix(id, form.getAll("pick").map(Number));
          if (act === "drop") st.dropFix(id);
          if (act === "keep") st.keepFix(id);
          if (act === "undo") st.undoFix(id);
          return redirect(res, `/studio/${id}#fix`);
        } catch (e) {
          return fail(`/studio/${id}#fix`, e);
        }
      }
      const sf = path.match(/^\/studio\/([a-z0-9-]+)\/safety$/);
      if (sf) {
        try {
          st.checkSafety(sf[1]);
          return redirect(res, `/studio/${sf[1]}#review`);
        } catch (e) {
          return fail(`/studio/${sf[1]}`, e);
        }
      }
      const apv = path.match(/^\/studio\/([a-z0-9-]+)\/approve$/);
      if (apv) {
        const form = await readForm(req);
        try {
          st.approveEpisode(apv[1], form.get("despite") === "1");
          return redirect(res, withNote(`/studio/${apv[1]}`, "ok", t("Đã duyệt tập. Giờ có thể đăng.")));
        } catch (e) {
          return fail(`/studio/${apv[1]}`, e);
        }
      }
      const tk = path.match(/^\/studio\/([a-z0-9-]+)\/tiktok$/);
      if (tk) {
        try {
          if (!acc || opts.demo) throw new Error(t("Đang xem dữ liệu mẫu nên không kết nối tài khoản thật."));
          const reel = join(st.opts.episodesDir, tk[1], "motion", "reel.mp4");
          if (!existsSync(reel)) throw new Error(t("Tập này chưa có video."));
          const sent = await acc.sendTikTokDraft("hoi-sau", { file: new Uint8Array(readFileSync(reel)) }, { id: tk[1] });
          return redirect(res, withNote(`/studio/${tk[1]}`, "ok", t(sent.again ? "Video này đã ở hộp nháp TikTok rồi." : "Đã gửi vào hộp nháp TikTok. Mở app TikTok, thêm chú thích và nhạc rồi đăng.")));
        } catch (e) {
          return fail(`/studio/${tk[1]}`, e);
        }
      }
      const cmp = path.match(/^\/studio\/([a-z0-9-]+)\/compare$/);
      if (cmp && rs) {
        try {
          rs.compare(cmp[1], finishedPages(st, cmp[1]));
          return redirect(res, `/studio/${cmp[1]}`);
        } catch (e) {
          return fail(`/studio/${cmp[1]}`, e);
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
      if (FONTS[name]) return sendFile(req, res, FONTS[name]);
      const file = inside(STATIC_DIR, name);
      return file ? sendFile(req, res, file) : send(res, 404, notFoundPage());
    }
    if (path.startsWith("/media/")) {
      const file = inside(opts.runsDir, path.slice("/media/".length));
      // ?face cuts the front view from a sheet that is drawn but not locked yet.
      return file ? sendFile(req, res, file, url.searchParams.has("face") ? "face" : undefined) : send(res, 404, notFoundPage());
    }
    if (path.startsWith("/brand-art/")) {
      const file = inside(st?.brandArtDir ?? brandArtDir(opts), path.slice("/brand-art/".length));
      return file && /[\\/](avatar|cover|cover-title)\.png$/.test(file) ? sendFile(req, res, file) : send(res, 404, notFoundPage());
    }

    if (vd && path.startsWith("/video-media/")) {
      const file = inside(vd.opts.dir, path.slice("/video-media/".length));
      return file && /\.(png|jpe?g|mp4)$/.test(file) ? sendFile(req, res, file) : send(res, 404, notFoundPage());
    }
    if (st && path.startsWith("/studio-media/")) {
      const file = inside(st.opts.episodesDir, path.slice("/studio-media/".length));
      return file && !file.includes(`${sep}layers${sep}`) ? sendFile(req, res, file) : send(res, 404, notFoundPage());
    }
    const fm = path.match(/^\/face\/([a-z0-9-]+)\.webp$/);
    if (fm) {
      const sheet = loadProfileSafe(fm[1])?.look.character_sheet;
      return sheet ? sendFile(req, res, join(charactersDir(), fm[1], sheet), "face") : send(res, 404, notFoundPage());
    }
    const pm = path.match(/^\/portrait\/([a-z0-9-]+)\.svg$/);
    if (pm) return sendFile(req, res, join(charactersDir(), pm[1], "portrait.svg"));
    if (path.startsWith("/sheet/")) {
      const file = inside(charactersDir(), path.slice("/sheet/".length));
      return file && /[\\/](model|pose)-sheet\.(png|jpe?g|webp)$/.test(file) ? sendFile(req, res, file) : send(res, 404, notFoundPage());
    }
    if (st && path.startsWith("/style-media/")) {
      const file = inside(st.styleDir, path.slice("/style-media/".length));
      return file && /\.(png|jpe?g|webp)$/.test(file) ? sendFile(req, res, file) : send(res, 404, notFoundPage());
    }
    if (st && path.startsWith("/series-media/")) {
      const file = inside(st.opts.seriesDir ?? SERIES_DIR, path.slice("/series-media/".length));
      return file && /[\\/]style-ref\.(png|jpe?g|webp)$/.test(file) ? sendFile(req, res, file) : send(res, 404, notFoundPage());
    }

    const state = loadState(opts);
    if (path === "/characters/new") return page(res, 200, newCharacterPage(Boolean(st?.opts.mock), Boolean(st?.ready), err, q.get("manual") === "1" || !st));
    if (path === "/studio") return page(res, 200, st ? studioPage(state, st, err, rs ? inspirationField(rs, state.characters.map((c) => c.profile)) : "") : notFoundPage());
    if (path === "/style") return page(res, 200, st ? stylePage(st, err) : notFoundPage());
    if (path === "/video") return page(res, 200, vd ? videosPage(vd, err, ok) : notFoundPage());
    const vp = path.match(/^\/video\/([a-z0-9-]+)$/);
    if (vp && vd) {
      const html = videoPage(vd, vp[1], err, ok);
      return html ? page(res, 200, html) : page(res, 404, notFoundPage());
    }
    const sp = path.match(/^\/studio\/([a-z0-9-]+)$/);
    if (sp && st) {
      const html = episodeStudioPage(state, st, sp[1], err, ok, rs ? compareSection(rs, sp[1], finishedPages(st, sp[1]).length > 0) : "");
      return html ? page(res, 200, html) : page(res, 404, notFoundPage());
    }
    if (path === "/") {
      const posted = postedClips(state);
      const upcoming = opts.schedule?.list().slots.filter((x) => !posted.has(x.id));
      let diskFreeGb: number | undefined;
      try {
        const f = statfsSync(opts.dataDir);
        diskFreeGb = (f.bavail * f.bsize) / 1024 ** 3;
      } catch {
        diskFreeGb = undefined;
      }
      const toReview = vd?.list().filter((m) => !m.posted && !vd.approved(m.id) && vd.plan(m.id) && !vd.jobs.get(m.id)?.running).length;
      return page(res, 200, overviewPage(state, opts.channel(), abilities(), ok, err, { upcoming, diskFreeGb, toReview }));
    }
    if (path === "/schedule" && opts.schedule)
      return page(res, 200, schedulePage(state, opts.schedule.list(), ok, err, (vd?.scheduled() ?? []).map((m) => ({ id: m.id, title: m.title, at: m.when!, caption: m.caption, cover: vd!.coverFile && existsSync(vd!.coverFile(m.id)) ? `/studio-media/${vd!.epId(m.id)}/cover.jpg` : undefined })), (id) => {
        const dir = st ? inside(st.opts.episodesDir, id) : null;
        const at = (f: string) => (dir && existsSync(join(dir, f)) ? `/studio-media/${id}/${f}` : undefined);
        return { video: at("video.mp4"), cover: at("cover.jpg") };
      }));
    if (path === "/rules") return page(res, 200, rulesPage(undefined, ok, err));
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
      const extra = rs ? characterNotes(rs, ch[1]) : "";
      return c ? page(res, 200, characterPage(c, st ? { canDraw: true, drawing: job?.running ? (job.step ?? t("bắt đầu…")) : undefined, error: err ?? job?.error, ok, extra } : { canDraw: false, ok, error: err, extra })) : page(res, 404, notFoundPage());
    }
    if (path === "/inbox") {
      return page(res, 200, inboxPage(state, { selected: q.get("c") ?? undefined, error: err, ok, canPull: Boolean(opts.inbox?.pull) ? !acc || acc.anyPage() : Boolean(opts.demo && acc), canConnect: abilities().canConnect }));
    }
    if (path === "/episodes") return page(res, 200, episodesPage(state));
    if (path === "/performance") return page(res, 200, performancePage(state, { refreshing: opts.insights?.running, canRefresh: Boolean(opts.insights), error: err ?? opts.insights?.error, ok }));
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
        const pw = opts.password;
        if (pw && path === "/login") {
          if (req.method !== "POST") return send(res, 200, loginPage());
          if (!passwordMatches(pw, (await readForm(req)).get("password") ?? "")) return send(res, 401, loginPage(t("Sai mật khẩu.")));
          res.writeHead(303, { Location: "/", "Set-Cookie": sessionCookie(pw) });
          return void res.end();
        }
        if (pw && path === "/logout") {
          res.writeHead(303, { Location: "/login", "Set-Cookie": sessionCookie(undefined) });
          return void res.end();
        }
        if (pw && !path.startsWith("/static/") && !path.startsWith("/lang/") && !isSignedIn(req, pw)) return redirect(res, "/login");
        await route(req, res, url, path);
      } catch (e) {
        console.error(e);
        if (!res.headersSent) send(res, 500, `<pre>${String(e instanceof Error ? e.message : e).replace(/</g, "&lt;")}</pre>`);
      }
    });
  };
}

/** Finished pages of an episode: the 4:5 page, else the lettered panels. */
function finishedPages(st: Studio, id: string): string[] {
  const letter = readStep<{ pages: Array<{ file: string }>; page?: string }>(id, "letter", st.opts.episodesDir);
  if (!letter) return [];
  const files = letter.page ? [letter.page] : letter.pages.map((p) => p.file);
  return files.map((f) => join(st.opts.episodesDir, id, f)).filter((f) => existsSync(f));
}

/** Videos on the series' own site only, so the dashboard never fetches an arbitrary address. */
function isOwnMedia(link: string): boolean {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return false;
  }
  // The same Firebase site answers on all three names.
  const own = new Set([new URL(siteUrl()).host, "hoisau.web.app", "hoisau.firebaseapp.com", "hoisau.dangtrantai.com"]);
  try {
    if (process.env.MEDIA_BASE_URL) own.add(new URL(process.env.MEDIA_BASE_URL).host);
  } catch {
    // A broken MEDIA_BASE_URL adds nothing.
  }
  return u.protocol === "https:" && own.has(u.host) && /\.(mp4|mov|webm)$/i.test(u.pathname);
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
