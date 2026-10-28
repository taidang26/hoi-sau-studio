/**
 * Everything the channel CLI does with accounts, behind buttons: app keys
 * typed into a form, Facebook Login in the browser, a Threads token pasted
 * once, pulling comments and messages, pausing a channel. Values go to .env
 * (never shown back, only whether each is set); statuses go to channels.yaml
 * with its comments kept.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { t } from "./i18n.js";
import {
  BRANDS_FILE,
  DEFAULT_GRAPH_VERSION,
  exchangeCodeForUserToken,
  exchangeLongLivedUserToken,
  exchangeThreadsLongLived,
  fetchConversations,
  fetchFacebookComments,
  fetchInstagramComments,
  fetchThreadsReplies,
  FileJournal,
  findBrand,
  GraphClient,
  GraphError,
  journalPath,
  listManagedPages,
  loadBrands,
  loadComments,
  loadInbox,
  loginDialogUrl,
  MAIN_BRAND,
  mergeComments,
  mergeConversations,
  saveComments,
  saveInbox,
  sendReply,
  THREADS_BASE_URL,
  threadsProfile,
  brandTargets,
  type Brand,
  type ChannelStatus,
  type Comment,
  type Conversation,
  type FetchLike,
  type InboxMessage,
  type ManagedPage,
  type Platform,
} from "@hoi-sau/channel";

/** Settings a person types in once. Labels are what Meta's own pages call them. */
export const SETTINGS = [
  { name: "META_APP_ID", label: "Mã ứng dụng Meta (App ID)", secret: false, help: "developers.facebook.com → Ứng dụng của bạn → Cài đặt → Thông tin cơ bản" },
  { name: "META_APP_SECRET", label: "Khoá bí mật ứng dụng (App Secret)", secret: true, help: "Cùng trang, bấm Hiện cạnh App Secret" },
  { name: "META_API_KEY", label: "Khoá AI Muse (viết và vẽ)", secret: true, help: "Khoá Llama API dùng cho Muse Spark và Muse Image" },
  { name: "BACKUP_DIR", label: "Thư mục sao lưu", secret: false, help: "Nên dán đường dẫn một thư mục OneDrive hoặc Google Drive, để còn bản sao khi máy hỏng" },
  { name: "THREADS_APP_SECRET", label: "Khoá bí mật ứng dụng Threads", secret: true, help: "Ứng dụng Threads → Cài đặt → Thông tin cơ bản" },
] as const;

export type SettingName = (typeof SETTINGS)[number]["name"];

/** A step the person must take first, shown as a friendly message with a link. */
export class NeedsSetup extends Error {
  constructor(message: string, readonly where = "/settings") {
    super(message);
  }
}

export interface AccountsOptions {
  envFile: string;
  dataDir: string;
  brandsFile?: string;
  graphVersion?: string;
  /** Fake Graph API for demo and tests. */
  fetch?: FetchLike;
  /** Sample data: nothing real is connected or changed on Meta. */
  demo?: boolean;
}

interface PendingLogin {
  brand: string;
  redirectUri: string;
  at: number;
}

export interface LoginResult {
  brand: string;
  page?: string;
  instagram?: string;
  /** Several Pages and none named yet: the person picks one. */
  choose?: { id: string; pages: Array<{ id: string; name: string; instagram?: string }> };
}

const TEN_MINUTES = 10 * 60_000;

export class Accounts {
  private readonly logins = new Map<string, PendingLogin>();
  private readonly choices = new Map<string, { brand: string; pages: ManagedPage[]; at: number }>();

  constructor(readonly opts: AccountsOptions) {}

  get env(): Record<string, string | undefined> {
    return process.env;
  }

  brands(): Brand[] {
    return loadBrands(this.opts.brandsFile ?? BRANDS_FILE);
  }

  settings() {
    return SETTINGS.map((s) => ({ ...s, set: Boolean(this.env[s.name]) }));
  }

