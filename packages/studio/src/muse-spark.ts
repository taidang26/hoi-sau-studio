/**
 * Muse Spark over the Meta Model API chat completions endpoint (OpenAI
 * compatible). Every Studio writing step asks for JSON constrained by a
 * schema, so a step's output loads as a known shape and is saved as is.
 * Reference: meta-models/meta-model-cookbook, 01_api_fundamentals/04.
 */

import { DEFAULT_BASE_URL, MuseImageError, type Transport } from "./muse-image.js";

/**
 * Contributor mode: same Muse Spark 1.3, about 95% cheaper per token, and Meta
 * may train on the prompts. MUSE_SPARK_MODEL=muse-spark-1.3 switches back to
 * Standard mode. If the account cannot use Contributor (403/404, e.g. region),
 * calls fall back to MUSE_SPARK_FALLBACK_MODEL (default Standard; "none" = off).
 */
export const MUSE_SPARK_MODEL = "muse-spark-1.3-contributor";
export const MUSE_SPARK_STANDARD_MODEL = "muse-spark-1.3";

/** Wait before retry `attempt`: Retry-After when the API sends it, else exponential backoff; capped at 60 s. */
export function retryDelayMs(attempt: number, retryAfter?: string | null): number {
  const secs = retryAfter ? Number(retryAfter) : NaN;
  const fromHeader = Number.isFinite(secs) && secs >= 0 ? secs * 1000 : 0;
  const backoff = 1000 * 2 ** attempt + Math.random() * 250;
  return Math.min(60_000, Math.max(fromHeader, backoff));
}

export type JsonSchema = Record<string, unknown>;

export type ChatContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: ChatContent;
}

export interface MuseSparkOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  transport?: Transport;
  /** Retries for 5xx. */
  retries?: number;
  /** Retries for 429 (token rate limit): Contributor mode has tighter limits. */
  rateLimitRetries?: number;
  /** Model used once if `model` is refused with 403/404. Empty = no fallback. */
  fallbackModel?: string;
  sleep?: (ms: number) => Promise<void>;
}

export class MuseSpark {
  private readonly baseUrl: string;
  model: string;
  private readonly transport: Transport;
  private readonly retries: number;
  private readonly rateLimitRetries: number;
  private fallbackModel: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: MuseSparkOptions) {
    if (!opts.apiKey) throw new MuseImageError("Missing API key: set META_API_KEY (or MODEL_API_KEY) in .env");
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.model = opts.model ?? MUSE_SPARK_MODEL;
    this.transport = opts.transport ?? ((url, init) => fetch(url, init));
    this.retries = opts.retries ?? 3;
    this.rateLimitRetries = opts.rateLimitRetries ?? 6;
    this.fallbackModel = opts.fallbackModel ?? "";
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, transport?: Transport): MuseSpark {
    return new MuseSpark({
      apiKey: env.META_API_KEY || env.MODEL_API_KEY || "",
      baseUrl: env.META_API_BASE_URL || undefined,
      model: env.MUSE_SPARK_MODEL || undefined,
      fallbackModel: env.MUSE_SPARK_FALLBACK_MODEL === "none" ? "" : env.MUSE_SPARK_FALLBACK_MODEL || MUSE_SPARK_STANDARD_MODEL,
      transport,
    });
  }

  /** One structured call: returns the parsed JSON object that matches `schema`. */
  async json<T>(name: string, schema: JsonSchema, messages: ChatMessage[]): Promise<T> {
    const bodyFor = (model: string) =>
      JSON.stringify({
        model,
        messages,
        response_format: { type: "json_schema", json_schema: { name, schema, strict: true } },
      });
    let body = bodyFor(this.model);
    for (let server = 0, limited = 0; ; ) {
      const res = await this.transport(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
        body,
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (res.status >= 200 && res.status < 300) {
        const content = json?.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new MuseImageError("Muse Spark returned no content");
        try {
          return JSON.parse(content) as T;
        } catch {
          throw new MuseImageError(`Muse Spark returned invalid JSON for ${name}`);
        }
      }
      const message = json?.error?.message ?? "request failed";
      if ((res.status === 403 || res.status === 404) && this.fallbackModel && this.fallbackModel !== this.model) {
        console.warn(`Muse Spark: ${this.model} refused (${res.status}: ${message}); using ${this.fallbackModel}`);
        this.model = this.fallbackModel;
        this.fallbackModel = "";
        body = bodyFor(this.model);
        server = limited = 0;
        continue;
      }
      if (res.status === 429 && limited < this.rateLimitRetries) {
        await this.sleep(retryDelayMs(limited++, res.headers?.get("retry-after")));
        continue;
      }
      if (!(res.status >= 500) || server >= this.retries) {
        throw new MuseImageError(`Muse Spark ${this.model} ${res.status}: ${message}`, res.status);
      }
      await this.sleep(retryDelayMs(server++));
    }
  }
}

/** Helpers for strict schemas: every property required, nothing extra. */
export const S = {
  str: (description?: string): JsonSchema => ({ type: "string", ...(description ? { description } : {}) }),
  num: (description?: string): JsonSchema => ({ type: "number", ...(description ? { description } : {}) }),
  int: (description?: string): JsonSchema => ({ type: "integer", ...(description ? { description } : {}) }),
  bool: (): JsonSchema => ({ type: "boolean" }),
  enum: (values: string[], description?: string): JsonSchema => ({ type: "string", enum: values, ...(description ? { description } : {}) }),
  arr: (items: JsonSchema, minItems = 0, maxItems?: number): JsonSchema => ({ type: "array", items, minItems, ...(maxItems ? { maxItems } : {}) }),
  obj: (properties: Record<string, JsonSchema>): JsonSchema => ({
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }),
};
