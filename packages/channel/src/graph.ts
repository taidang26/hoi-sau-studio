/**
 * Graph API transport shared by Facebook, Instagram and Threads.
 *
 * - The access token rides in the Authorization header so it never shows up
 *   in a URL or a log line.
 * - Every failure becomes a GraphError with a `kind`, so callers can react to
 *   "token dead" differently from "not allowed" or "try again later".
 * - Only "transient" and "rate_limit" failures are retried, with backoff.
 */

export const DEFAULT_GRAPH_VERSION = "v24.0";
export const THREADS_BASE_URL = "https://graph.threads.net/v1.0";

export type GraphErrorKind = "token" | "permission" | "rate_limit" | "transient" | "invalid";

export class GraphError extends Error {
  override name = "GraphError";

  constructor(
    message: string,
    readonly kind: GraphErrorKind,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.kind === "transient" || this.kind === "rate_limit";
  }
}

/** The `error` object Meta returns in a failed response body. */
export interface MetaErrorBody {
  message?: string;
  code?: number;
  error_subcode?: number;
  is_transient?: boolean;
}

const between = (n: number, lo: number, hi: number) => n >= lo && n <= hi;

/**
 * Checked in order; the first match wins. Codes from Meta's Graph API error
 * reference: 190/102 and the 46x subcodes are session problems, 4/17/32/613
 * and 80001–80014 are throttling, 10 and 2xx are permission or policy.
 */
const RULES: [GraphErrorKind, (status: number, code: number, sub: number, e: MetaErrorBody) => boolean][] = [
  ["token", (_s, code, sub) => code === 190 || code === 102 || [458, 459, 460, 463, 464, 467].includes(sub)],
  ["rate_limit", (_s, code) => [4, 17, 32, 613].includes(code) || between(code, 80001, 80014)],
  ["permission", (_s, code) => code === 10 || between(code, 200, 299)],
  ["transient", (status, code, _sub, e) => e.is_transient === true || code === 1 || code === 2 || status >= 500],
];

export function classify(status: number, err: MetaErrorBody): GraphErrorKind {
  const code = err.code ?? 0;
  const sub = err.error_subcode ?? 0;
  return RULES.find(([, test]) => test(status, code, sub, err))?.[0] ?? "invalid";
}

const toError = (status: number, err: MetaErrorBody, fallback: string) =>
  new GraphError(err.message ?? fallback, classify(status, err), status, err.code, err.error_subcode);

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GraphClientOptions {
  token?: string;
  /** Graph API version for graph.facebook.com; ignored when `baseUrl` is set. */
  version?: string;
  /** Full API root, e.g. THREADS_BASE_URL. */
  baseUrl?: string;
  fetch?: FetchLike;
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number;
  /** First backoff delay in ms; doubles on each retry. Default 1000. */
  backoffMs?: number;
  /** Receives X-App-Usage and X-Business-Use-Case-Usage headers. */
  onUsage?: (header: string, value: string) => void;
}

export type Params = Record<string, string | number | boolean | undefined>;

const USAGE_HEADERS = ["x-app-usage", "x-business-use-case-usage"];

interface Page<T> {
  data: T[];
  paging?: { next?: string; cursors?: { after?: string } };
}

export class GraphClient {
  readonly root: string;
  private readonly send: FetchLike;

  constructor(private readonly options: GraphClientOptions = {}) {
    this.root = (options.baseUrl ?? `https://graph.facebook.com/${options.version ?? DEFAULT_GRAPH_VERSION}`).replace(/\/$/, "");
    this.send = options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** Same settings, different token. */
  withToken(token: string): GraphClient {
    return new GraphClient({ ...this.options, token });
  }

  get<T>(path: string, params: Params = {}): Promise<T> {
    return this.call<T>("GET", path, params);
  }

  post<T>(path: string, params: Params = {}): Promise<T> {
    return this.call<T>("POST", path, params);
  }

  /** Reads a paged edge until it runs out or `max` items are collected. */
  async getAll<T>(path: string, params: Params = {}, max = 1000): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.get<Page<T>>(path, { ...params, after: cursor });
      items.push(...page.data);
      cursor = page.paging?.next ? page.paging.cursors?.after : undefined;
      if (!cursor || items.length >= max) return items.slice(0, max);
    }
  }

  /**
   * Hosted-file upload for Facebook Reels: Meta downloads `fileUrl` itself.
   * This endpoint lives on rupload.facebook.com and authenticates with "OAuth".
   */
  async ruploadFromUrl(videoId: string, fileUrl: string): Promise<void> {
    const version = this.root.slice(this.root.lastIndexOf("/") + 1);
    const res = await this.send(`https://rupload.facebook.com/video-upload/${version}/${videoId}`, {
      method: "POST",
      headers: { Authorization: `OAuth ${this.options.token ?? ""}`, file_url: fileUrl },
    });
    if (res.ok) return;
    const body = (await res.json().catch(() => ({}))) as { error?: MetaErrorBody; debug_info?: { message?: string } };
    throw toError(res.status, body.error ?? { message: body.debug_info?.message }, `Upload failed: HTTP ${res.status}`);
  }

  private async call<T>(method: "GET" | "POST", path: string, params: Params): Promise<T> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) form.append(key, String(value));
    }
    const encoded = form.toString();
    const query = method === "GET" && encoded ? `?${encoded}` : "";
    const url = `${this.root}/${path.replace(/^\/+/, "")}${query}`;
    const init: RequestInit = {
      method,
      headers: this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {},
      body: method === "POST" ? form : undefined,
    };
    return this.withRetry(() => this.once<T>(url, init));
  }

  private async once<T>(url: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await this.send(url, init);
    } catch (e) {
      throw new GraphError(`Network error: ${(e as Error).message}`, "transient", 0);
    }
    for (const name of USAGE_HEADERS) {
      const value = res.headers.get(name);
      if (value) this.options.onUsage?.(name, value);
    }
    const body = (await res.json().catch(() => ({}))) as T & { error?: MetaErrorBody };
    if (!res.ok || body.error) throw toError(res.status, body.error ?? {}, `HTTP ${res.status}`);
    return body;
  }

  private async withRetry<T>(attempt: () => Promise<T>): Promise<T> {
    const retries = this.options.maxRetries ?? 3;
    const base = this.options.backoffMs ?? 1000;
    for (let i = 0; ; i++) {
      try {
        return await attempt();
      } catch (e) {
        if (!(e instanceof GraphError) || !e.retryable || i >= retries) throw e;
        await sleep(base * 2 ** i);
      }
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