  /** Writes to .env, keeping other lines, and to this process. Empty values are ignored. */
  saveEnv(values: Record<string, string>): void {
    const file = this.opts.envFile;
    const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    for (const [name, raw] of Object.entries(values)) {
      const value = raw.trim();
      if (!/^[A-Z0-9_]+$/.test(name) || /[\r\n]/.test(value)) throw new Error(`Bad setting ${name}`);
      const at = lines.findIndex((l) => l.startsWith(`${name}=`));
      if (at === -1) lines.push(`${name}=${value}`);
      else lines[at] = `${name}=${value}`;
      process.env[name] = value;
    }
    writeFileSync(file, `${lines.join("\n").trimEnd()}\n`, "utf8");
  }

  saveSettings(form: URLSearchParams): number {
    const values: Record<string, string> = {};
    for (const s of SETTINGS) {
      const v = form.get(s.name)?.trim();
      if (v) values[s.name] = v;
    }
    if (Object.keys(values).length) this.saveEnv(values);
    return Object.keys(values).length;
  }

  private client(token?: string, baseUrl?: string): GraphClient {
    return new GraphClient({ token, baseUrl, version: this.opts.graphVersion || DEFAULT_GRAPH_VERSION, fetch: this.opts.fetch, backoffMs: this.opts.fetch ? 1 : undefined });
  }

  private clientFor = (token: string, platform: Platform) => (platform === "threads" ? this.client(token, THREADS_BASE_URL) : this.client(token));

  private need(name: SettingName, what: string): string {
    const v = this.env[name];
    if (!v) throw new NeedsSetup(t(what));
    return v;
  }

  // ── Facebook and Instagram ────────────────────────────────────────────

  /** The Facebook Login dialog for one brand. Meta sends the person back to redirectUri. */
  startLogin(brandId: string, redirectUri: string): string {
    findBrand(this.brands(), brandId);
    const appId = this.need("META_APP_ID", "Cần Mã ứng dụng Meta và Khoá bí mật trước khi kết nối Facebook.");
    this.need("META_APP_SECRET", "Cần Mã ứng dụng Meta và Khoá bí mật trước khi kết nối Facebook.");
    const state = randomBytes(16).toString("hex");
    this.logins.set(state, { brand: brandId, redirectUri, at: Date.now() });
    return loginDialogUrl({
      appId,
      redirectUri,
      state,
      version: this.opts.graphVersion || DEFAULT_GRAPH_VERSION,
      configId: this.env.META_LOGIN_CONFIG_ID || undefined,
      scopes: this.env.META_LOGIN_SCOPES ? this.env.META_LOGIN_SCOPES.split(",").map((s) => s.trim()) : undefined,
    });
  }

  /** Brand a login state belongs to, so an error can send the person back there. */
  loginBrand(state: string): string | undefined {
    return this.logins.get(state)?.brand;
  }

  async finishLogin(state: string, code: string): Promise<LoginResult> {
    const login = this.logins.get(state);
    this.logins.delete(state);
    if (!login || Date.now() - login.at > TEN_MINUTES) throw new Error(t("Phiên đăng nhập đã hết hạn. Bấm Kết nối lại."));
    const appId = this.need("META_APP_ID", "Thiếu Mã ứng dụng Meta.");
    const secret = this.need("META_APP_SECRET", "Thiếu Khoá bí mật ứng dụng.");
    const short = await exchangeCodeForUserToken(this.client(), appId, secret, login.redirectUri, code);
    const { accessToken } = await exchangeLongLivedUserToken(this.client(), appId, secret, short);
    const brand = findBrand(this.brands(), login.brand);
    const fb = brand.channels.find((c) => c.platform === "facebook")?.env;
    const wanted = fb?.pageId ? this.env[fb.pageId] : undefined;
    const pages = await listManagedPages(this.client(accessToken), { pageId: wanted });
    if (!pages.length) throw new Error(t("Tài khoản này chưa quản lý Trang nào. Khi đăng nhập, hãy chọn cho phép Trang (và Instagram đi kèm)."));
    const page = wanted ? pages.find((p) => p.id === wanted) : pages.length === 1 ? pages[0] : undefined;
    if (page) return this.savePage(brand, page);
    const id = randomBytes(8).toString("hex");
    this.choices.set(id, { brand: brand.id, pages, at: Date.now() });
    return { brand: brand.id, choose: { id, pages: pages.map((p) => ({ id: p.id, name: p.name, instagram: p.instagram?.username })) } };
  }

  choosePage(choiceId: string, pageId: string): LoginResult {
    const c = this.choices.get(choiceId);
    if (!c || Date.now() - c.at > TEN_MINUTES) throw new Error(t("Phiên chọn Trang đã hết hạn. Bấm Kết nối lại."));
    const page = c.pages.find((p) => p.id === pageId);
    if (!page) throw new Error(t("Không thấy Trang này."));
    this.choices.delete(choiceId);
    return this.savePage(findBrand(this.brands(), c.brand), page);
  }

  private savePage(brand: Brand, page: ManagedPage): LoginResult {
    const fb = brand.channels.find((c) => c.platform === "facebook")?.env;
    const ig = brand.channels.find((c) => c.platform === "instagram")?.env;
    if (!fb?.pageId || !fb.token) throw new Error(t("{name} chưa có kênh Facebook.", { name: brand.name }));
    this.saveEnv({ [fb.pageId]: page.id, [fb.token]: page.accessToken, ...(ig?.userId ? { [ig.userId]: page.instagram?.id ?? "" } : {}) });
    return { brand: brand.id, page: page.name, instagram: page.instagram?.username ?? page.instagram?.id };
  }

  // ── Threads ───────────────────────────────────────────────────────────

  /** A token from Meta's User Token Generator, stretched to 60 days when possible. */
  async connectThreads(brandId: string, token: string): Promise<string> {
    const brand = findBrand(this.brands(), brandId);
    const names = brand.channels.find((c) => c.platform === "threads")?.env;
    if (!names?.token || !names.userId || !names.username) throw new Error(t("{name} chưa có kênh Threads.", { name: brand.name }));
    const short = token.trim();
    if (!/^\S{20,}$/.test(short)) throw new Error(t("Mã này không giống mã Threads. Bấm Sao chép cạnh mã trong trang tạo mã rồi dán lại."));
    let long: { accessToken: string; expiresIn?: number } = { accessToken: short };
    const secret = this.env.THREADS_APP_SECRET;
    if (secret) {
      try {
        long = await exchangeThreadsLongLived(this.client(undefined, THREADS_BASE_URL), secret, short);
      } catch (e) {
        // Tokens from the generator are already long-lived and cannot be exchanged again.
        if (!(e instanceof GraphError) || (e.kind !== "token" && e.kind !== "invalid")) throw e;
      }
    }
    const profile = await threadsProfile(this.client(long.accessToken, THREADS_BASE_URL));
    const until = new Date(Date.now() + (long.expiresIn ?? 60 * 86_400) * 1000).toISOString();
    this.saveEnv({ [names.userId]: profile.id, [names.username]: profile.username, [names.token]: long.accessToken, [`${names.token}_EXPIRES`]: until });
    return profile.username;
  }

  // ── Listening ─────────────────────────────────────────────────────────

  /** New comments on every published post. Returns how many were new. */
  async pullComments(): Promise<number> {
    const brands = this.brands();
    const fetched: Comment[] = [];
    for (const post of await new FileJournal(journalPath(this.opts.dataDir)).published()) {
      const brand = brands.find((b) => b.id === (post.brand ?? MAIN_BRAND));
      const tg = brand && brandTargets(brand, this.env, this.clientFor, { includePaused: true }).targets;
      if (!tg) continue;
      if (post.platform === "facebook") fetched.push(...(await fetchFacebookComments(tg.page, tg.pageId, post.postId)));
      else if (post.platform === "instagram" && tg.igUserId) fetched.push(...(await fetchInstagramComments(tg.page, tg.igUserId, post.postId)));
      else if (post.platform === "threads" && tg.threads) {
        const username = this.env[brand!.channels.find((c) => c.platform === "threads")?.env.username ?? ""];
        if (username) fetched.push(...(await fetchThreadsReplies(tg.threads.client, username, post.postId)));
      }
    }
    const { all, added } = mergeComments(await loadComments(this.opts.dataDir), fetched);
    await saveComments(this.opts.dataDir, all);
    return added.length;
  }

  /** Messenger and Instagram conversations of every brand with a Page. */
  async pullInbox(): Promise<number> {
    const fetched: Conversation[] = [];
    for (const brand of this.brands()) {
      const tg = brandTargets(brand, this.env, this.clientFor, { includePaused: true }).targets;
      if (!tg) continue;
      const own = tg.igUserId ? [tg.pageId, tg.igUserId] : [tg.pageId];
      const found = await fetchConversations(tg.page, tg.pageId, "facebook", own);
      if (tg.igUserId) found.push(...(await fetchConversations(tg.page, tg.pageId, "instagram", own)));
      fetched.push(...(brand.id === MAIN_BRAND ? found : found.map((c) => ({ ...c, brand: brand.id }))));
    }
    const { all, newMessages } = mergeConversations(await loadInbox(this.opts.dataDir), fetched);
    await saveInbox(this.opts.dataDir, all);
    return newMessages;
  }

  /** Whether any brand has a Page connected, so pulling can work at all. */
  /** Latest image posts of a public Instagram business or creator account, through any connected Instagram. */
  async discoverInstagram(handle: string): Promise<Array<{ image: string; link: string; caption?: string; account: string }>> {
    const tg = this.brands()
      .map((b) => {
        try {
          return brandTargets(b, this.env, this.clientFor, { includePaused: true }).targets;
        } catch {
          return undefined;
        }
      })
      .find((x) => x?.igUserId);
    if (!tg) throw new NeedsSetup(t("Cần kết nối Instagram của một kênh trước."), "/channels/hoi-sau");
    type Media = { media_type: string; media_url?: string; thumbnail_url?: string; permalink: string; caption?: string; children?: { data: Array<{ media_type: string; media_url?: string }> } };
    let found: { business_discovery?: { username: string; media?: { data: Media[] } } };
    try {
      found = await tg.page.get(tg.igUserId!, {
        fields: `business_discovery.username(${handle}){username,media.limit(12){media_type,media_url,thumbnail_url,permalink,caption,children{media_type,media_url}}}`,
      });
    } catch {
      throw new Error(t("Không đọc được @{handle}. Chỉ đọc được kênh doanh nghiệp hoặc nhà sáng tạo công khai.", { handle }));
    }
    const bd = found.business_discovery;
    return (bd?.media?.data ?? []).flatMap((m) => {
      const image = m.media_type === "IMAGE" ? m.media_url : m.media_type === "CAROUSEL_ALBUM" ? m.children?.data.find((c) => c.media_type === "IMAGE")?.media_url : m.thumbnail_url;
      return image ? [{ image, link: m.permalink, caption: m.caption, account: bd!.username }] : [];
    });
  }

  anyPage(): boolean {
    try {
      return this.brands().some((b) => brandTargets(b, this.env, this.clientFor, { includePaused: true }).targets);
    } catch {
      return false;
    }
  }

  async send(c: Conversation, text: string): Promise<InboxMessage> {
    const brand = findBrand(this.brands(), c.brand ?? MAIN_BRAND);
    const tg = brandTargets(brand, this.env, this.clientFor, { includePaused: true }).targets;
    if (!tg) throw new NeedsSetup(t("{name} chưa kết nối Facebook.", { name: brand.name }), `/channels/${brand.id}`);
    return sendReply(tg.page, tg.pageId, c, text);
  }

  // ── channels.yaml ─────────────────────────────────────────────────────

  /** Live, paused or planned, written into channels.yaml with its comments kept. */
  setStatus(brandId: string, platform: Platform, status: ChannelStatus): void {
    if (!["live", "paused", "planned"].includes(status)) throw new Error("Bad status");
    const file = this.opts.brandsFile ?? BRANDS_FILE;
    const doc = parseDocument(readFileSync(file, "utf8"));
    const brands = this.brands();
    const b = brands.findIndex((x) => x.id === brandId);
    const c = b === -1 ? -1 : brands[b].channels.findIndex((x) => x.platform === platform);
    if (c === -1) throw new Error(t("Không thấy kênh này."));
    doc.setIn(["brands", b, "channels", c, "status"], status);
    writeFileSync(file, doc.toString({ lineWidth: 0 }));
  }
}
